// Generated from packages/workshop-shared/src/api.ts by packages/api-schema/scripts/generate.ts -- do not edit.
// The Admin API as the instance admin Gatekeeper serves it to its admin's agent (packages/gatekeeper-instanceadmin), without the methods it withholds.
// Change api.ts and run `pnpm api-schema:generate`.

/**
 * Capability for managing and investigating the deployment, obtained via
 * AuthenticatedApi.getAdminApi() (which is null for non-admins). The access check happens when the
 * capability is minted, so these methods don't re-check, with one exception: inspectWorkspace()
 * re-checks, and so does every call on the AdminWorkspaceView it mints, since a view is the one
 * thing an admin holds that reads users' data. Covers branding, agent instructions, which
 * gatekeeper connectors/resources are offered, the models an AI Gateway deployment provides, the
 * user and workspace directory, and admin access to workspaces — NOT authentication config (that's
 * env-var driven). Each setter throws on invalid input, and records the change it makes in the
 * deployment's audit log before making it (see AdminSettingRecord).
 *
 * A deployment admin's own agent can call these methods as them through the instance admin
 * Gatekeeper (packages/gatekeeper-instanceadmin), in a workspace they turned deployment admin access
 * on in. The Workshop decides what each call may do from ADMIN_AGENT_ACCESS: a read runs at once, a
 * method tagged `@mutates` runs only as an action the admin approves, one tagged `@confirmation` (and
 * an inspection asking for "full") only once they approve that one call, and the rest are withheld.
 * Its audit records say `via` "gatekeeper", with an AdminGatekeeperOrigin.
 */
export interface AdminApi {
  /**
   * Add a model to the ones the deployment provides, listed after its provider's suggested models
   * and 'enabled' by default. Throws if the model is malformed (an empty or over-long ID or name,
   * an over-long `behavesLike`, a token limit that isn't a positive integer), if the gateway does
   * not serve and enable its provider (see AdminSettingsView.gatewayModels), if a suggested or
   * added model already has its ID, if the model runtime does not know its `behavesLike` under
   * its provider, or if what its context window reserves for the response (its output limit, or
   * WORKERS_AI_OUTPUT_LIMIT for a Cloudflare model that gives none) leaves a prompt no room.
   * @mutates
   */
  addGatewayModel(model: Awaitable<GatewayModel>): Promise<void>;
  /**
   * Ask now for the newest release, whether or not automatic update checks are on, and return
   * the status that check produces. Null unless the deploy flow installed this deployment. Throws
   * when the check fails.
   */
  checkForUpdates(): Promise<null | DeploymentUpdateStatus>;
  /**
   * Counts from the admin audit log over the last `days` UTC days, today included (7 by
   * default). Throws unless `days` is a whole number from 1 to MAX_ADMIN_AUDIT_STATS_DAYS.
   */
  getAdminAuditStats(options?: Awaitable<AdminAuditStatsQuery>): Promise<AdminAuditStats>;
  /** Read all admin-managed settings for the admin UI in one call. */
  getSettings(): Promise<AdminSettingsView>;
  /**
   * Whether a newer release is available. Null unless the deploy flow installed this deployment.
   * While automatic update checks are off (see setUpdateChecksEnabled) it asks no one and reports
   * the last check made for the running release, if any.
   */
  getUpdateStatus(): Promise<null | DeploymentUpdateStatus>;
  /**
   * Open a read-only view of a workspace to investigate it (see AdminWorkspaceView). The view runs
   * at the lower of the level `options.access` asks for ("metadata" when absent) and the
   * deployment's level (AdminSettingsView.adminWorkspaceAccess.effective). Asking for "full" where
   * the deployment allows only "metadata" opens the view at "metadata", and its describe() reports
   * that. `reason` is required: it is recorded with the open and with every call made through the
   * view, and is rejected when blank or, once trimmed, longer than MAX_ADMIN_ACCESS_REASON_LENGTH.
   * The open is recorded as an AdminAccessRecord ("inspectWorkspace") before the view is returned,
   * so an open whose record cannot be written is refused.
   *
   * Refused with a code from ADMIN_ACCESS_ERROR_CODES, checked in this order: `notAdmin` once the
   * caller is no longer a deployment admin; `workspaceNotFound` for a malformed id; `accessOff`
   * while the access level is "off", recorded in the deployment-wide log without the workspace
   * being reached; `workspaceNotFound` for an id that names no workspace (never initialised or
   * since deleted), which this neither creates nor claims; `viewExpired` should the view's
   * lifetime run out before the workspace answers. Only `accessOff` refusals are recorded.
   *
   * Admin access is a deliberate exception to observer verification (see docs/observers.md): the
   * admin is never verified against the workspace's connections nor registered as an observer, and
   * the audit log is the compensating control.
   */
  inspectWorkspace(workspaceId: Awaitable<string>, reason: Awaitable<string>, options?: Awaitable<AdminInspectOptions>): Pipelined<AdminWorkspaceView>;
  /**
   * Returns whether the blueprint is featured on the deployment. Returns null when the blueprint
   * can't be featured (e.g. it isn't a listable blueprint).
   */
  isBlueprintFeatured(blueprintId: Awaitable<string>): Promise<boolean | null>;
  /**
   * One page of the deployment-wide admin audit log, newest first: access to workspaces and
   * changes to settings, filtered as `options` says. Rejects a `limit` that is not a whole number
   * from 1 to ADMIN_LIST_MAX_LIMIT, a filter over 1000 characters, and a malformed `cursor`.
   */
  listAdminAudit(options?: Awaitable<AdminAuditQuery>): Promise<AdminAuditPage>;
  /**
   * One page of the deployment's users, in id order: every account that has started a session
   * since the directory began recording accounts. Unaffected by setUserSearchEnabled(). A page
   * holds at most `limit` users and stops early, with a `nextCursor`, once their ids and names
   * would pass a million characters: an id has no length limit of its own, so a count alone cannot
   * bound a page. Rejects a `query` over 1000 characters or with a line break, and a `limit` that
   * is not a whole number from 1 to ADMIN_LIST_MAX_LIMIT.
   */
  listUsers(options?: Awaitable<AdminUserQuery>): Promise<AdminUserPage>;
  /**
   * One page of the deployment's workspaces, in id order: every workspace opened since the
   * directory began recording workspaces, deleted ones left out. A page stops early as
   * listUsers()'s does, counting ids, titles and owners. Rejects what listUsers() rejects.
   */
  listWorkspaces(options?: Awaitable<AdminWorkspaceQuery>): Promise<AdminWorkspacePage>;
  /**
   * Offer a blueprint as a standard format, appended last in menu order. Throws if the blueprint
   * doesn't exist. Promoting one that already is leaves its curation and menu position alone, so
   * that retrying a promotion whose mirror write failed repairs it rather than being refused.
   * @mutates
   */
  promoteFormat(blueprintId: Awaitable<string>): Promise<void>;
  /**
   * Stop offering a blueprint as a standard format, and forget the deployment's curation of it.
   * The blueprint itself is untouched.
   *
   * Refused for a bundled blueprint (see `AdminFormat.bundled`), which the deployment installed
   * and will reinstall: `enabled: false` withdraws it without discarding the admin's overrides,
   * hint and menu position.
   * @mutates
   */
  removeFormat(blueprintId: Awaitable<string>): Promise<void>;
  /**
   * Remove a model added with addGatewayModel(), along with its mode and settings. Throws if no
   * added model has this ID; a suggested model can't be removed, only disabled.
   *
   * Removing frees the ID rather than reserving it. The chats, spawners and preferences that name
   * the model resolve again if a model is later added under the same ID. A gadget model binding
   * minted for it carries its own provider and model, so while users may add their own models
   * (see setUserModelsEnabled) it runs once the model is removed, even if the model was disabled.
   * To shut a model off, disable it instead.
   * @mutates
   */
  removeGatewayModel(modelId: Awaitable<string>): Promise<void>;
  /**
   * Set the deployment accent color (hex, e.g. "#3b82f6"). Pass "" to reset to the default theme.
   * Rejects an invalid hex color.
   * @mutates
   */
  setAccentColor(color: Awaitable<string>): Promise<void>;
  /**
   * Set the top-bar notice (centered text in the top navigation bar). Pass "" to clear. Rejects over
   * MAX_ANNOUNCEMENT_LENGTH.
   * @mutates
   */
  setAnnouncement(text: Awaitable<string>): Promise<void>;
  /**
   * Set the full-width banner. Pass an empty text to hide it. Rejects over MAX_ANNOUNCEMENT_LENGTH or
   * an invalid color.
   * @mutates
   */
  setBanner(text: Awaitable<string>, color: Awaitable<BannerColor>): Promise<void>;
  /**
   * Mark or unmark a blueprint as featured on the deployment.
   * @mutates
   */
  setBlueprintFeatured(blueprintId: Awaitable<string>, featured: Awaitable<boolean>): Promise<void>;
  /**
   * Set the reasoning level of every gateway model that has none of its own, or null for each
   * model's built-in behaviour. It never applies to a model a user added.
   * @mutates
   */
  setDefaultReasoning(level: Awaitable<"high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh" | null>): Promise<void>;
  /**
   * Reorder the menu. `blueprintIds` must be a permutation of the currently promoted ids.
   * @mutates
   */
  setFormatOrder(blueprintIds: Awaitable<string[]>): Promise<void>;
  /**
   * Set a gatekeeper's availability. For an auto-provisioning ("ambient") gatekeeper, `mode` is the
   * full three-state (disabled / optional / enabled); for an ordinary gatekeeper only 'disabled' /
   * 'enabled' are valid ('optional' is rejected). Soft enforcement: it doesn't revoke a capability a
   * gadget already holds, and 'disabled' leaves an ambient account's data dormant rather than deleting
   * it.
   * @mutates
   */
  setGatekeeperMode(vendorId: Awaitable<string>, mode: Awaitable<"disabled" | "enabled" | "optional">): Promise<void>;
  /**
   * Set how the deployment offers one of its gateway models (see GatewayModelMode). Setting the
   * model's default mode forgets the override, so the model follows its default from then on.
   * Throws if `modelId` is not one of the deployment's gateway models.
   *
   * 'disabled' revokes nothing that is stored: the chats, spawners, preferences and gadget model
   * bindings that name the model keep naming it, and stop resolving for as long as it is disabled.
   * @mutates
   */
  setGatewayModelMode(modelId: Awaitable<string>, mode: Awaitable<"disabled" | "enabled" | "hidden">): Promise<void>;
  /**
   * Replace what the deployment sets for one of its gateway models (see GatewayModelSettings):
   * a field left out of `settings` is unset, and an empty `settings` unsets everything. Throws
   * if `modelId` is not one of the deployment's gateway models, or if the compaction budget is
   * not a positive whole number within the model's maximum (see
   * AdminModelView.maxCompactionInputBudget).
   *
   * The reasoning level may be one the model lacks, since it is fitted to the model when a
   * request is made (see ReasoningLevel).
   * @mutates
   */
  setGatewayModelSettings(modelId: Awaitable<string>, settings: Awaitable<GatewayModelSettings>): Promise<void>;
  /**
   * Turn a provider on or off beside the ones CF_AI_GATEWAY_PROVIDERS lists. On is the same as
   * listing it there: its suggested models appear in their default modes, models can be added
   * under it, and so can users' own while those are allowed. Throws for a provider the gateway
   * does not serve, and when turning off one that the variable lists: it is a floor, which an
   * admin adds to.
   *
   * Off takes the provider's models out of the deployment's and deletes nothing: their modes and
   * settings, and the models added under the provider, are kept for when it is back on. It stops
   * neither a model a user already added under the provider nor a gadget model binding already
   * minted for one of its models, which setUserModelsEnabled(false) does.
   * @mutates
   */
  setGatewayProviderEnabled(provider: Awaitable<AiModelProvider>, enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Replace the agent system-prompt instructions. Pass "" to clear. Rejects over
   * MAX_INSTANCE_INSTRUCTIONS_LENGTH.
   * @mutates
   */
  setInstanceInstructions(text: Awaitable<string>): Promise<void>;
  /**
   * Set whether the admin UI may suggest models from models.dev while an admin adds one. Off by
   * default.
   *
   * The admin's browser reads the setting and, with it on, downloads models.dev's public model
   * list while an admin adds a model, to fill in the add-model form. It changes nothing the server
   * does: the server never contacts models.dev, and addGatewayModel() validates a suggested model
   * like any other.
   * @mutates
   */
  setModelsDevSuggestions(enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Enable or disable a single gatekeeper resource type, keyed by vendor id + resource urlPattern.
   * Soft enforcement: disabling hides the resource from the connect UI, the resource picker, and the
   * agent; it doesn't revoke a capability a gadget already holds.
   * @mutates
   */
  setResourceEnabled(vendorId: Awaitable<string>, urlPattern: Awaitable<string>, enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Enable or disable new account signups. Existing users can still log in while signups are
   * closed.
   * @mutates
   */
  setSignupsEnabled(enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Set the site name shown next to the top-bar logo. Pass "" to reset to DEFAULT_SITE_NAME.
   * Rejects over MAX_SITE_NAME_LENGTH.
   * @mutates
   */
  setSiteName(name: Awaitable<string>): Promise<void>;
  /**
   * Set how many minutes a successful update check is relied on before the deployment asks again,
   * DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES by default. A failed check is retried after the interval
   * or 15 minutes, whichever is shorter. The deployment asks only while an admin is using it
   * (getUpdateStatus() makes the check when one is due), never on a schedule of its own. Throws
   * unless `minutes` is a whole number from 1 to MAX_UPDATE_CHECK_INTERVAL_MINUTES.
   * @mutates
   */
  setUpdateCheckIntervalMinutes(minutes: Awaitable<number>): Promise<void>;
  /**
   * Set whether the deployment checks for updates by itself. On by default. When off,
   * getUpdateStatus() makes no outbound call and admins are never notified; checkForUpdates()
   * still asks.
   * @mutates
   */
  setUpdateChecksEnabled(enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Set how many hours a newer release must have been available before admins are notified of
   * it, DEFAULT_UPDATE_MINIMUM_AGE_HOURS by default. It delays the notice only: an update always
   * installs the newest release. 0 notifies as soon as a check reports an update. Throws unless
   * `hours` is a whole number from 0 to MAX_UPDATE_HOURS.
   * @mutates
   */
  setUpdateMinimumAgeHours(hours: Awaitable<number>): Promise<void>;
  /**
   * Set how many hours a dismissed update notice stays hidden in the browser that dismissed it,
   * DEFAULT_UPDATE_NOTICE_SNOOZE_HOURS by default. 0 means a closed notice comes back on the next
   * visit to Home. Throws unless `hours` is a whole number from 0 to MAX_UPDATE_HOURS.
   * @mutates
   */
  setUpdateNoticeSnoozeHours(hours: Awaitable<number>): Promise<void>;
  /**
   * Set whether users may add models of their own, which run through the deployment's gateway
   * like the models it provides. On by default.
   *
   * Off makes the deployment's models the only ones: a user can't add or edit a model, and the
   * models users added are neither listed nor resolved. A gadget model binding stops at its next
   * call unless a gateway model has its provider and model. Nothing stored is deleted, so the
   * models users added work again once this is back on.
   * @mutates
   */
  setUserModelsEnabled(enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Enable or disable user directory search. The directory itself is maintained
   * either way, and this switch just controls user access.
   * @mutates
   */
  setUserSearchEnabled(enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Send one request to a gateway model the way a chat turn would, through the gateway, as the
   * admin, and report what happened within 30 seconds. The request asks for the reasoning level
   * in effect for the model (its own, else the deployment's default, else what BuiltInReasoning
   * describes), with the capabilities stated for it and the flags of the model it behaves like,
   * under a response cap of at most 2,048 tokens. A level that a model takes as a token budget
   * comes out of that cap, so it is cut to the room the cap leaves and is smaller than a chat's.
   * It works on a model in any mode, hidden and disabled included, and changes nothing. Throws
   * outside AI Gateway mode and for an ID that names no gateway model; a request that fails is a
   * result (see GatewayModelTest).
   *
   * A pass says that the model answered that one request. It costs more than
   * testGatewayProvider(), whose quick request is capped at a few tokens.
   * @confirmation Sends a request of up to 2,048 response tokens through the deployment's AI Gateway, which its provider bills.
   */
  testGatewayModel(modelId: Awaitable<string>): Promise<GatewayModelTest>;
  /**
   * Send one small request to the first of a provider's SUGGESTED_MODELS through the gateway, as
   * the admin, and report what happened within 15 seconds: the Workshop can't see which provider
   * keys the gateway holds. It works on a provider that is off, and changes nothing. Throws for
   * a provider the gateway does not serve; a request that fails is a result (see
   * GatewayModelTest).
   *
   * A pass says that one model answered once. A 401 or 403 does not tell a provider key the
   * gateway lacks from a CF_AI_GATEWAY_API_TOKEN that may not run models. The request is a
   * quick one that takes none of a model's settings: testGatewayModel() sends a model the
   * request its chats would.
   * @confirmation Sends a request through the deployment's AI Gateway, which its provider bills.
   */
  testGatewayProvider(provider: Awaitable<AiModelProvider>): Promise<GatewayModelTest>;
  /**
   * Test a model as described, without adding it. It sends one request the way a chat turn would
   * with no reasoning level set (so asking for what BuiltInReasoning describes, whatever the
   * deployment's default level is), and one at each reasoning level the model would list once
   * added (see AdminModelView.reasoningLevels). The requests are sent together, through the
   * gateway, as the admin, each under testGatewayModel()'s response cap and time limit. The
   * results come with the request that set no level first, then the levels from least to most.
   * It stores nothing. Throws outside AI Gateway mode and for a model addGatewayModel() would
   * refuse, for the same reason; a request that fails is a result (see GatewayModelLevelTest).
   *
   * A pass says that the model answered that one request. A model that lists every level is sent
   * eight requests, each of which may use the whole response cap.
   * @confirmation Sends up to eight requests of up to 2,048 response tokens each through the deployment's AI Gateway, which their provider bills.
   */
  testNewGatewayModel(model: Awaitable<GatewayModel>): Promise<GatewayModelLevelTest[]>;
  /**
   * Update one promoted format. Only the provided fields change. `agentHint: ""` clears the hint;
   * an `overrides` field set to null reverts that field to the blueprint's own declaration.
   * @mutates
   */
  updateFormat(blueprintId: Awaitable<string>, patch: Awaitable<AdminFormatPatch>): Promise<void>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

/**
 * A deployment admin's read-only view of one workspace, minted by AdminApi.inspectWorkspace().
 * Nothing it does changes the workspace or is seen by its members: it joins no presence and no
 * session count, and starts no agent or connection.
 *
 * Each call first passes three checks, refused unrecorded with a code from
 * ADMIN_ACCESS_ERROR_CODES: the view has not expired (`viewExpired`), its admin is still a
 * deployment admin (`notAdmin`), and the workspace still exists (`workspaceNotFound`). It then
 * runs at an access level: the view's own, fixed when it was minted at the lower of the level its
 * open asked for (AdminInspectOptions.access) and the deployment's, then lowered to the
 * deployment's current setting. So lowering the setting reaches live views (within about a minute)
 * and raising it does not. A call that level refuses is recorded and refused, having read nothing:
 * `accessOff` once the setting is "off", `contentWithheld` for getChat() or readFile() below
 * "full". Any other call reads its answer, never through a connection. It is then recorded as an
 * AdminAccessRecord, with what that answer exposed, in the workspace and then in the
 * deployment-wide log. Only then is the call answered: nothing it read leaves the server before
 * both records exist, and a call whose record cannot be written fails and returns nothing. The
 * checks run again once the call has read the deployment's setting, and again once it has read its
 * answer, just before it writes. So a call that expiry, a demotion or the workspace's deletion
 * overtakes while it reads writes nothing. A call whose read fails is recorded as an attempt that
 * exposed nothing, and fails with the read's error.
 *
 * A workspace restart (a revocation, a deletion, a redeploy) ends the view along with every other
 * session on the workspace; inspect again.
 */
export interface AdminWorkspaceView {
  /**
   * The workspace's metadata, owner, workpieces and collaborators, with the level this call ran
   * at and the view's expiry.
   */
  describe(): Promise<AdminWorkspaceDescription>;
  /**
   * One page of a chat's messages, as Overseer.getChatHistory() pages them. Content: refused below
   * "full".
   */
  getChat(chatId: Awaitable<number>, beforeSequence?: Awaitable<number>): Promise<AiChatHistoryPage>;
  /** The workspace's operational state, with its most recent admin access records. */
  getDiagnostics(): Promise<AdminWorkspaceDiagnostics>;
  /**
   * One page of the workspace's action log, as Overseer.listActions() pages it. Admin access is
   * never in it (see AdminAccessRecord). Below "full", every action, observation and hook entry has
   * an empty `description.description` and no `description.fields`: titles, states, resources and
   * times remain.
   */
  listActions(options?: Awaitable<{
    beforeId?: number;
    filter?: ActionHistoryFilter;
  }>): Promise<ActionHistoryPage>;
  /**
   * The workspace's chats, newest first, as Overseer.listChats() lists them; below "full", without
   * `queuedSteers`, which hold message text.
   */
  listChats(): Promise<AiChatMetadata[]>;
  /**
   * The tree of a gadget's committed head, as Overseer.listTree() gives it, read only from the
   * objects the workspace stores: it never pulls through a connection, and throws when an object
   * is missing. Only a permanent gadget has a head to read: throws for a pending gadget, a
   * worktree, or an id that names no gadget.
   */
  listFiles(gadgetId: Awaitable<number>): Promise<TreeNode[]>;
  /** The workspace's connections, oldest first, with their bindings and hooks. */
  listGatekeepers(): Promise<AdminGatekeeperInfo[]>;
  /**
   * One file of a gadget's committed head, as Overseer.readFilesAtCommit() reports it, read as
   * listFiles() reads and refused as it is. Content: refused below "full".
   */
  readFile(gadgetId: Awaitable<number>, path: Awaitable<string>): Promise<FileAtCommit>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

export type ActionDescription = {
  actionKind?: ActionKind;
  autoApprovable?: boolean;
  awaitDecision?: boolean;
  description: string;
  descriptionIsComplete?: boolean;
  fields?: ActionField[];
  implementsRevert: boolean;
  pushedCommits?: string[];
  title: string;
};

export type ActionField = {
  items: string[];
  kind: "list";
  label: string;
  truncated?: {
    shownBytes: number;
    totalBytes: number;
  };
} | {
  kind: "file";
  label: string;
  mediaType: string;
  name: string;
  origin: "agent" | "provider";
  sha256?: string;
  size: number;
  truncated?: {
    shownBytes: number;
    totalBytes: number;
  };
} | {
  kind: "inline";
  label: string;
  truncated?: {
    shownBytes: number;
    totalBytes: number;
  };
  value: string;
} | {
  kind: "json";
  label: string;
  truncated?: {
    shownBytes: number;
    totalBytes: number;
  };
  value: string;
} | {
  kind: "text";
  label: string;
  syntax?: ActionFieldSyntax;
  truncated?: {
    shownBytes: number;
    totalBytes: number;
  };
  value: string;
};

export type ActionFieldSyntax = "html" | "markdown" | "sql";

export type ActionHistoryFilter = "action" | "all" | "bindHook" | "observation" | "pending";

export type ActionHistoryPage = {
  entries: ActionLogEntry[];
  nextBeforeId?: number;
};

export type ActionKind = {
  label: string;
  tag: string;
};

export type ActionLogEntry = {
  appliedAt?: Date;
  autoApproved?: boolean;
  createdAt: Date;
  creation?: true;
  description: ActionDescription;
  gatekeeperId?: number;
  id: number;
  resolvedBy?: AiChatAuthorInfo;
  resourceTitle: string;
  resourceUrl?: string;
  state: ActionState;
  type: "action";
} | {
  appliedAt?: Date;
  createdAt: Date;
  description: HookDescription;
  enabled: boolean;
  gatekeeperId?: number;
  hookId?: number;
  id: number;
  resourceTitle: string;
  resourceUrl?: string;
  state: ActionState;
  type: "bindHook";
} | {
  appliedAt?: Date;
  createdAt: Date;
  description: ObservationDescription;
  gatekeeperId?: number;
  id: number;
  resourceTitle: string;
  resourceUrl?: string;
  state: ActionState;
  type: "observation";
};

export type ActionState = "approved" | "pending" | "rejected";

export type AdminAccessExposure = "content" | "metadata";

export type AdminAccessRecord = {
  access: "full" | "metadata" | "off";
  admin: string;
  args: {
    [key: string]: number | string;
  };
  at: Date;
  exposed: AdminAccessExposure;
  kind: "workspace";
  method: "describe" | "getChat" | "getDiagnostics" | "inspectWorkspace" | "listActions" | "listChats" | "listFiles" | "listGatekeepers" | "readFile";
  origin?: AdminGatekeeperOrigin;
  reason: string;
  refused?: "ADMIN_CONTENT_WITHHELD" | "ADMIN_WORKSPACE_ACCESS_OFF";
  requested: AdminViewAccess;
  sessionId: string;
  via: AdminVia;
  workspaceId: string;
  workspaceTitle: string;
};

export type AdminAuditPage = {
  nextCursor?: string;
  records: AdminAuditRecord[];
};

export type AdminAuditQuery = {
  admin?: string;
  cursor?: string;
  exposed?: AdminAccessExposure;
  kind?: "setting" | "workspace";
  limit?: number;
  since?: Date;
  via?: AdminVia;
  workspace?: string;
};

export type AdminAuditRecord = AdminAccessRecord | AdminSettingRecord;

export type AdminAuditStats = {
  byDay: {
    count: number;
    day: string;
  }[];
  contentReads: number;
  days: number;
  topAdmins: {
    admin: string;
    count: number;
  }[];
  topAdminsByContentReads: {
    admin: string;
    count: number;
  }[];
  topWorkspaces: {
    count: number;
    title: string;
    workspaceId: string;
  }[];
  topWorkspacesByContentReads: {
    count: number;
    title: string;
    workspaceId: string;
  }[];
  totalEvents: number;
};

export type AdminAuditStatsQuery = {
  days?: number;
  kind?: "setting" | "workspace";
};

export type AdminFormat = {
  agentHint: string;
  blueprintDescription: string;
  blueprintId: string;
  blueprintTitle: string;
  bundled: boolean;
  declared?: BlueprintOutput;
  enabled: boolean;
  missing: boolean;
  output?: BlueprintOutput;
  overrides?: {
    icon?: "appWindow" | "chartBar" | "fileText" | "flowArrow" | "gridNine" | "kanban" | "listChecks" | "notebook" | "presentation" | "table";
    id?: string;
    noun?: string;
    plural?: string;
  };
};

export type AdminFormatPatch = {
  agentHint?: string;
  enabled?: boolean;
  overrides?: {
    icon?: "appWindow" | "chartBar" | "fileText" | "flowArrow" | "gridNine" | "kanban" | "listChecks" | "notebook" | "presentation" | "table" | null;
    id?: null | string;
    noun?: null | string;
    plural?: null | string;
  };
};

export type AdminGatekeeperInfo = {
  bindings: {
    chatId?: number;
    gadgetId: number;
    name: string;
  }[];
  creationSpec?: GatekeeperCreationSpec;
  hooks: BoundHookInfo[];
  id: number;
  resourceTitle?: string;
  resourceUrl?: string;
  vendorId?: string;
};

export type AdminGatekeeperOrigin = {
  actionId?: number;
  chatId: number;
  workspaceId: string;
};

export type AdminGatewayProvider = {
  enabledBy?: "admin" | "environment";
  needsApiToken: boolean;
  provider: AiModelProvider;
};

export type AdminInspectOptions = {
  access?: AdminViewAccess;
  lifetimeSeconds?: number;
};

export type AdminModelView = {
  added: boolean;
  behavesLike?: string;
  behavesLikeKnown?: boolean;
  builtInCompactionInputBudget: number;
  builtInReasoning: BuiltInReasoning;
  capabilities?: GatewayModelCapabilities;
  contextWindow: number;
  defaultMode: "disabled" | "enabled" | "hidden";
  id: string;
  maxCompactionInputBudget: number;
  mode: "disabled" | "enabled" | "hidden";
  name: string;
  outputLimit?: number;
  provider: AiModelProvider;
  reasoningLevels: ("high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh")[];
  runtimeKnown: boolean;
  settings?: GatewayModelSettings;
};

export type AdminResource = {
  description: string;
  enabled: boolean;
  icon?: AvatarImage;
  title: string;
  urlPattern: string;
};

export type AdminResourceVendor = {
  ambientMode: "disabled" | "enabled" | "optional";
  autoProvisions: true;
  displayName: string;
  logo?: AvatarImage;
  vendorId: string;
} | {
  autoProvisions: false;
  displayName: string;
  enabled: boolean;
  logo?: AvatarImage;
  resources: AdminResource[];
  vendorId: string;
};

export type AdminSettingChange = {
  after?: string;
  before?: string;
  excerpt?: {
    afterLength?: number;
    beforeLength?: number;
    offset: number;
  };
  key?: string;
  setting: string;
};

export type AdminSettingRecord = {
  admin: string;
  at: Date;
  changes: AdminSettingChange[];
  kind: "setting";
  method: "addGatewayModel" | "promoteFormat" | "removeFormat" | "removeGatewayModel" | "setAccentColor" | "setAdminAuditRetentionDays" | "setAdminWorkspaceAccess" | "setAnnouncement" | "setBanner" | "setBlueprintFeatured" | "setDefaultReasoning" | "setFormatOrder" | "setGatekeeperMode" | "setGatewayModelMode" | "setGatewayModelSettings" | "setGatewayProviderEnabled" | "setInstanceInstructions" | "setModelsDevSuggestions" | "setResourceEnabled" | "setSignupsEnabled" | "setSiteLogo" | "setSiteName" | "setUpdateCheckIntervalMinutes" | "setUpdateChecksEnabled" | "setUpdateMinimumAgeHours" | "setUpdateNoticeSnoozeHours" | "setUserModelsEnabled" | "setUserSearchEnabled" | "updateFormat";
  origin?: AdminGatekeeperOrigin;
  sessionId: string;
  via: AdminVia;
};

export type AdminSettingsView = {
  accentColor: string;
  adminAuditRetentionDays: {
    chosen: number;
    effective: number;
    min: number;
  };
  adminWorkspaceAccess: {
    chosen: "full" | "metadata" | "off";
    effective: "full" | "metadata" | "off";
    max: "full" | "metadata" | "off";
  };
  announcement: string;
  banner: BannerConfig;
  formats: AdminFormat[];
  gatewayModels?: {
    defaultReasoning: "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh" | null;
    models: AdminModelView[];
    modelsDevSuggestions: boolean;
    providerSettings: AdminGatewayProvider[];
    providers: AiModelProvider[];
    userModelsEnabled: boolean;
  };
  instanceInstructions: string;
  resourceVendors: AdminResourceVendor[];
  signupsEnabled: boolean;
  siteLogo?: AvatarImage;
  siteName: string;
  userSearchEnabled: boolean;
};

export type AdminUserPage = {
  nextCursor?: string;
  users: AdminUserRecord[];
};

export type AdminUserQuery = {
  cursor?: string;
  limit?: number;
  query?: string;
};

export type AdminUserRecord = {
  created?: Date;
  id: string;
  isAdmin: boolean;
  lastLogin?: Date;
  name: string;
};

export type AdminVia = "api" | "cli" | "gatekeeper";

export type AdminViewAccess = "full" | "metadata";

export type AdminWorkspaceDescription = {
  access: AdminViewAccess;
  collaborators: CollaboratorInfo[];
  containsRestrictedData?: boolean;
  defaultGadgetId?: number;
  deploymentAdminAccess?: "off" | "on";
  expiresAt: Date;
  id: string;
  owner: AiChatAuthorInfo;
  ownerInvitesOnly?: boolean;
  title: string;
  totalCost?: number;
  workpieces: WorkpieceSummary[];
};

export type AdminWorkspaceDiagnostics = {
  activeAgentChatIds: number[];
  chats: number;
  hooks: {
    enabled: number;
    total: number;
  };
  instanceStartedAt: Date;
  nextAlarm?: Date;
  observers: number;
  ownerRegistrationPending: boolean;
  pendingActions: number;
  pendingAgentCalls: number;
  recentAdminAccess: AdminAccessRecord[];
  sessions: {
    build: number;
    owner: number;
    use: number;
  };
  storageVersion: number;
};

export type AdminWorkspacePage = {
  nextCursor?: string;
  workspaces: AdminWorkspaceRecord[];
};

export type AdminWorkspaceQuery = {
  cursor?: string;
  limit?: number;
  owner?: string;
  query?: string;
};

export type AdminWorkspaceRecord = {
  created?: Date;
  id: string;
  lastActive?: Date;
  owner: UserDirectoryRecord;
  title: string;
};

export type AgentCatalog = {
  entries: AgentCatalogEntry[];
  truncated?: boolean;
};

export type AgentCatalogEntry = {
  description: string;
  id: string;
  title: string;
};

export type AgentSpawnerConfig = {
  displayName: string;
  env: {
    [key: string]: number;
  };
  modelId: null | string;
};

export type AiChatAuthorInfo = {
  commitEmail?: string;
  id: string;
  name: string;
  type: "agent" | "gadget" | "user";
};

export type AiChatHistoryPage = {
  compacted?: {
    proposedChange?: CodeChange;
    summary: string;
    to: number;
  };
  messages: AiChatMessage[];
};

export type AiChatMessage = {
  actionId: number;
  actionLog?: ActionLogEntry;
  author: AiChatAuthorInfo;
  chatId: number;
  sequence: number;
  timestamp: Date;
  type: "action";
} | {
  addedBindings?: {
    gadgetId: number;
    name: string;
    target: number;
  }[];
  author: AiChatAuthorInfo;
  blueprintMerges?: BlueprintMerge[];
  change?: CodeChange;
  chatId: number;
  conversionBoundary?: true;
  createdGadgets?: {
    bindingName: string;
    gadgetId: number;
    title: string;
  }[];
  createdWorktrees?: {
    bindingName: string;
    title: string;
    worktreeId: number;
  }[];
  mainlineMerge?: {
    conflictPaths: string[];
    gadgets?: MainlineMergeGadget[];
  };
  observedCodeVersion?: number;
  pins?: ChatGadgetPinRecord[];
  sequence: number;
  timestamp: Date;
  type: "changes";
  watermark?: {
    changesGeneration: number;
    throughRevision: number;
  };
  worktreeCommits?: {
    commit: string;
    previousHead: string;
    worktreeId: number;
  }[];
} | {
  argsSummary: string;
  author: AiChatAuthorInfo;
  bindingName?: string;
  chatId: number;
  methodName: string;
  sequence: number;
  timestamp: Date;
  type: "agentCallback";
} | {
  attachments?: ChatAttachmentRef[];
  author: AiChatAuthorInfo;
  capsules?: CapsuleSpecifier[];
  chatId: number;
  formats?: MessageFormatRef[];
  generatedBySlashCommandSequence?: number;
  message: string;
  reasoning?: string;
  sequence: number;
  steered?: true;
  timestamp: Date;
  toolCalls?: AiToolCall[];
  type: "message";
} | {
  author: AiChatAuthorInfo;
  bindingName?: string;
  chatId: number;
  gatekeeperId?: number;
  reason: string;
  requestId: string;
  resourceTitle?: string;
  resourceUrl?: string;
  resourceUrlPattern?: string;
  sequence: number;
  state: "accepted" | "denied" | "pending";
  timestamp: Date;
  type: "connectionRequest";
  vendorId: string;
  vendorLogoUrl?: string;
  vendorName: string;
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  code?: string;
  message: string;
  sequence: number;
  timestamp: Date;
  type: "error";
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  commits: {
    commitId: string;
    gadgetId: number;
  }[];
  epochBoundary?: true;
  mergeThrough: number;
  sequence: number;
  timestamp: Date;
  type: "merge";
  version?: number;
  worktreePins?: {
    baseCommit: string;
    worktreeId: number;
  }[];
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  request: SlashCommandRequest;
  sequence: number;
  skillName?: string;
  timestamp: Date;
  type: "slashCommand";
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  resources: AlwaysAvailableResource[];
  sequence: number;
  timestamp: Date;
  type: "catalogChange";
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  revertFrom: number;
  sequence: number;
  timestamp: Date;
  type: "revert";
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  sequence: number;
  text: string;
  timestamp: Date;
  type: "agentNudge";
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  sequence: number;
  timestamp: Date;
  type: "useGadget";
};

export type AiChatMetadata = {
  activeAgent?: AiChatAuthorInfo;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  codeBase?: ChatCodeBase;
  compactedTo?: number;
  id: number;
  lastActive: Date;
  promptTokens?: number;
  proposedChangeWorkpieces?: number[];
  queuedSteers?: {
    author: AiChatAuthorInfo;
    text: string;
  }[];
  spawnerName?: string;
  started: Date;
  title: string;
  totalCost?: number;
  totalTokens?: number;
};

export type AiModelProvider = "anthropic" | "cloudflare" | "google" | "ollama" | "openai";

export type AiToolCall = {
  error?: string;
  input: {
    bindingName: string;
    blueprintId?: string;
    title: string;
  };
  observedCodeVersion?: number;
  output?: {
    blueprintNotes?: string;
    changeId?: number;
    gadgetId: number;
  };
  toolCallId: string;
  toolName: "createGadget";
} | {
  error?: string;
  input: {
    bindingName: string;
    capsuleId: number;
  };
  observedCodeVersion?: number;
  toolCallId: string;
  toolName: "saveCapsuleAsBinding";
} | {
  error?: string;
  input: {
    bindingName: string;
    commitId: string;
    title: string;
  };
  observedCodeVersion?: number;
  output?: {
    baseCommit: string;
    changeId?: number;
    worktreeId: number;
  };
  toolCallId: string;
  toolName: "createWorktree";
} | {
  error?: string;
  input: {
    bindingName: string;
    entrypoint: null | string;
  };
  observedCodeVersion?: number;
  toolCallId: string;
  toolName: "setBindingHook";
} | {
  error?: string;
  input: {
    bindingName: string;
    resourceUrlPattern: string;
    title: string;
    vendorId: string;
  };
  observedCodeVersion?: number;
  output?: {
    gatekeeperId: number;
  };
  toolCallId: string;
  toolName: "createExternalResource";
} | {
  error?: string;
  input: {
    bindingName?: string;
    reason: string;
    resourceUrl?: string;
    vendorId: string;
  };
  observedCodeVersion?: number;
  output?: string;
  toolCallId: string;
  toolName: "requestConnection";
} | {
  error?: string;
  input: {
    code: string;
  };
  observedCodeVersion?: number;
  output?: string;
  toolCallId: string;
  toolName: "executeCode";
} | {
  error?: string;
  input: {
    content: string;
    filename: string;
    workpiece?: string;
  };
  observedCodeVersion?: number;
  toolCallId: string;
  toolName: "writeFile";
} | {
  error?: string;
  input: {
    error: string;
  };
  observedCodeVersion?: number;
  toolCallId: string;
  toolName: "giveUp";
} | {
  error?: string;
  input: {
    filename: string;
    lineCount?: number;
    startLine?: number;
    workpiece?: string;
  };
  observedCodeVersion?: number;
  observedCommit?: string;
  observedOid?: string;
  toolCallId: string;
  toolName: "readFile";
} | {
  error?: string;
  input: {
    filename: string;
    replacement: string;
    textToReplace: string;
    workpiece?: string;
  };
  observedCodeVersion?: number;
  toolCallId: string;
  toolName: "editFile";
} | {
  error?: string;
  input: {
    gadget: string;
    name?: string;
    source: string;
  };
  observedCodeVersion?: number;
  output?: {
    changeId: number;
    gadgetId: number;
    name: string;
    target: number;
  };
  toolCallId: string;
  toolName: "setGadgetBinding";
} | {
  error?: string;
  input: {
    gadget?: string;
    name: number | string;
  };
  observedCodeVersion?: number;
  output?: string;
  toolCallId: string;
  toolName: "describeBinding";
} | {
  error?: string;
  input: {
    path?: string;
    pattern: string;
    workpiece: string;
  };
  observedCodeVersion?: number;
  output?: string;
  toolCallId: string;
  toolName: "grep";
} | {
  error?: string;
  input: {
    raw?: boolean;
    url: string;
  };
  observedCodeVersion?: number;
  output?: string;
  toolCallId: string;
  toolName: "webFetch";
} | {
  error?: string;
  input: {
    vendorId: string;
  };
  observedCodeVersion?: number;
  output?: string;
  toolCallId: string;
  toolName: "listConnectableResources";
} | {
  error?: string;
  input: {};
  observedCodeVersion?: number;
  output?: string;
  toolCallId: string;
  toolName: "listBlueprints";
} | {
  error?: string;
  input: {};
  observedCodeVersion?: number;
  toolCallId: string;
  toolName: "observeUserChanges";
};

export type AlwaysAvailableResource = {
  catalog: null | AgentCatalog;
  name: string;
  title: string;
};

export type AvatarImage = {
  url: string;
};

export type BannerColor = "brand" | "danger" | "info" | "neutral" | "success" | "warning";

export type BannerConfig = {
  color: BannerColor;
  text: string;
};

export type BlueprintBinding = {
  description: string;
  env: {
    [key: string]: SpawnerEnvTarget;
  };
  spawnerOnly?: true;
  suggestedModel?: null | {
    modelName: string;
    provider: string;
  };
  title: string;
  type: "agentSpawner";
} | {
  description: string;
  gatekeeperName: string;
  resourceUrl?: string;
  spawnerOnly?: true;
  title: string;
  type: "gatekeeper";
  typeUrlPattern: string;
} | {
  description: string;
  modelKind?: ModelKind;
  spawnerOnly?: true;
  suggestedModel?: {
    modelName: string;
    provider: string;
  };
  title: string;
  type: "aiModel";
};

export type BlueprintMerge = {
  baseCommit?: string;
  blueprintId: string;
  commitId: string;
  conflictPaths: string[];
  gadgetId: number;
  kind: "fastForward" | "follow" | "merge";
  missingBindings?: {
    [key: string]: BlueprintBinding;
  };
  title: string;
  unverifiedBase?: true;
  version: number;
};

export type BlueprintOutput = {
  icon: "appWindow" | "chartBar" | "fileText" | "flowArrow" | "gridNine" | "kanban" | "listChecks" | "notebook" | "presentation" | "table";
  id: string;
  noun: string;
  plural: string;
};

export type BoundHookInfo = {
  description: HookDescription;
  enabled: boolean;
  gadgetId: number;
  gatekeeperId: number;
  id: number;
  resourceTitle?: string;
  resourceUrl?: string;
};

export type BuiltInReasoning = "adaptive" | "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh" | null;

export type BytesRef = {
  byteLength: number;
  oid: string;
};

export type CapsuleSpecifier = {
  bindingName?: string;
  description: ResourceDescription;
  gatekeeperId: number;
  length: number;
  position: number;
  vendorId?: string;
};

export type ChatAttachmentRef = {
  content?: Uint8Array;
  id: string;
  mimeType: string;
  name?: string;
  oid?: string;
  size: number;
  workspacePath?: string;
};

export type ChatCodeBase = {
  epoch?: number;
  generation: number;
  pins: ChatGadgetPinState[];
  prior?: {
    discontinuousGadgets: number[];
    finalRevision: number;
    generation: number;
  };
  revision: number;
};

export type ChatGadgetPinRecord = {
  baseCommit: string;
  gadgetId: number;
  mergedCommit?: string;
};

export type ChatGadgetPinState = {
  baseCommit: string;
  gadgetId: number;
  mergedCommit: string;
};

export type CodeChange = {
  [key: string]: [string, FileChange][];
};

export type CollaboratorInfo = {
  addedBy: PermissionEdge[];
  profile: AiChatAuthorInfo;
  role?: CollaboratorRole;
};

export type CollaboratorRole = "build" | "use";

export type DeploymentUpdateStatus = {
  availableSince?: Date;
  checkIntervalMinutes: number;
  checkedAt?: Date;
  checksEnabled: boolean;
  currentReleaseId: string;
  latestReleaseId?: string;
  minimumAgeHours: number;
  modified: boolean;
  modifiedWorkers: string[];
  noticeSnoozeHours: number;
  notify: boolean;
  unfinishedWorkers: string[];
  updateAvailable: boolean;
  updateUrl: string;
};

export type FileAtCommit = {
  kind: "absent";
} | {
  kind: "text";
  text: string;
} | {
  kind: "unreadable";
  message: string;
};

export type FileChange = {
  edit: (number | [number, ...string[]])[];
} | {
  remove: true;
} | {
  set: string;
} | {
  setBytes: BytesRef;
};

export type GadgetSummary = {
  chatId?: number;
  commitId?: string;
  id: number;
  output?: BlueprintOutput;
  title: string;
  type: "gadget";
  upstream?: GadgetUpstream;
};

export type GadgetUpstream = {
  blueprintId?: string;
  commitId?: string;
};

export type GatekeeperCreationSpec = {
  accountId: number;
  type: "ambient";
  vendorId: string;
} | {
  config: AgentSpawnerConfig;
  modelName?: string;
  modelProvider?: string;
  type: "agentSpawner";
} | {
  modelId: string;
  modelName: string;
  provider: string;
  type: "aiModel";
} | {
  resourceUrl?: string;
  type: "gatekeeper";
  typeUrlPattern: string;
  vendorId: string;
};

export type GatewayModel = {
  behavesLike?: string;
  capabilities?: GatewayModelCapabilities;
  contextWindow: number;
  id: string;
  name: string;
  outputLimit?: number;
  provider: AiModelProvider;
};

export type GatewayModelCapabilities = {
  imageInput?: boolean;
  reasoningLevels?: ("high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh")[];
};

export type GatewayModelLevelTest = {
  message: string;
  model: string;
  ok: false;
  reasoning: "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh" | null;
  status?: number;
} | {
  model: string;
  ok: true;
  reasoning: "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh" | null;
};

export type GatewayModelSettings = {
  compactionInputBudget?: number;
  reasoning?: "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh";
};

export type GatewayModelTest = {
  message: string;
  model: string;
  ok: false;
  status?: number;
} | {
  model: string;
  ok: true;
};

export type HookDescription = {
  description: string;
  title: string;
};

export type MainlineMergeGadget = {
  baseCommit: string;
  chatCommit: string;
  conflictPaths: string[];
  gadgetId: number;
};

export type MessageFormatRef = {
  icon: "appWindow" | "chartBar" | "fileText" | "flowArrow" | "gridNine" | "kanban" | "listChecks" | "notebook" | "presentation" | "table";
  length: number;
  noun: string;
  position: number;
};

export type ModelKind = "decision" | "language";

export type ObservationDescription = {
  containsRestrictedData?: boolean;
  description: string;
  excludeObservers?: string[];
  fields?: ActionField[];
  ownerInvitesOnly?: boolean;
  title: string;
};

export type PermissionEdge = {
  created: Date;
  keyId: string;
  role?: CollaboratorRole;
  type: "shareKey";
} | {
  created: Date;
  note?: string;
  role?: CollaboratorRole;
  sharer: string;
  type: "user";
};

export type ResourceDescription = {
  hasSlashCommands?: true;
  hookTsType?: string;
  snippet: string;
  suggestedBindingName: string;
  title: string;
  tsType: string;
  url: string;
};

export type SlashCommandId = {
  builtin: true;
  commandId: "compact";
} | {
  builtin?: undefined;
  commandId: string;
  gatekeeperId: number;
};

export type SlashCommandRequest = {
  args: string;
  commandPosition?: number;
  id: SlashCommandId;
};

export type SpawnerEnvTarget = {
  name: string;
  type: "binding";
} | {
  type: "gadget";
};

export type TreeNode = {
  children: TreeNode[];
  kind: "dir";
  name: string;
} | {
  kind: "executable" | "file" | "submodule" | "symlink";
  name: string;
};

export type UserDirectoryRecord = {
  id: string;
  name: string;
};

export type WorkpieceSummary = GadgetSummary | WorktreeSummary;

export type WorktreeSummary = {
  baseCommit: string;
  chatId: number;
  headCommit: string;
  id: number;
  pinBase: string;
  title: string;
  type: "worktree";
};

/**
 * A value, or a promise of it. What a call accepts for a value parameter: Cap'n Web resolves a
 * promise argument before delivering the call, so one call's result is passed to the next without
 * waiting for it, `root.set(root.get())`. And what a function or a method the caller
 * implements may return: its result as is, or from an `async` function.
 */
export type Awaitable<T> = T | Promise<T>;

/**
 * What a call returning a capability returns: a promise of the capability, whose methods can be
 * called before it resolves (promise pipelining): `root.open(id).list()` sends both calls at
 * once, the second to whatever the first returns. Disposing it disposes the capability.
 */
export type Pipelined<T> = Promise<T> & T;
