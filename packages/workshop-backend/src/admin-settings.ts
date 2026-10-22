import { ADMIN_ACCESS_ERROR_CODES, AdminApi, AdminAuditPage, AdminAuditQuery, AdminAuditStats, AdminAuditStatsQuery, AdminFormat, AdminFormatPatch, AdminInspectOptions, AdminModel, AdminResourceVendor, AdminSettingChange, AdminSettingMethod, AdminSettingsView, AdminUserPage, AdminUserQuery, AdminVia, AdminWorkspaceAccess, AdminWorkspacePage, AdminWorkspaceQuery, AdminWorkspaceView, AiModelConfig, AiModelProvider, AmbientGatekeeperMode, BannerColor, BlueprintPublicInfo, DeploymentUpdateStatus, GatewayModel, GatewayModelLevelTest, GatewayModelMode, GatewayModelSettings, GatewayModelTest, MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_ADMIN_AUDIT_RETENTION_DAYS, MAX_ANNOUNCEMENT_LENGTH, MAX_INSTANCE_INSTRUCTIONS_LENGTH, MAX_SITE_NAME_LENGTH, MAX_UPDATE_CHECK_INTERVAL_MINUTES, MAX_UPDATE_HOURS, ReasoningLevel, SUGGESTED_MODELS, createAdminAccessError, getAdminAccessErrorCode, isAdminWorkspaceAccess, isAmbientGatekeeperMode, isBannerColor, isHexColor } from '@gadgets/workshop-shared/api';
import { GatekeeperVendor } from '@gadgets/workshop-shared/gatekeeper';
import { DurableObject } from 'cloudflare:workers';
import { RpcTarget, type RpcStub } from 'capnweb';
import { validateRpc } from 'capnweb-validate';
import { createWorkshopLogger } from "./observability";
import { sanitizeBlueprintOutput } from './blueprint-archive.js';
import { ADMIN_CONFIG_KEY, FEATURED_BLUEPRINTS_KEY, isReservedBlueprintKey, parseBlueprintKvRecord, readBlueprintKvRecord, serializeFeaturedBlueprints } from './storage-schema/blueprints-kv.js';
import { MAX_AGENT_HINT, defaultOutputFormatId, diffAdminConfig, isUpdateCheckInterval, isUpdateHours, listPromotedFormats, normalizeAdminConfig, reorderFormats, sanitizeAddedModel, sanitizeModelSettings, sanitizeOutputOverrides, serializeAdminConfig } from './admin-config.js';
import { makeAdminSettingsStorage, type AdminConfig, type AdminSettingsStorage, type FormatCuration } from './storage-schema/admin-settings-storage.js';
import { getModelTokenLimits } from './agent-compaction.js';
import { AiGatewayConfig, GatewayModels, assertGatewayProvider, gatewayModelConfig, gatewayRunConfig, getAiGatewayConfig, isCatalogModel } from './ai-gateway.js';
import { AgentTurnError, completeText } from './ai-invoke.js';
import { gatewayBuiltInReasoning, gatewayReasoningLevels, getModel, isRuntimeModel } from './ai-models.js';
import { SITE_LOGO_R2_KEY, siteLogoImage, validateSiteLogo } from './site-logo.js';
import { ambientGatekeeperMode, DEFAULT_AMBIENT_GATEKEEPER_MODE } from './provisioning-policy.js';
import { buildGatekeeperVendorMap } from './auth/auth-vendors.js';
import { UserDurableObject } from './user.js';
import type { UserDirectoryDurableObject } from './user-directory.js';
import type { AdminAuditDurableObject } from './admin-audit.js';
import type { OverseerDurableObject } from './overseer.js';
import { type AdminSettingActor, type AdminViewTerms, adminAccessPolicy, adminAuditStatsDays, adminListLimit, adminSettingChange, adminViewLifetimeMs, cutAdminAuditText, deploymentAdmins, isDeploymentAdmin, lowerAdminWorkspaceAccess, maxAdminWorkspaceAccess, minAdminAuditRetentionDays, validateAdminAccessReason } from './admin-access.js';
import { bundledBlueprintsManifestVersion, installBundledBlueprints } from './bundled-blueprints.js';
import { BUNDLED_BLUEPRINTS } from './generated/bundled-blueprints.js';
import { type DeployServiceInstall, NO_ANSWER, type VersionAnswer, deployServiceInstall, deploymentUpdateStatus, fetchLatestRelease, updateCheckDue } from './deployment-updates.js';

const logger = createWorkshopLogger("workshop.admin.settings");

// How long a gatekeeper has to report its version tag (Workers RPC has no timeout of its own), and
// how long a gatekeeper's answer is served before it is asked again.
const VERSION_TAG_TIMEOUT_MS = 2_000;
const VERSION_TAGS_TTL_MS = 60_000;

// The entries of a record keyed by model ID (a model's mode, or its settings) other than
// `modelId`'s. Callers rebuild the record with Object.fromEntries, which defines own properties:
// assigning into a copy would lose the entry of a model whose ID is "__proto__".
function entriesWithout<T>(record: Record<string, T>, modelId: string): [string, T][] {
  return Object.entries(record).filter(([id]) => id !== modelId);
}

// The compaction budget a gateway model has while its settings give none, and the largest one
// they may give it: the room its window leaves for a prompt.
function compactionBudgetRange(model: AdminModel): { builtIn: number, max: number } {
  let config = gatewayModelConfig(model);
  return {
    builtIn: getModelTokenLimits(config).inputBudget,
    // A budget is capped at that room, so an unbounded one reads it back.
    max: getModelTokenLimits({ ...config, compactionInputBudget: Infinity }).inputBudget,
  };
}

// The model that `model`, a description of one, becomes once added: enabled, with nothing set
// for it.
function addedModel(model: GatewayModel): AdminModel {
  return { ...model, mode: "enabled", defaultMode: "enabled", added: true };
}

// `hours`, if an admin may set the update notice's `setting` to it.
function updateHours(setting: string, hours: number): number {
  if (!isUpdateHours(hours)) {
    throw new Error(`The ${setting} must be a whole number of hours from 0 to ${MAX_UPDATE_HOURS}.`);
  }
  return hours;
}

// One of the tests an admin runs through the gateway: the event and the message of its log line,
// the response cap of its request (the model's own, where that is lower), whether the request
// asks for what an agent's turn would (see completeText), and how long the model has to answer.
type GatewayTest = {
  event: string, logged: string, maxTokens: number, thinking: boolean, timeoutMs: number,
};
const PROVIDER_TEST: GatewayTest = {
  event: "gateway.provider.test", logged: "tested an AI Gateway provider",
  maxTokens: 16, thinking: false, timeoutMs: 15_000,
};
const MODEL_TEST: GatewayTest = {
  event: "gateway.model.test", logged: "tested an AI Gateway model",
  maxTokens: 2048, thinking: true, timeoutMs: 30_000,
};

// What a failed test tells the admin: the provider's or the gateway's own words with the
// deployment's gateway token cut out, should they repeat it, on one line and cut short.
function testFailureMessage(text: string, apiToken: string | undefined): string {
  if (apiToken) text = text.replaceAll(apiToken, "[redacted]");
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Deployment-wide admin settings singleton.
 *
 * This durable object is always addressed as `getByName("")`. It contains settings that only
 * admins may modify. Settings modified through this DO are published to KV so that user requests
 * do not have to access the AdminSettings DO directly (which they could otherwise overload), but
 * having a singleton DO writing to KV avoids race conditions when updating KV.
 */
export class AdminSettings extends DurableObject<Cloudflare.Env> {
  private storage: AdminSettingsStorage;
  private users: DurableObjectNamespace<UserDurableObject>;
  // The deployment-wide admin audit log, where every admin's change is recorded before it is made.
  private audits: DurableObjectNamespace<AdminAuditDurableObject>;
  // Every bound gatekeeper, keyed by vendor id. Deployment-global (from env bindings), so admin
  // resource listing needs no user context.
  private vendors: Map<string, Service<GatekeeperVendor>>;
  // Every config setter writes the same authoritative singleton and KV mirror. Serialize the full
  // read/modify/write operation so external KV I/O cannot let concurrent setters lose updates.
  private adminConfigMutationTail = Promise.resolve();
  // R2 and config are separate stores. Serialize logo changes so reset/upload operations cannot
  // interleave while switching whether the fixed public object is enabled.
  private siteLogoMutationTail = Promise.resolve();
  // Featuring reads the owner DO's bit to decide what to record, then writes it. Serialize the
  // read/record/write so a concurrent call can never act on a bit another has since changed, which
  // would make its change unrecorded.
  private featuredMutationTail = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.storage = makeAdminSettingsStorage(ctx.storage);
    this.users = this.ctx.exports.UserDurableObject;
    this.audits = this.ctx.exports.AdminAuditDurableObject;
    this.vendors = buildGatekeeperVendorMap(env);
  }

  /**
   * Install the bundled blueprints bundled with this deployment, if that hasn't already happened
   * for this exact manifest. Idempotent and cheap: an up-to-date deployment does one string
   * comparison and returns.
   *
   * Written straight into the featured mirror rather than through setBlueprintFeatured(), whose
   * authoritative bit lives in the publishing user's DO -- these have no owning user.
   *
   * Callers are coalesced onto one run, or two isolates racing on a fresh deployment both promote
   * the same blueprints, and a duplicated id makes setFormatOrder() reject every reordering.
   */
  ensureBundledBlueprintsInstalled(): Promise<boolean> {
    return this.#installInFlight ??= this.#installBundledBlueprints()
        .finally(() => { this.#installInFlight = undefined; });
  }

  #installInFlight?: Promise<boolean>;

  // Resolves true once every bundled blueprint is live. A partial install resolves false rather
  // than throwing: the caller has nothing to handle, but it does need to know to ask again.
  async #installBundledBlueprints(): Promise<boolean> {
    let complete = true;
    let manifestVersion = bundledBlueprintsManifestVersion();
    if (this.storage.installedFormatBlueprints.get() !== manifestVersion) {
      let installed = await installBundledBlueprints(this.env);

      if (installed.length > 0) {
        for (let publicInfo of installed) {
          this.storage.featuredBlueprints.put(publicInfo);
        }
        await this.#writeFeaturedSnapshot();
      }

      // Stamped only once the whole manifest is live, so a crash or a single bad archive retries
      // next time. Recording a partial install as complete would strand the entries that failed
      // until the manifest happened to change again.
      complete = installed.length === BUNDLED_BLUEPRINTS.length;
      if (complete) {
        this.storage.installedFormatBlueprints.put(manifestVersion);
      }
      logger.info("installed bundled blueprints", {
        event: "formats.install.complete",
        size: installed.length,
        failureCount: BUNDLED_BLUEPRINTS.length - installed.length,
      });
    }

    // Promotion is checked on every run, not just after an install, so a deployment that installed
    // before curation existed still ends up offering its bundled formats.
    await this.#promoteBundledFormats();
    return complete;
  }

  // Offer each bundled blueprint as a standard format, once ever. A separate one-shot decision per
  // blueprint: re-deriving the list from the manifest would undo an admin's removal on every
  // startup, and reinstalling an updated archive must refresh the blueprint without resetting how
  // the deployment has chosen to offer it.
  //
  // The converse isn't handled: a blueprint dropped from the bundle, or given a new blueprintId,
  // leaves its record and its promotion behind for an admin to remove by hand. Withdrawing them
  // would mean tracking which promotions this installer made, which is worth doing before the
  // bundled set ever changes.
  async #promoteBundledFormats(): Promise<void> {
    let promoted = new Set(this.storage.promotedFormatBlueprints.get());
    let pending = BUNDLED_BLUEPRINTS.filter(entry => !promoted.has(entry.blueprintId));
    if (pending.length === 0) return;

    let config = this.#config();
    let known = new Set(config.formats.map(f => f.blueprintId));
    let added = pending
        .filter(entry => !known.has(entry.blueprintId))
        .map(entry => ({blueprintId: entry.blueprintId, enabled: true}));
    // Always write, even when every pending format is already in DO storage. That is the retry
    // state after a prior KV mirror failure; stamping promotion without writing would strand the
    // hot-path mirror on its old config forever. Offering the formats its release bundles is the
    // deployment's own write, not an admin's, so it is not recorded.
    await this.#mutateAdminConfig(null,
        current => ({...current, formats: [...config.formats, ...added]}));

    for (let entry of pending) promoted.add(entry.blueprintId);
    this.storage.promotedFormatBlueprints.put([...promoted]);
  }

  async #writeFeaturedSnapshot(): Promise<void> {
    let featured = [...this.storage.featuredBlueprints.list()];
    await this.env.BLUEPRINTS.put(FEATURED_BLUEPRINTS_KEY, serializeFeaturedBlueprints(featured));
  }

  // Reconcile the mirrored featured list to match the authoritative bit stored in the owner
  // User DO, while also refreshing stale metadata snapshots for featured entries.
  async #syncFeaturedMirror(publicInfo: BlueprintPublicInfo, featured: boolean): Promise<void> {
    let existing = this.storage.featuredBlueprints.get(publicInfo.id);
    let changed = false;

    if (!featured) {
      if (existing) {
        this.storage.featuredBlueprints.delete(publicInfo.id);
        changed = true;
      }
    } else if (
      !existing ||
      existing.metadata.version !== publicInfo.metadata.version ||
      existing.metadata.lastUpdated.valueOf() !== publicInfo.metadata.lastUpdated.valueOf()
    ) {
      this.storage.featuredBlueprints.put(publicInfo);
      changed = true;
    }

    if (changed) {
      await this.#writeFeaturedSnapshot();
    }
  }

  async #getOwnerBlueprint(blueprintId: string): Promise<{
    // Absent for a blueprint with no owning user, in which case `featureable` is false.
    owner: DurableObjectStub<UserDurableObject> | undefined;
    publicInfo: BlueprintPublicInfo;
    featureable: boolean;
  }> {
    if (isReservedBlueprintKey(blueprintId)) {
      throw new Error('Blueprint not found.');
    }

    let raw = await this.env.BLUEPRINTS.get(blueprintId);
    if (!raw) {
      throw new Error('Blueprint not found.');
    }

    let kvRecord = parseBlueprintKvRecord(raw);

    return {
      owner: kvRecord.ownerId
          ? this.users.get(this.users.idFromString(kvRecord.ownerId))
          : undefined,
      publicInfo: {
        id: blueprintId,
        metadata: kvRecord.metadata,
      },
      // A deployment-installed blueprint (see bundled-blueprints.ts) has no owning User DO to hold
      // the authoritative featured bit, so the owner-anchored toggle doesn't apply -- the same
      // answer as an uploaded blueprint. It reaches users through the deployment's curation.
      featureable: !!kvRecord.gadgetId && !!kvRecord.ownerId,
    };
  }

  async isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    let { owner, publicInfo, featureable } = await this.#getOwnerBlueprint(blueprintId);
    if (!featureable || !owner) {
      return null;
    }

    let featured = await owner.isBlueprintFeatured(blueprintId);
    if (featured === null) {
      return null;
    }

    // Heal partial failures before answering so admin reads never observe disagreement.
    await this.#syncFeaturedMirror(publicInfo, featured);
    return featured;
  }

  async setBlueprintFeatured(blueprintId: string, featured: boolean, actor: AdminSettingActor)
      : Promise<void> {
    let { owner, publicInfo, featureable } = await this.#getOwnerBlueprint(blueprintId);
    if (!featureable || !owner) {
      throw new Error('Blueprint not featureable.');
    }

    let previous = this.featuredMutationTail;
    let release!: () => void;
    this.featuredMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      // The authoritative bit lives in the owner's DO, outside AdminConfig, so the change is
      // recorded here rather than by #mutateAdminConfig().
      let change = adminSettingChange("featured", blueprintId,
          (await owner.isBlueprintFeatured(blueprintId)) ?? false, featured);
      if (change) await this.#recordSetting(actor, [change], this.#config());
      await owner.setBlueprintFeatured(blueprintId, featured);
      await this.#syncFeaturedMirror(publicInfo, featured);
    } finally {
      release();
    }
  }

  async syncFeaturedBlueprint(publicInfo: BlueprintPublicInfo): Promise<void> {
    // Overseer propagation calls this after blueprint updates so the mirror keeps up with the
    // latest published metadata, but only while the owner-side featured bit stays enabled.
    await this.#syncFeaturedMirror(publicInfo, true);
  }

  async deleteFeaturedBlueprint(blueprintId: string): Promise<void> {
    if (this.storage.featuredBlueprints.get(blueprintId)) {
      this.storage.featuredBlueprints.delete(blueprintId);
      await this.#writeFeaturedSnapshot();
    }
  }

  // --- Deployment updates ---

  /**
   * Whether a newer release is available, or null, with no request made, unless the deploy flow
   * installed this deployment. Answered from the last update check for the running release, made
   * again when updateCheckDue() says so while automatic checks are on.
   */
  async getUpdateStatus(): Promise<DeploymentUpdateStatus | null> {
    let install = deployServiceInstall(this.env);
    if (!install) return null;
    let config = this.#config();
    if (config.updateChecksEnabled && updateCheckDue(this.storage.updateCheck.get(),
                                                     install.releaseId,
                                                     config.updateCheckIntervalMinutes, Date.now())) {
      await this.#checkForUpdate(install);
    }
    return this.#updateStatus(install);
  }

  /**
   * Check for a newer release now, whatever the settings and the last check, and return the
   * status it produces, or null, with no request made, unless the deploy flow installed this
   * deployment. Throws when the check fails, without saying why: the failure is logged.
   */
  async checkForUpdates(): Promise<DeploymentUpdateStatus | null> {
    let install = deployServiceInstall(this.env);
    if (!install) return null;
    if (!await this.#checkForUpdate(install)) throw new Error("The update check failed.");
    return this.#updateStatus(install);
  }

  /** Set whether the deployment checks for a newer release by itself. */
  async setUpdateChecksEnabled(enabled: boolean, actor: AdminSettingActor): Promise<void> {
    await this.updateAdminConfig({ updateChecksEnabled: enabled }, actor);
  }

  /** Set how many minutes a successful update check is relied on before the deployment asks again. */
  async setUpdateCheckIntervalMinutes(minutes: number, actor: AdminSettingActor): Promise<void> {
    if (!isUpdateCheckInterval(minutes)) {
      throw new Error("The check interval must be a whole number of minutes from 1 to " +
          `${MAX_UPDATE_CHECK_INTERVAL_MINUTES}.`);
    }
    await this.updateAdminConfig({ updateCheckIntervalMinutes: minutes }, actor);
  }

  /** Set how many hours a newer release must have been available before admins are notified. */
  async setUpdateMinimumAgeHours(hours: number, actor: AdminSettingActor): Promise<void> {
    await this.updateAdminConfig(
        { updateMinimumAgeHours: updateHours("minimum age", hours) }, actor);
  }

  /** Set how many hours a dismissed update notice stays hidden in the browser that dismissed it. */
  async setUpdateNoticeSnoozeHours(hours: number, actor: AdminSettingActor): Promise<void> {
    await this.updateAdminConfig(
        { updateNoticeSnoozeHours: updateHours("notice snooze", hours) }, actor);
  }

  /** Record the version tag the router reported ("" for none); see ROUTER_VERSION_HEADER. */
  async recordRouterTag(tag: string): Promise<void> {
    if (this.storage.routerVersionTag.get() !== tag) this.storage.routerVersionTag.put(tag);
  }

  async #updateStatus(install: DeployServiceInstall): Promise<DeploymentUpdateStatus> {
    let gatekeepers = await this.#gatekeeperVersionTags();
    let versions = new Map<string, VersionAnswer>([
      ["backend", this.env.CF_VERSION_METADATA?.tag],
      ["router", this.storage.routerVersionTag.get() ?? NO_ANSWER],
      ...gatekeepers,
    ]);
    return deploymentUpdateStatus(install, this.#config(), this.storage.updateCheck.get(),
        versions, Date.now());
  }

  // What each bound gatekeeper answered when asked for its version tag, by install slug.
  // Concurrent callers share each question. An answer is served for VERSION_TAGS_TTL_MS; a
  // gatekeeper that did not answer is asked again by the next call, and only it.
  #gatekeeperVersionTags(): Promise<[string, VersionAnswer][]> {
    let now = Date.now();
    return Promise.all([...this.vendors].map(
        async ([id, vendor]): Promise<[string, VersionAnswer]> => {
      let cached = this.#versionTags.get(id);
      if (!cached || cached.expires <= now) {
        let entry = { expires: now + VERSION_TAGS_TTL_MS, answer: this.#askVersionTag(id, vendor) };
        this.#versionTags.set(id, entry);
        void entry.answer.then(answer => {
          if (answer === NO_ANSWER && this.#versionTags.get(id) === entry) {
            this.#versionTags.delete(id);
          }
        });
        cached = entry;
      }
      return [id, await cached.answer];
    }));
  }

  #versionTags = new Map<string, { expires: number, answer: Promise<VersionAnswer> }>();

  // Never throws. A gatekeeper that throws, takes too long, or has no versionTag() (which an RPC
  // stub cannot tell from one that throws) did not answer.
  async #askVersionTag(id: string, vendor: Service<GatekeeperVendor>): Promise<VersionAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("No version tag in time.")),
          VERSION_TAG_TIMEOUT_MS);
    });
    try {
      // Always true of an RPC stub, whose every property is callable: this only narrows the
      // type, which also allows for the method's absence.
      if (typeof vendor.versionTag !== "function") throw new Error("No versionTag().");
      return await Promise.race([vendor.versionTag(), timeout]);
    } catch (err) {
      logger.warn("failed to read a gatekeeper's version tag", {
        event: "gatekeeper.version-tag.read.failed", gatekeeperId: id, error: err,
      });
      return NO_ANSWER;
    } finally {
      clearTimeout(timer);
    }
  }

  // Concurrent callers share one check. Resolves whether it succeeded.
  #checkForUpdate(install: DeployServiceInstall): Promise<boolean> {
    return this.#updateCheckInFlight ??= this.#runUpdateCheck(install)
        .finally(() => { this.#updateCheckInFlight = undefined; });
  }

  #updateCheckInFlight?: Promise<boolean>;

  // Never throws. A failure keeps the last success only if it was for the running release.
  async #runUpdateCheck({ releaseId, updateCheckUrl }: DeployServiceInstall): Promise<boolean> {
    let attemptedAt = Date.now();
    try {
      let result = await fetchLatestRelease(updateCheckUrl, releaseId);
      this.storage.updateCheck.put({ from: releaseId, attemptedAt, checkedAt: attemptedAt, result });
      return true;
    } catch (error) {
      logger.warn("failed to check for a newer release", {
        event: "deployment.update-check.failed", error,
      });
      let previous = this.storage.updateCheck.get();
      this.storage.updateCheck.put(previous?.from === releaseId
          ? { ...previous, attemptedAt } : { from: releaseId, attemptedAt });
      return false;
    }
  }

  // --- Deployment admin config ---

  // Every read of the stored config goes through the same normalization as the KV mirror. A
  // config persisted before a field existed is missing that field entirely; in particular,
  // userSearchEnabled has a dependent default and cannot be restored by a simple defaults spread.
  #config(): AdminConfig {
    return normalizeAdminConfig(this.storage.adminConfig.get());
  }

  getAdminConfig(): AdminConfig {
    return this.#config();
  }

  // The one writer of the stored config. `actor` is the admin making the change, which is recorded
  // in the audit log before anything is stored, so that a change whose record cannot be written is
  // refused; null for a write that records nothing: the deployment's own, or one whose change its
  // caller has already recorded.
  async #mutateAdminConfig(actor: AdminSettingActor | null,
                           mutate: (config: AdminConfig) => AdminConfig): Promise<void> {
    let previousMutation = this.adminConfigMutationTail;
    let release!: () => void;
    this.adminConfigMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previousMutation;
    try {
      let current = this.#config();
      let next = mutate(current);
      // A no-op records nothing, but is still written: it may be a retry repairing the KV mirror.
      let changes = actor ? diffAdminConfig(current, next) : [];
      if (actor && changes.length > 0) await this.#recordSetting(actor, changes, current);
      this.storage.adminConfig.put(next);
      try {
        await this.env.BLUEPRINTS.put(ADMIN_CONFIG_KEY, serializeAdminConfig(next));
      } catch (error) {
        // The record stays: it records the attempt (see AdminSettingRecord).
        this.storage.adminConfig.put(current);
        throw error;
      }
    } finally {
      release();
    }
  }

  // Append `actor`'s change to the deployment-wide audit log, kept as long as `config` says.
  // Throws when it cannot be appended, which refuses the change.
  async #recordSetting(actor: AdminSettingActor, changes: AdminSettingChange[],
                       config: AdminConfig): Promise<void> {
    await this.audits.getByName("").append({ kind: "setting", at: new Date(), ...actor, changes },
        adminAccessPolicy(config, this.env).retentionDays);
  }

  /**
   * Merge a partial update into the admin config and mirror it to KV, recording the change `actor`
   * makes. Callers (AdminApiImpl) validate scalar values; this just persists atomically.
   */
  updateAdminConfig(patch: Partial<AdminConfig>, actor: AdminSettingActor): Promise<void> {
    return this.#mutateAdminConfig(actor, config => ({ ...config, ...patch }));
  }

  /**
   * Read all admin-managed settings for the admin UI in one call: the stored config plus the live
   * resource catalog (every bound gatekeeper's resource types annotated with their enabled state),
   * and the admin access level and audit retention as chosen, bounded by the environment and
   * enforced.
   *
   * `adminUserId` is the requesting admin's user id (email/username), forwarded to each gatekeeper's
   * getSupportedResources(). Most gatekeepers ignore it, but RBAC-gated ones (e.g. the internal GTM
   * Data gatekeeper) only reveal their resources to users with the right permission — so without it
   * they'd be hidden from the admin Gatekeepers tab.
   */
  async getSettings(adminUserId: string): Promise<AdminSettingsView> {
    let config = this.#config();
    let policy = adminAccessPolicy(config, this.env);
    return {
      signupsEnabled: config.signupsEnabled,
      userSearchEnabled: config.userSearchEnabled,
      siteName: config.siteName,
      siteLogo: siteLogoImage(config.siteLogoConfigured),
      instanceInstructions: config.instanceInstructions,
      announcement: config.announcement,
      banner: config.banner,
      accentColor: config.accentColor,
      resourceVendors: await this.#listResourceConfig(config, adminUserId),
      formats: await this.#listFormatConfig(config),
      gatewayModels: this.#listGatewayModels(config),
      adminWorkspaceAccess: {
        effective: policy.access,
        chosen: config.adminWorkspaceAccess,
        max: maxAdminWorkspaceAccess(this.env),
      },
      adminAuditRetentionDays: {
        effective: policy.retentionDays,
        chosen: config.adminAuditRetentionDays,
        min: minAdminAuditRetentionDays(this.env),
      },
    };
  }

  /**
   * Set the access level admins choose for inspectWorkspace(), recording the change `actor` makes.
   * Throws for a level above the one ADMIN_WORKSPACE_ACCESS_MAX allows, which a compromised admin
   * session can never raise.
   */
  async setAdminWorkspaceAccess(access: AdminWorkspaceAccess, actor: AdminSettingActor)
      : Promise<void> {
    let max = maxAdminWorkspaceAccess(this.env);
    if (lowerAdminWorkspaceAccess(access, max) !== access) {
      throw new Error(`Admin access to workspaces can't be set above "${max}", the most this ` +
          "deployment's ADMIN_WORKSPACE_ACCESS_MAX allows.");
    }
    await this.#mutateAdminConfig(actor, config => ({ ...config, adminWorkspaceAccess: access }));
  }

  /**
   * Set how many days admins choose to keep audit records for, recording the change `actor` makes.
   * Throws unless a whole number from the minimum ADMIN_AUDIT_RETENTION_MIN_DAYS sets to
   * MAX_ADMIN_AUDIT_RETENTION_DAYS.
   */
  async setAdminAuditRetentionDays(days: number, actor: AdminSettingActor): Promise<void> {
    let min = minAdminAuditRetentionDays(this.env);
    if (!Number.isInteger(days) || days < min || days > MAX_ADMIN_AUDIT_RETENTION_DAYS) {
      throw new Error(`The audit retention must be a whole number of days from ${min}, the ` +
          `fewest this deployment's ADMIN_AUDIT_RETENTION_MIN_DAYS allows, to ` +
          `${MAX_ADMIN_AUDIT_RETENTION_DAYS}.`);
    }
    await this.#mutateAdminConfig(actor, config => ({ ...config, adminAuditRetentionDays: days }));
  }

  // --- Standard output formats ---

  // Admin view of the promoted formats: the deployment's curation joined with each blueprint, so
  // the panel can show what is being curated and flag entries whose blueprint has been deleted.
  async #listFormatConfig(config: AdminConfig): Promise<AdminFormat[]> {
    let bundled = new Set(BUNDLED_BLUEPRINTS.map(entry => entry.blueprintId));

    // Every entry, not just the offered ones: the panel exists to show what is disabled and what
    // points at a deleted blueprint.
    return (await listPromotedFormats(this.env, config.formats)).map(
        ({entry, metadata, declared, output}) => ({
          blueprintId: entry.blueprintId,
          blueprintTitle: metadata?.title ?? "",
          blueprintDescription: metadata?.description ?? "",
          output,
          declared,
          overrides: entry.overrides,
          enabled: entry.enabled,
          agentHint: entry.agentHint ?? "",
          missing: !metadata,
          bundled: bundled.has(entry.blueprintId),
        }));
  }

  // Read-modify-write one format entry within the DO, so concurrent admin edits can't clobber each
  // other. `mutate` returns the replacement list, or null to leave the config untouched.
  async #mutateFormats(actor: AdminSettingActor,
                       mutate: (formats: FormatCuration[]) => FormatCuration[] | null)
      : Promise<void> {
    await this.#mutateAdminConfig(actor, config => {
      let next = mutate(config.formats);
      // A no-op may be a retry after the prior KV write failed but DO storage succeeded. Mirror the
      // current config again so idempotent retries repair that partial failure.
      return next ? {...config, formats: next} : config;
    });
  }

  async promoteFormat(blueprintId: string, actor: AdminSettingActor): Promise<void> {
    let record = await readBlueprintKvRecord(this.env, blueprintId);
    if (!record) {
      throw new Error("Blueprint not found.");
    }
    await this.#mutateFormats(actor, formats => {
      // Idempotent so retrying after a KV mirror failure reaches #mutateFormats()'s repair write.
      if (formats.some(f => f.blueprintId === blueprintId)) return null;
      // A blueprint that declares no output still needs a stable grouping key before the admin can
      // name it. Generate that hidden implementation detail here; the panel only asks the admin for
      // the human-facing noun, plural and icon.
      let declared = sanitizeBlueprintOutput(record.metadata.output);
      return [...formats, {
        blueprintId,
        enabled: true,
        ...(declared ? {} : {overrides: {id: defaultOutputFormatId(blueprintId)}}),
      }];
    });
  }

  async removeFormat(blueprintId: string, actor: AdminSettingActor): Promise<void> {
    // Enforced here, not just in the panel: this is an RPC an admin session can call directly.
    // Withdrawing a bundled entry is `enabled: false`, which keeps its overrides, hint and
    // position.
    if (BUNDLED_BLUEPRINTS.some(entry => entry.blueprintId === blueprintId)) {
      throw new Error(
          "This format ships with the deployment, so it can't be removed. Turn it off instead.");
    }
    await this.#mutateFormats(actor, formats => {
      let next = formats.filter(f => f.blueprintId !== blueprintId);
      return next.length === formats.length ? null : next;
    });
  }

  async updateFormat(blueprintId: string, patch: AdminFormatPatch, actor: AdminSettingActor)
      : Promise<void> {
    await this.#mutateFormats(actor, formats => formats.map(entry => {
      if (entry.blueprintId !== blueprintId) return entry;

      let next: FormatCuration = {...entry};
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.agentHint !== undefined) {
        // Truncated because every hint is repeated in the system prompt on every turn, so an
        // over-long one costs tokens on requests nobody connects back to this panel.
        let hint = patch.agentHint.trim().slice(0, MAX_AGENT_HINT);
        if (hint) next.agentHint = hint; else delete next.agentHint;
      }
      if (patch.overrides) {
        // null reverts a field to the blueprint's own declaration; absent leaves it alone.
        let merged: Record<string, unknown> = {...entry.overrides};
        for (let [key, value] of Object.entries(patch.overrides)) {
          if (value === null) delete merged[key]; else merged[key] = value;
        }
        let clean = sanitizeOutputOverrides(merged);
        if (clean) next.overrides = clean; else delete next.overrides;
      }
      return next;
    }));
  }

  async setFormatOrder(blueprintIds: string[], actor: AdminSettingActor): Promise<void> {
    await this.#mutateFormats(actor, formats => reorderFormats(formats, blueprintIds));
  }

  // --- AI Gateway models ---

  // The gateway's configuration. Throws outside AI Gateway mode, which has no models to manage.
  #requireGateway(): AiGatewayConfig {
    let gateway = getAiGatewayConfig(this.env);
    if (!gateway) throw new Error("This deployment does not provide models through AI Gateway.");
    return gateway;
  }

  // Admin view of the gateway models, or undefined outside AI Gateway mode. A gateway the
  // environment misconfigures reads the same way, so that it can't take the admin panel down.
  #listGatewayModels(config: AdminConfig): AdminSettingsView["gatewayModels"] {
    try {
      let gateway = getAiGatewayConfig(this.env);
      if (!gateway) return undefined;
      let models = new GatewayModels(gateway, config);
      return {
        providers: models.addableProviders,
        providerSettings: models.providerSettings,
        models: models.all.map(model => {
          let budget = compactionBudgetRange(model);
          return {
            ...model,
            reasoningLevels: gatewayReasoningLevels(
                model.provider, model.id, model.behavesLike, model.capabilities),
            builtInReasoning: gatewayBuiltInReasoning(
                model.provider, model.id, model.behavesLike, model.capabilities),
            builtInCompactionInputBudget: budget.builtIn,
            maxCompactionInputBudget: budget.max,
            runtimeKnown: isRuntimeModel(model.provider, model.id),
            ...(model.behavesLike !== undefined &&
                { behavesLikeKnown: isRuntimeModel(model.provider, model.behavesLike) }),
          };
        }),
        defaultReasoning: config.defaultReasoning,
        userModelsEnabled: models.userModels,
        modelsDevSuggestions: config.modelsDevSuggestions,
      };
    } catch (error) {
      logger.error("failed to read the AI Gateway models", {
        event: "gateway.models.read.failed", error,
      });
      return undefined;
    }
  }

  /**
   * Set how a gateway model is offered, atomically (read-modify-write within the DO). The model's
   * default mode is stored as absence, so setting it forgets the override.
   */
  async setGatewayModelMode(modelId: string, mode: GatewayModelMode, actor: AdminSettingActor)
      : Promise<void> {
    await this.#mutateAdminConfig(actor, config => {
      // Built from the config the mutation is handed, which is authoritative; the KV mirror the
      // user-facing paths read can trail it.
      let model = new GatewayModels(this.#requireGateway(), config).get(modelId);
      if (!model) throw new Error(`No such model: ${modelId}`);
      let modes = entriesWithout(config.modelModes, modelId);
      if (mode !== model.defaultMode) modes.push([modelId, mode]);
      return { ...config, modelModes: Object.fromEntries(modes) };
    });
  }

  /**
   * Replace what is set for a gateway model, atomically. Nothing set is stored as absence. The
   * reasoning level is not held to the model's own levels, since a request clamps it to them; the
   * compaction budget is held to the room the model's window leaves for a prompt.
   */
  async setGatewayModelSettings(modelId: string, settings: GatewayModelSettings,
                                actor: AdminSettingActor): Promise<void> {
    await this.#mutateAdminConfig(actor, config => {
      let model = new GatewayModels(this.#requireGateway(), config).get(modelId);
      if (!model) throw new Error(`No such model: ${modelId}`);
      let budget = settings.compactionInputBudget;
      if (budget !== undefined) {
        let { max } = compactionBudgetRange(model);
        if (max <= 0) {
          throw new Error(`The "${model.name}" model's context window leaves no room for a ` +
              "compaction budget.");
        }
        if (!Number.isSafeInteger(budget) || budget <= 0 || budget > max) {
          throw new Error(`The compaction budget of the "${model.name}" model must be a whole ` +
              `number of tokens from 1 to ${max}.`);
        }
      }
      let entries = entriesWithout(config.modelSettings, modelId);
      let clean = sanitizeModelSettings(settings);
      if (clean) entries.push([modelId, clean]);
      return { ...config, modelSettings: Object.fromEntries(entries) };
    });
  }

  /** Set the reasoning level of the gateway models whose settings give none, or null for none. */
  async setDefaultReasoning(level: ReasoningLevel | null, actor: AdminSettingActor)
      : Promise<void> {
    this.#requireGateway();
    await this.updateAdminConfig({ defaultReasoning: level }, actor);
  }

  // The model `model` describes, as it is stored once added. Throws outside AI Gateway mode, and
  // unless the model may be added to `config`: it is well-formed, its provider is one a model may
  // be added under, its ID is free, the runtime knows the model it behaves like, and its window
  // leaves room for a prompt.
  #addableModel(model: GatewayModel, config: AdminConfig): GatewayModel {
    let added = sanitizeAddedModel(model);
    if (!added) {
      throw new Error(
          "Invalid model: it needs an ID and a name, neither over-long, and token limits that " +
          "are positive integers. The ID of a model it behaves like can't be over-long either.");
    }
    new GatewayModels(this.#requireGateway(), config).assertAddable(added);
    if (added.behavesLike !== undefined && !isRuntimeModel(added.provider, added.behavesLike)) {
      throw new Error(`"${added.behavesLike}" is not a model the runtime knows under ` +
          `provider "${added.provider}", so "${added.id}" can't behave like it.`);
    }
    // A response is reserved out of the window, so a reservation that fills it would leave
    // every chat on the model with no prompt to send.
    let { inputBudget, maxOutputTokens } =
        getModelTokenLimits(gatewayModelConfig(addedModel(added)));
    if (inputBudget <= 0) {
      throw new Error(`The "${added.name}" model's context window leaves no room for a ` +
          `prompt: ${maxOutputTokens} tokens of it are reserved for the response. Give the ` +
          "model an output limit under its context window.");
    }
    return added;
  }

  /**
   * Add a gateway model. Whether its ID is free is decided within the mutation, so that two
   * concurrent calls can't both add the same one.
   */
  async addGatewayModel(model: GatewayModel, actor: AdminSettingActor): Promise<void> {
    await this.#mutateAdminConfig(actor, config => {
      let added = this.#addableModel(model, config);
      // The ID was free, so a mode or settings stored under it belonged to a model that has since
      // left.
      return {
        ...config,
        addedModels: [...config.addedModels, added],
        modelModes: Object.fromEntries(entriesWithout(config.modelModes, added.id)),
        modelSettings: Object.fromEntries(entriesWithout(config.modelSettings, added.id)),
      };
    });
  }

  /** Remove an added gateway model, and with it the mode and settings it was given. */
  async removeGatewayModel(modelId: string, actor: AdminSettingActor): Promise<void> {
    this.#requireGateway();
    await this.#mutateAdminConfig(actor, config => {
      let addedModels = config.addedModels.filter(model => model.id !== modelId);
      if (addedModels.length === config.addedModels.length) {
        throw new Error(`No such added model: ${modelId}`);
      }
      // The catalog wins an ID it lists, so a mode or settings stored under one are the suggested
      // model's.
      if (isCatalogModel(modelId)) return { ...config, addedModels };
      return {
        ...config,
        addedModels,
        modelModes: Object.fromEntries(entriesWithout(config.modelModes, modelId)),
        modelSettings: Object.fromEntries(entriesWithout(config.modelSettings, modelId)),
      };
    });
  }

  /**
   * Turn a provider on or off beside the ones the environment lists, which are a floor. Off keeps
   * the modes and settings of the provider's models and the models added under it, all of which
   * return with it.
   */
  async setGatewayProviderEnabled(provider: AiModelProvider, enabled: boolean,
                                  actor: AdminSettingActor): Promise<void> {
    await this.#mutateAdminConfig(actor, config => {
      let gateway = this.#requireGateway();
      assertGatewayProvider(provider);
      if (gateway.providers.has(provider)) {
        // On already, with nothing to store.
        if (enabled) return config;
        throw new Error(`Provider "${provider}" is enabled by CF_AI_GATEWAY_PROVIDERS and can ` +
            "only be turned off there.");
      }
      let addedProviders = config.addedProviders.filter(added => added !== provider);
      if (enabled) addedProviders.push(provider);
      return { ...config, addedProviders };
    });
  }

  /**
   * Ask the first suggested model of a provider for a few tokens through the gateway, on behalf
   * of the admin `adminUserId`, and report what happened. A request that fails is a result. The
   * environment alone decides how the request is routed, so a provider that is off can be tested.
   *
   * Nothing is stored and the config mutation queue is not joined, so the other admin calls run
   * while the request is out.
   */
  async testGatewayProvider(provider: AiModelProvider, adminUserId: string)
      : Promise<GatewayModelTest> {
    let gateway = this.#requireGateway();
    assertGatewayProvider(provider);
    let [model] = Object.keys(SUGGESTED_MODELS[provider]);
    if (model === undefined) {
      throw new Error(`Provider "${provider}" has no suggested model to test.`);
    }
    return this.#runTest(gateway, { provider, model, apiToken: "" }, adminUserId, PROVIDER_TEST);
  }

  /**
   * Ask a gateway model for an answer the way a chat turn would, on behalf of the admin
   * `adminUserId`, and report what happened: the request goes out with the config the model runs
   * with, so with the reasoning level in effect for it, under the response cap of a test (see
   * AdminApi.testGatewayModel). A request that fails is a result. A model in any mode can be
   * tested, so that an admin can try one before enabling it.
   *
   * Like testGatewayProvider(), it stores nothing and stays out of the config mutation queue. The
   * config is the authoritative one, which the KV mirror the chats read can trail.
   */
  async testGatewayModel(modelId: string, adminUserId: string): Promise<GatewayModelTest> {
    let gateway = this.#requireGateway();
    let config = new GatewayModels(gateway, this.#config()).runConfig(modelId);
    if (!config) throw new Error(`No such model: ${modelId}`);
    return this.#runTest(gateway, config, adminUserId, MODEL_TEST);
  }

  /**
   * Test the gateway model `model` describes, without adding it and on behalf of the admin
   * `adminUserId`. One request sets no reasoning level and one is at each level the model would
   * list once added, least to most: each is sent as testGatewayModel() sends its own, with the
   * config the added model would run with at that level, and all are sent together. The results
   * come in that order, each with its level, which is null for the request that set none. A
   * request that fails is the result of its level alone. Throws for a model addGatewayModel()
   * would refuse, as it does.
   *
   * Like testGatewayModel(), it stores nothing and stays out of the config mutation queue: the
   * model is held to the config as this call reads it, and whether it may be added is for
   * addGatewayModel() to decide within its own mutation.
   */
  async testNewGatewayModel(model: GatewayModel, adminUserId: string)
      : Promise<GatewayModelLevelTest[]> {
    let gateway = this.#requireGateway();
    let added = addedModel(this.#addableModel(model, this.#config()));
    let levels = gatewayReasoningLevels(
        added.provider, added.id, added.behavesLike, added.capabilities);
    return Promise.all([null, ...levels].map(async reasoning => ({
      ...await this.#runTest(
          gateway, gatewayRunConfig(added, reasoning), adminUserId, MODEL_TEST),
      reasoning,
    })));
  }

  // Send the model `config` describes one prompt through the gateway, as `test` says to and on
  // behalf of the admin `adminUserId`, and report what happened.
  async #runTest(gateway: AiGatewayConfig, config: AiModelConfig, adminUserId: string,
                 test: GatewayTest): Promise<GatewayModelTest> {
    let model = config.model;
    let signal = AbortSignal.timeout(test.timeoutMs);
    let startedAt = Date.now();
    let failure: { status?: number, message: string } | undefined;
    try {
      let handle = getModel(this.env, config,
          { type: "user", id: adminUserId, name: adminUserId });
      await completeText(handle, {
        prompt: "Reply with OK.", maxTokens: Math.min(test.maxTokens, handle.model.maxTokens),
        thinking: test.thinking, signal,
        // Agent turns let the provider cache their prompts, so a model that rejects the cache
        // fields fails here rather than in the first turn.
        cache: true,
        // The request is the same every time, which a gateway that caches responses would
        // answer without asking the provider.
        headers: { "cf-aig-skip-cache": "true" },
      });
    } catch (error) {
      // The signal is this call's own, so nothing but the timeout aborts it.
      let message = signal.aborted
          ? `The model did not answer within ${test.timeoutMs / 1000} seconds.`
          : error instanceof Error ? error.message : String(error);
      let status = error instanceof AgentTurnError ? error.statusCode : undefined;
      failure = {
        ...(status !== undefined && { status }),
        message: testFailureMessage(message, gateway.apiToken),
      };
    }
    // The failure message stays out of the log: a provider words it.
    logger.info(test.logged, {
      event: test.event, modelId: model, outcome: failure ? "error" : "ok",
      statusCode: failure?.status, durationMs: Date.now() - startedAt,
    });
    return failure ? { model, ok: false, ...failure } : { model, ok: true };
  }

  /** Set whether users may add models of their own to the ones the gateway provides. */
  async setUserModelsEnabled(enabled: boolean, actor: AdminSettingActor): Promise<void> {
    this.#requireGateway();
    await this.updateAdminConfig({ userModelsEnabled: enabled }, actor);
  }

  /** Set whether the admin UI may suggest models from models.dev while an admin adds one. */
  async setModelsDevSuggestions(enabled: boolean, actor: AdminSettingActor): Promise<void> {
    this.#requireGateway();
    await this.updateAdminConfig({ modelsDevSuggestions: enabled }, actor);
  }

  /** Enable/disable a single gatekeeper resource type atomically (read-modify-write within the DO). */
  async setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean,
                           actor: AdminSettingActor): Promise<void> {
    vendorId = vendorId.toLowerCase();
    await this.#mutateAdminConfig(actor, config => {
      let map = { ...config.disabledResources };
      let disabled = new Set(map[vendorId] ?? []);
      if (enabled) disabled.delete(urlPattern); else disabled.add(urlPattern);
      if (disabled.size === 0) delete map[vendorId]; else map[vendorId] = [...disabled];
      return { ...config, disabledResources: map };
    });
  }

  async setSiteLogo(data: Uint8Array | null, actor: AdminSettingActor): Promise<boolean> {
    let previous = this.siteLogoMutationTail;
    let release!: () => void;
    this.siteLogoMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      let current = this.#config();
      // Recorded before R2 or the config changes, so the config writes below record nothing more.
      // A logo is recorded as its size and digest, never its bytes.
      let change = adminSettingChange("siteLogo", undefined,
          current.siteLogoConfigured ? "custom" : "default",
          data === null ? "default" : {
            bytes: data.byteLength,
            sha256: new Uint8Array(await crypto.subtle.digest("SHA-256", data)).toHex(),
          });
      if (change) await this.#recordSetting(actor, [change], current);
      if (data === null) {
        await this.#mutateAdminConfig(null, config => ({ ...config, siteLogoConfigured: false }));
        try {
          await this.env.BLUEPRINT_CONTENT.delete(SITE_LOGO_R2_KEY);
        } catch (error) {
          logger.warn("failed to delete disabled site logo", {
            event: "site.logo.delete.failed", error,
          });
        }
        return false;
      }

      await this.env.BLUEPRINT_CONTENT.put(SITE_LOGO_R2_KEY, data, {
        httpMetadata: { contentType: "image/png" },
      });
      if (!current.siteLogoConfigured) {
        await this.#mutateAdminConfig(null, config => ({ ...config, siteLogoConfigured: true }));
      }
      return true;
    } finally {
      release();
    }
  }

  /**
   * Set a gatekeeper's availability atomically (read-modify-write within the DO). Routes by kind: an
   * auto-provisioning ("ambient") gatekeeper stores its three-state mode in ambientGatekeeperModes
   * (default stored as absence); an ordinary gatekeeper stores a binary enabled/disabled in
   * disabledGatekeepers and rejects the ambient-only 'optional'.
   */
  async setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode, actor: AdminSettingActor)
      : Promise<void> {
    vendorId = vendorId.toLowerCase();
    let vendor = this.vendors.get(vendorId);
    let autoProvisions = !!vendor && (await vendor.describe()).autoProvisionsAccount === true;
    if (autoProvisions) {
      await this.#mutateAdminConfig(actor, config => {
        let modes = { ...config.ambientGatekeeperModes };
        if (mode === DEFAULT_AMBIENT_GATEKEEPER_MODE) delete modes[vendorId]; else modes[vendorId] = mode;
        return { ...config, ambientGatekeeperModes: modes };
      });
    } else {
      if (mode === "optional") {
        throw new Error(`"${vendorId}" is not an auto-provisioning gatekeeper; use 'enabled' or 'disabled'.`);
      }
      await this.#mutateAdminConfig(actor, config => {
        let disabled = new Set(config.disabledGatekeepers);
        if (mode === "enabled") disabled.delete(vendorId); else disabled.add(vendorId);
        return { ...config, disabledGatekeepers: [...disabled] };
      });
    }
  }

  // Admin view of every bound gatekeeper's resource types, annotated with their enabled state.
  // Unlike the user-facing listGatekeeperVendors, this does NOT hide disabled resources (so admins
  // can re-enable them). `adminUserId` is forwarded to getSupportedResources() so RBAC-gated
  // gatekeepers still surface for an admin who has access to them.
  async #listResourceConfig(config: AdminConfig, adminUserId: string): Promise<AdminResourceVendor[]> {
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    let promises: Promise<AdminResourceVendor | null>[] = [];
    for (let [id, vendor] of this.vendors) {
      promises.push((async () => {
        try {
          let [description, supportedResources] = await Promise.all([
            vendor.describe(),
            vendor.getSupportedResources({ userId: adminUserId }),
          ]);
          if (description.autoProvisionsAccount) {
            // Auto-provisioning ("ambient") gatekeeper: a three-state mode, no resources to toggle.
            let mode = ambientGatekeeperMode(config, id);
            return {
              vendorId: id,
              displayName: description.displayName,
              logo: description.logo,
              autoProvisions: true,
              ambientMode: mode,
            };
          }
          if (supportedResources.length === 0) {
            // Nothing to toggle for this gatekeeper.
            return null;
          }
          let disabled = new Set(config.disabledResources[id] ?? []);
          return {
            vendorId: id,
            displayName: description.displayName,
            logo: description.logo,
            autoProvisions: false,
            enabled: !disabledGatekeeperSet.has(id),
            resources: supportedResources.map(r => ({
              urlPattern: r.urlPattern,
              title: r.title,
              description: r.description,
              icon: r.icon,
              enabled: !disabled.has(r.urlPattern),
            })),
          };
        } catch (err) {
          logger.warn("failed to read resource config for gatekeeper", {
            event: "gatekeeper.resource.config.read.failed", gatekeeperId: id, error: err,
          });
          return null;
        }
      })());
    }

    let vendors = (await Promise.all(promises)).filter((v): v is AdminResourceVendor => v !== null);
    // Show auto-provisioned ("ambient") gatekeepers first; preserve the existing order otherwise.
    vendors.sort((a, b) => Number(b.autoProvisions) - Number(a.autoProvisions));
    return vendors;
  }
}

// Capability for managing and investigating the deployment, obtained via
// AuthenticatedApi.getAdminApi() (which is null for non-admins). The admin access check happens
// once, when the capability is minted in server.ts, so its methods don't re-check, with one
// exception: inspectWorkspace() re-checks, as openForAdmin() and every call on the view it mints
// do, since a view is the one thing an admin holds that reads users' data. Setting by setting,
// this is a thin validation+forwarding facade over the AdminSettings DO — fully user-independent —
// so a disabled gatekeeper/resource can't be re-enabled via a crafted request, and the client
// never receives a stub to the DO's internal methods. Every setter's change is recorded in the
// deployment's audit log before it takes effect (see #mutateAdminConfig()). Covers branding, agent
// instructions, signups, gatekeeper connector/resource availability, AI Gateway models, whether an
// update is available, the user and workspace directory, and admin access to workspaces;
// authentication config stays env-var driven.
@validateRpc()
export class AdminApiImpl extends RpcTarget implements AdminApi {
  private admin: DurableObjectStub<AdminSettings>;
  private directories: DurableObjectNamespace<UserDirectoryDurableObject>;
  private audits: DurableObjectNamespace<AdminAuditDurableObject>;
  private overseers: DurableObjectNamespace<OverseerDurableObject>;
  #sessionId = crypto.randomUUID();

  /**
   * `adminUserId` is the requesting admin's canonical id and `via` what their client said it is
   * (AdminApiOptions.via). The capability's audit `sessionId` is minted here, so there is one per
   * AuthenticatedApi.getAdminApi() call. Reaches the AdminSettings, UserDirectory, AdminAudit and
   * Overseer namespaces through `ctx.exports`, and reads ADMINS and the admin access bounds from
   * `env`.
   */
  constructor(ctx: ExecutionContext, private env: Cloudflare.Env, private adminUserId: string,
              private via: AdminVia) {
    super();
    this.admin = ctx.exports.AdminSettings.getByName("");
    this.directories = ctx.exports.UserDirectoryDurableObject;
    this.audits = ctx.exports.AdminAuditDurableObject;
    this.overseers = ctx.exports.OverseerDurableObject;
  }

  // Who makes a change through `method` of this capability, as its audit record says.
  #actor(method: AdminSettingMethod): AdminSettingActor {
    return { admin: this.adminUserId, sessionId: this.#sessionId, via: this.via, method };
  }

  getSettings(): Promise<AdminSettingsView> {
    return this.admin.getSettings(this.adminUserId);
  }

  async setSignupsEnabled(enabled: boolean): Promise<void> {
    await this.admin.updateAdminConfig(
        { signupsEnabled: enabled }, this.#actor("setSignupsEnabled"));
  }

  async setUserSearchEnabled(enabled: boolean): Promise<void> {
    await this.admin.updateAdminConfig(
        { userSearchEnabled: enabled }, this.#actor("setUserSearchEnabled"));
  }

  async setSiteName(name: string): Promise<void> {
    if (name.length > MAX_SITE_NAME_LENGTH) {
      throw new Error(`Site name too long (max ${MAX_SITE_NAME_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ siteName: name }, this.#actor("setSiteName"));
  }

  async setSiteLogo(data: Uint8Array | null): Promise<AdminSettingsView['siteLogo']> {
    if (data !== null) validateSiteLogo(data);
    return siteLogoImage(await this.admin.setSiteLogo(data, this.#actor("setSiteLogo")));
  }

  async setInstanceInstructions(text: string): Promise<void> {
    if (text.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH) {
      throw new Error(`Instructions too long (max ${MAX_INSTANCE_INSTRUCTIONS_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig(
        { instanceInstructions: text }, this.#actor("setInstanceInstructions"));
  }

  setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    return this.admin.setResourceEnabled(
        vendorId, urlPattern, enabled, this.#actor("setResourceEnabled"));
  }

  setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    if (!isAmbientGatekeeperMode(mode)) {
      throw new Error(`Invalid gatekeeper mode: ${mode}`);
    }
    return this.admin.setGatekeeperMode(vendorId, mode, this.#actor("setGatekeeperMode"));
  }

  async setAnnouncement(text: string): Promise<void> {
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Announcement too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ announcement: text }, this.#actor("setAnnouncement"));
  }

  async setBanner(text: string, color: BannerColor): Promise<void> {
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Banner too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    if (!isBannerColor(color)) {
      throw new Error(`Invalid banner color: ${color}`);
    }
    await this.admin.updateAdminConfig({ banner: { text, color } }, this.#actor("setBanner"));
  }

  async setAccentColor(color: string): Promise<void> {
    if (color !== "" && !isHexColor(color)) {
      throw new Error(`Invalid accent color: ${color}`);
    }
    await this.admin.updateAdminConfig({ accentColor: color }, this.#actor("setAccentColor"));
  }

  isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    return this.admin.isBlueprintFeatured(blueprintId);
  }

  setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void> {
    return this.admin.setBlueprintFeatured(
        blueprintId, featured, this.#actor("setBlueprintFeatured"));
  }

  promoteFormat(blueprintId: string): Promise<void> {
    return this.admin.promoteFormat(blueprintId, this.#actor("promoteFormat"));
  }

  removeFormat(blueprintId: string): Promise<void> {
    return this.admin.removeFormat(blueprintId, this.#actor("removeFormat"));
  }

  updateFormat(blueprintId: string, patch: AdminFormatPatch): Promise<void> {
    return this.admin.updateFormat(blueprintId, patch, this.#actor("updateFormat"));
  }

  setFormatOrder(blueprintIds: string[]): Promise<void> {
    return this.admin.setFormatOrder(blueprintIds, this.#actor("setFormatOrder"));
  }

  setGatewayModelMode(modelId: string, mode: GatewayModelMode): Promise<void> {
    return this.admin.setGatewayModelMode(modelId, mode, this.#actor("setGatewayModelMode"));
  }

  addGatewayModel(model: GatewayModel): Promise<void> {
    return this.admin.addGatewayModel(model, this.#actor("addGatewayModel"));
  }

  removeGatewayModel(modelId: string): Promise<void> {
    return this.admin.removeGatewayModel(modelId, this.#actor("removeGatewayModel"));
  }

  setUserModelsEnabled(enabled: boolean): Promise<void> {
    return this.admin.setUserModelsEnabled(enabled, this.#actor("setUserModelsEnabled"));
  }

  setModelsDevSuggestions(enabled: boolean): Promise<void> {
    return this.admin.setModelsDevSuggestions(enabled, this.#actor("setModelsDevSuggestions"));
  }

  setGatewayModelSettings(modelId: string, settings: GatewayModelSettings): Promise<void> {
    return this.admin.setGatewayModelSettings(
        modelId, settings, this.#actor("setGatewayModelSettings"));
  }

  setDefaultReasoning(level: ReasoningLevel | null): Promise<void> {
    return this.admin.setDefaultReasoning(level, this.#actor("setDefaultReasoning"));
  }

  setGatewayProviderEnabled(provider: AiModelProvider, enabled: boolean): Promise<void> {
    return this.admin.setGatewayProviderEnabled(
        provider, enabled, this.#actor("setGatewayProviderEnabled"));
  }

  testGatewayProvider(provider: AiModelProvider): Promise<GatewayModelTest> {
    return this.admin.testGatewayProvider(provider, this.adminUserId);
  }

  testGatewayModel(modelId: string): Promise<GatewayModelTest> {
    return this.admin.testGatewayModel(modelId, this.adminUserId);
  }

  testNewGatewayModel(model: GatewayModel): Promise<GatewayModelLevelTest[]> {
    return this.admin.testNewGatewayModel(model, this.adminUserId);
  }

  getUpdateStatus(): Promise<DeploymentUpdateStatus | null> {
    return this.admin.getUpdateStatus();
  }

  checkForUpdates(): Promise<DeploymentUpdateStatus | null> {
    return this.admin.checkForUpdates();
  }

  setUpdateChecksEnabled(enabled: boolean): Promise<void> {
    return this.admin.setUpdateChecksEnabled(enabled, this.#actor("setUpdateChecksEnabled"));
  }

  setUpdateCheckIntervalMinutes(minutes: number): Promise<void> {
    return this.admin.setUpdateCheckIntervalMinutes(
        minutes, this.#actor("setUpdateCheckIntervalMinutes"));
  }

  setUpdateMinimumAgeHours(hours: number): Promise<void> {
    return this.admin.setUpdateMinimumAgeHours(hours, this.#actor("setUpdateMinimumAgeHours"));
  }

  setUpdateNoticeSnoozeHours(hours: number): Promise<void> {
    return this.admin.setUpdateNoticeSnoozeHours(
        hours, this.#actor("setUpdateNoticeSnoozeHours"));
  }

  // --- Users, workspaces and admin access ---

  async listUsers(options: AdminUserQuery = {}): Promise<AdminUserPage> {
    let limit = adminListLimit(options.limit);
    // Built field by field, so that nothing else the client sent reaches the directory.
    let { users, nextCursor } = await this.directories.getByName("").listUsers(
        { query: options.query, cursor: options.cursor, limit });
    let admins = deploymentAdmins(this.env);
    let page = users.map(user => ({ ...user, isAdmin: admins.has(user.id) }));
    return nextCursor === undefined ? { users: page } : { users: page, nextCursor };
  }

  async listWorkspaces(options: AdminWorkspaceQuery = {}): Promise<AdminWorkspacePage> {
    let limit = adminListLimit(options.limit);
    return await this.directories.getByName("").listWorkspaces(
        { owner: options.owner, query: options.query, cursor: options.cursor, limit });
  }

  async inspectWorkspace(workspaceId: string, reason: string, options: AdminInspectOptions = {})
      : Promise<RpcStub<AdminWorkspaceView>> {
    reason = validateAdminAccessReason(reason);
    let lifetimeMs = adminViewLifetimeMs(options.lifetimeSeconds);
    let requested = options.access ?? "metadata";
    if (!isDeploymentAdmin(this.env, this.adminUserId)) {
      throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    }
    let id: DurableObjectId;
    try {
      id = this.overseers.idFromString(workspaceId);
    } catch {
      throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    }

    // The authoritative config rather than readAdminConfig()'s KV mirror: a mirror still saying
    // "full" after an admin lowered the level must not mint a view at the old one. The view's calls
    // then read the mirror, which reaches them within about a minute.
    let { access, retentionDays } =
        adminAccessPolicy(await this.admin.getAdminConfig(), this.env);
    let expiresAt = new Date(Date.now() + lifetimeMs);
    if (access === "off") {
      // Refused before any workspace is reached, so only the deployment-wide log records it.
      let workspaceTitle = cutAdminAuditText(
          await this.#directoryTitle(id.toString()), MAX_ADMIN_AUDIT_ARG_LENGTH);
      await this.audits.getByName("").append({
        kind: "workspace", at: new Date(), admin: this.adminUserId, sessionId: this.#sessionId,
        via: this.via, workspaceId: id.toString(), workspaceTitle,
        method: "inspectWorkspace", args: { expiresAt: expiresAt.toISOString() }, reason,
        requested, access: "off", exposed: "metadata", refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
      }, retentionDays);
      throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.accessOff);
    }

    // The view runs at the lower of the level asked for and the deployment's. Asking for more than
    // the deployment allows is not refused, and every record of the view keeps what was asked.
    // @ts-expect-error Cap'n Web RPC stubs and native RPC stubs are compatible but the type
    //     system doesn't know this.
    return this.#openForAdmin(id, reason, {
      via: this.via, requested, access: lowerAdminWorkspaceAccess(requested, access), expiresAt,
    });
  }

  // Mint the view. A workspace that turns out not to exist leaves the directory, which lists it
  // only until something finds it gone.
  async #openForAdmin(id: DurableObjectId, reason: string, terms: AdminViewTerms) {
    try {
      return await this.overseers.get(id).openForAdmin(
          this.adminUserId, reason, this.#sessionId, terms);
    } catch (error) {
      if (getAdminAccessErrorCode(error) === ADMIN_ACCESS_ERROR_CODES.workspaceNotFound) {
        try {
          await this.directories.getByName("").removeWorkspace(id.toString());
        } catch (removal) {
          logger.warn("failed to drop a missing workspace from the directory", {
            event: "admin.directory.heal.failed", error: removal,
          });
        }
      }
      throw error;
    }
  }

  // The title the directory lists for a workspace (clamped there to MAX_DIRECTORY_TEXT_LENGTH),
  // for the record of an open refused before it reaches the workspace: "" when the directory lists
  // none or cannot be asked, since the refusal is recorded either way.
  async #directoryTitle(workspaceId: string): Promise<string> {
    try {
      return await this.directories.getByName("").workspaceTitle(workspaceId) ?? "";
    } catch (error) {
      logger.warn("failed to read a workspace's title from the directory", {
        event: "admin.directory.title.failed", error,
      });
      return "";
    }
  }

  async listAdminAudit(options: AdminAuditQuery = {}): Promise<AdminAuditPage> {
    let limit = adminListLimit(options.limit);
    let { kind, admin, workspace, exposed, since, cursor } = options;
    return await this.audits.getByName("").list(
        { kind, admin, workspace, exposed, since, cursor, limit }, await this.#retentionDays());
  }

  async getAdminAuditStats(options: AdminAuditStatsQuery = {}): Promise<AdminAuditStats> {
    let days = adminAuditStatsDays(options.days);
    return await this.audits.getByName("").stats(
        { days, kind: options.kind }, await this.#retentionDays());
  }

  // The retention the authoritative config and the environment give now.
  async #retentionDays(): Promise<number> {
    return adminAccessPolicy(await this.admin.getAdminConfig(), this.env).retentionDays;
  }

  setAdminWorkspaceAccess(access: AdminWorkspaceAccess): Promise<void> {
    if (!isAdminWorkspaceAccess(access)) {
      throw new Error(`Invalid admin workspace access: ${access}`);
    }
    return this.admin.setAdminWorkspaceAccess(access, this.#actor("setAdminWorkspaceAccess"));
  }

  setAdminAuditRetentionDays(days: number): Promise<void> {
    return this.admin.setAdminAuditRetentionDays(days, this.#actor("setAdminAuditRetentionDays"));
  }
}
