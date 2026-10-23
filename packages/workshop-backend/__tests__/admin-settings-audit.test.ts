import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_ADMIN_AUDIT_VALUE_LENGTH,
  type AdminAuditRecord, type AdminSettingRecord, type GatewayModel,
} from "@gadgets/workshop-shared/api";
import type { AdminSettingActor } from "../src/admin-access.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import { AdminSettings } from "../src/admin-settings.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig, type AdminSettingsStorage,
} from "../src/storage-schema/admin-settings-storage.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
  }
}

const GATEWAY = {
  CF_AI_GATEWAY: "platform-gateway",
  CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
  CF_AI_GATEWAY_API_TOKEN: "gateway-token",
  CF_AI_GATEWAY_PROVIDERS: "anthropic,cloudflare",
};

const ACTOR: AdminSettingActor =
    { admin: "admin@example.test", sessionId: "session-1", via: "cli", method: "setSiteName" };

let counter = 0;

function model(i: number): GatewayModel {
  return { provider: "anthropic", id: `model-${i}`, name: `Model ${i}`, contextWindow: 200_000 };
}

async function digest(data: Uint8Array): Promise<string> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data)).toHex();
}

/**
 * An AdminSettings over fresh storage, built on the state of an unrelated Durable Object as
 * admin-settings-models.test.ts builds it, with `vars` as its environment (and `more` beside them
 * for one call). Its audit log is a fake whose appends land in `appended`; `events` orders the
 * appends, KV writes and R2 writes. `audit.fail`, `kv.fail` make the next of each throw.
 */
function adminSettings(vars: object = {}) {
  const stub = env.TEST_USER_DIRECTORY.getByName(`admin-settings-audit-${++counter}`);
  const events: string[] = [];
  const appended: { record: AdminAuditRecord; retentionDays: number }[] = [];
  const audit = { fail: false };
  const kv = { fail: false, blueprints: new Map<string, string>() };
  const put = vi.fn(async (key: string, value: string) => {
    if (kv.fail) throw new Error("KV unavailable");
    events.push(`kv:${key}`);
    kv.blueprints.set(key, value);
  });
  const audits = { getByName: () => ({
    append: async (record: AdminAuditRecord, retentionDays: number) => {
      if (audit.fail) throw new Error("audit log unavailable");
      events.push("audit");
      appended.push({ record, retentionDays });
    },
  }) };
  const r2 = {
    put: vi.fn(async () => { events.push("r2:put"); }),
    delete: vi.fn(async () => { events.push("r2:delete"); }),
  };
  const owner = {
    featured: null as boolean | null,
    isBlueprintFeatured: async () => owner.featured,
    setBlueprintFeatured: async (_id: string, featured: boolean) => {
      events.push("owner:set");
      owner.featured = featured;
    },
  };
  const users = { idFromString: (id: string) => id, get: () => owner };

  const inDo = <T>(f: (admin: AdminSettings) => T | Promise<T>,
                   options: { more?: object; fake?: boolean } = {}) => runInDurableObject(
      stub, (_host, state) => {
        const settingsEnv = {
          ...vars, ...options.more,
          BLUEPRINTS: { put, get: async (key: string) => kv.blueprints.get(key) ?? null },
          BLUEPRINT_CONTENT: r2,
        };
        const admin = new AdminSettings(state, settingsEnv as unknown as Cloudflare.Env);
        Object.assign(admin, { users }, options.fake === false ? {} : { audits });
        return f(admin);
      });
  // Write the stored config directly, as an earlier admin would have left it, recording nothing.
  const seed = (patch: Partial<AdminConfig>) => inDo(admin => {
    (admin as unknown as { storage: AdminSettingsStorage }).storage.adminConfig
        .put({ ...DEFAULT_ADMIN_CONFIG, ...patch });
  });
  const config = () => inDo(admin => admin.getAdminConfig());
  // The setting records appended, in order.
  const records = () => appended.map(({ record }) => record as AdminSettingRecord);
  return { inDo, seed, config, records, appended, events, audit, kv, put, r2, owner };
}

describe("AdminSettings records each admin's change before making it", () => {
  it("records who changed a setting, how, and from what to what, before the KV write", async () => {
    const { inDo, appended, events, config } = adminSettings();
    const before = Date.now();
    await inDo(admin => admin.updateAdminConfig({ siteName: "Acme" }, ACTOR));

    expect(appended).toHaveLength(1);
    const { record, retentionDays } = appended[0]!;
    expect(record).toMatchObject({
      kind: "setting", admin: "admin@example.test", sessionId: "session-1", via: "cli",
      method: "setSiteName", changes: [{ setting: "siteName", before: "", after: "Acme" }],
    });
    expect((record as AdminSettingRecord).changes[0]).toStrictEqual(
        { setting: "siteName", before: "", after: "Acme" });
    expect(record.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(retentionDays).toBe(90);
    expect(events).toEqual(["audit", "kv:.adminConfig"]);
    expect((await config()).siteName).toBe("Acme");
  });

  it("keeps long agent instructions whole, both before and after", async () => {
    const { inDo, records } = adminSettings();
    const first = "a".repeat(8_000);
    const second = first.slice(0, -20) + "b".repeat(20);
    await inDo(admin => admin.updateAdminConfig({ instanceInstructions: first }, ACTOR));
    await inDo(admin => admin.updateAdminConfig({ instanceInstructions: second }, ACTOR));

    expect(records()[1]!.changes).toStrictEqual(
        [{ setting: "instanceInstructions", before: first, after: second }]);
  });

  it("records one format's change, and a reordering as one keyless change", async () => {
    const { inDo, seed, records } = adminSettings();
    const ids = ["bp-a", "bp-b", "bp-c", "bp-d"];
    await seed({ formats: ids.map(blueprintId => ({ blueprintId, enabled: true })) });

    await inDo(admin => admin.updateFormat("bp-d", { enabled: false }, ACTOR));
    expect(records()[0]!.changes).toStrictEqual([{
      setting: "formats", key: "bp-d",
      before: '{"blueprintId":"bp-d","enabled":true}',
      after: '{"blueprintId":"bp-d","enabled":false}',
    }]);

    await inDo(admin => admin.setFormatOrder(["bp-d", "bp-a", "bp-b", "bp-c"], ACTOR));
    expect(records()[1]!.changes).toStrictEqual([{
      setting: "formats",
      before: '["bp-a","bp-b","bp-c","bp-d"]',
      after: '["bp-d","bp-a","bp-b","bp-c"]',
    }]);
  });

  it("records an added model alone, however many there are", async () => {
    const { inDo, seed, records } = adminSettings(GATEWAY);
    await seed({ addedModels: Array.from({ length: 60 }, (_, i) => model(i)) });

    await inDo(admin => admin.addGatewayModel(model(60), ACTOR));
    expect(records()[0]!.changes).toStrictEqual([{
      setting: "addedModels", key: "model-60",
      after: '{"contextWindow":200000,"id":"model-60","name":"Model 60","provider":"anthropic"}',
    }]);
  });

  it("records a map one key at a time", async () => {
    const { inDo, records } = adminSettings(GATEWAY);
    const color = DEFAULT_ADMIN_CONFIG.banner.color === "warning" ? "danger" : "warning";
    await inDo(admin =>
        admin.updateAdminConfig({ banner: { text: "Down at noon", color } }, ACTOR));
    expect(records()[0]!.changes).toStrictEqual([
      { setting: "banner", key: "color", before: DEFAULT_ADMIN_CONFIG.banner.color, after: color },
      { setting: "banner", key: "text", before: "", after: "Down at noon" },
    ]);

    await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "disabled", ACTOR));
    expect(records()[1]!.changes).toStrictEqual(
        [{ setting: "modelModes", key: "claude-fable-5-1", after: "disabled" }]);
  });

  it("keeps an excerpt of an over-long value, and cuts an over-long key", async () => {
    const { inDo, records } = adminSettings();
    const pattern = "p".repeat(12_000);
    await inDo(admin => admin.setResourceEnabled("vendor", pattern, false, ACTOR));
    const [change] = records()[0]!.changes;
    expect(change).toStrictEqual({
      setting: "disabledResources", key: "vendor",
      after: `["${pattern}"]`.slice(0, MAX_ADMIN_AUDIT_VALUE_LENGTH),
      excerpt: { offset: 0, afterLength: 12_004 },
    });

    const vendor = "v".repeat(300);
    await inDo(admin => admin.setResourceEnabled(vendor, "pattern", false, ACTOR));
    expect(records()[1]!.changes).toStrictEqual([{
      setting: "disabledResources",
      key: `${"v".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`,
      after: '["pattern"]',
    }]);
  });

  it("records nothing for a change that changes nothing, which is still written", async () => {
    const { inDo, appended, put } = adminSettings();
    await inDo(admin => admin.updateAdminConfig({ siteName: "" }, ACTOR));
    expect(appended).toEqual([]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("records nothing for a change it refuses", async () => {
    const { inDo, appended, put } = adminSettings(GATEWAY);
    await expect(inDo(admin => admin.setGatewayModelMode("no-such-model", "disabled", ACTOR)))
        .rejects.toThrow("No such model: no-such-model");
    expect(appended).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses a change whose record cannot be written, writing nothing", async () => {
    const { inDo, audit, put, config } = adminSettings();
    audit.fail = true;
    await expect(inDo(admin => admin.updateAdminConfig({ siteName: "Acme" }, ACTOR)))
        .rejects.toThrow("audit log unavailable");
    expect(put).not.toHaveBeenCalled();
    expect((await config()).siteName).toBe("");
  });

  it("keeps the record of a change the KV mirror then fails, which is rolled back", async () => {
    const { inDo, kv, appended, config } = adminSettings();
    kv.fail = true;
    await expect(inDo(admin => admin.updateAdminConfig({ siteName: "Acme" }, ACTOR)))
        .rejects.toThrow("KV unavailable");
    expect((await config()).siteName).toBe("");
    expect(appended).toHaveLength(1);
  });

  it("records a logo as its size and digest, before storing it", async () => {
    const { inDo, records, events } = adminSettings();
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6, 7]);

    await inDo(admin => admin.setSiteLogo(first, ACTOR));
    expect(events).toEqual(["audit", "r2:put", "kv:.adminConfig"]);
    await inDo(admin => admin.setSiteLogo(second, ACTOR));
    await inDo(admin => admin.setSiteLogo(null, ACTOR));
    // Resetting a logo that is already the default changes nothing.
    await inDo(admin => admin.setSiteLogo(null, ACTOR));

    expect(records().map(record => record.changes)).toStrictEqual([
      [{ setting: "siteLogo", before: "default",
         after: `{"bytes":3,"sha256":"${await digest(first)}"}` }],
      [{ setting: "siteLogo", before: "custom",
         after: `{"bytes":4,"sha256":"${await digest(second)}"}` }],
      [{ setting: "siteLogo", before: "custom", after: "default" }],
    ]);
  });

  it("records featuring a blueprint only when that changes it", async () => {
    const { inDo, kv, records, events, owner } = adminSettings();
    const at = new Date("2026-01-01T00:00:00Z");
    kv.blueprints.set("bp-1", JSON.stringify({
      metadata: {
        title: "Notes", description: "", author: { id: "owner", name: "Owner" },
        created: at, version: 1, lastUpdated: at,
      },
      ownerId: "owner-do", gadgetId: "gadget-1",
    }));

    await inDo(admin => admin.setBlueprintFeatured("bp-1", true, ACTOR));
    expect(events.slice(0, 2)).toEqual(["audit", "owner:set"]);
    await inDo(admin => admin.setBlueprintFeatured("bp-1", true, ACTOR));
    await inDo(admin => admin.setBlueprintFeatured("bp-1", false, ACTOR));
    expect(owner.featured).toBe(false);
    expect(records().map(record => record.changes)).toStrictEqual([
      [{ setting: "featured", key: "bp-1", before: "false", after: "true" }],
      [{ setting: "featured", key: "bp-1", before: "true", after: "false" }],
    ]);
  });

  it("never lets a concurrent featuring change go unrecorded", async () => {
    const { inDo, kv, records, owner } = adminSettings();
    const at = new Date("2026-01-01T00:00:00Z");
    kv.blueprints.set("bp-1", JSON.stringify({
      metadata: {
        title: "Notes", description: "", author: { id: "owner", name: "Owner" },
        created: at, version: 1, lastUpdated: at,
      },
      ownerId: "owner-do", gadgetId: "gadget-1",
    }));
    owner.featured = false;
    // The first read answers with the bit as it was, late: long enough for a concurrent call to
    // change it if nothing serializes the two.
    let reads = 0;
    owner.isBlueprintFeatured = async () => {
      const value = owner.featured;
      if (++reads === 1) await new Promise(resolve => setTimeout(resolve, 50));
      return value;
    };

    await inDo(admin => Promise.all([
      admin.setBlueprintFeatured("bp-1", false, ACTOR),
      admin.setBlueprintFeatured("bp-1", true, ACTOR),
    ]));
    expect(owner.featured).toBe(true);
    expect(records().map(record => record.changes)).toStrictEqual([
      [{ setting: "featured", key: "bp-1", before: "false", after: "true" }],
    ]);
  });
});

describe("AdminSettings records an agent's change as made through the gatekeeper", () => {
  it("keeps the change's origin and its run's session on the record", async () => {
    const { inDo, records } = adminSettings();
    const origin = { workspaceId: "w-admin", chatId: 3, actionId: 9 };
    await inDo(admin => admin.updateAdminConfig({ siteName: "Acme" },
        { ...ACTOR, sessionId: "agent-run-1", via: "gatekeeper", origin }));
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      kind: "setting", admin: "admin@example.test", sessionId: "agent-run-1", via: "gatekeeper",
      origin, method: "setSiteName", changes: [{ setting: "siteName", before: "", after: "Acme" }],
    });
  });
});

// A bound ambient vendor: buildGatekeeperVendorMap() finds it by binding name, and
// setGatekeeperMode() takes the ambient branch for a vendor whose describe() auto-provisions.
function ambientVendor(displayName: string) {
  return {
    describe: async () => ({ displayName, autoProvisionsAccount: true }),
    getSupportedResources: async () => [],
  };
}

describe("AdminSettings.setGatekeeperMode", () => {
  const VENDORS = {
    GATEKEEPER_INSTANCEADMIN: ambientVendor("Instance admin"),
    GATEKEEPER_WEBSEARCH: ambientVendor("Web Search"),
  };
  const MODE_ACTOR: AdminSettingActor = { ...ACTOR, method: "setGatekeeperMode" };

  it("stores each ambient vendor's own default as absence", async () => {
    const { inDo, config } = adminSettings();
    const set = (vendorId: string, mode: "disabled" | "optional" | "enabled") =>
        inDo(admin => admin.setGatekeeperMode(vendorId, mode, MODE_ACTOR), { more: VENDORS });

    await set("instanceadmin", "optional");
    await set("websearch", "disabled");
    expect((await config()).ambientGatekeeperModes)
        .toStrictEqual({ instanceadmin: "optional", websearch: "disabled" });

    await set("instanceadmin", "disabled");
    await set("websearch", "optional");
    expect((await config()).ambientGatekeeperModes).toStrictEqual({});

    await set("InstanceAdmin", "enabled");
    await set("websearch", "enabled");
    expect((await config()).ambientGatekeeperModes)
        .toStrictEqual({ instanceadmin: "enabled", websearch: "enabled" });
    expect((await config()).disabledGatekeepers).toEqual([]);
  });

  it("reports the instance admin gatekeeper disabled until an admin sets a mode", async () => {
    const { inDo } = adminSettings();
    const modes = async () => Object.fromEntries(
        (await inDo(admin => admin.getSettings("admin@example.test"), { more: VENDORS }))
            .resourceVendors.map(vendor =>
                [vendor.vendorId, vendor.autoProvisions ? vendor.ambientMode : undefined]));
    expect(await modes()).toEqual({ instanceadmin: "disabled", websearch: "optional" });
    await inDo(admin => admin.setGatekeeperMode("instanceadmin", "optional", MODE_ACTOR),
        { more: VENDORS });
    expect(await modes()).toEqual({ instanceadmin: "optional", websearch: "optional" });
  });

  it("leaves a vendor that does not auto-provision on the binary setting", async () => {
    const { inDo, config } = adminSettings();
    await inDo(admin => admin.setGatekeeperMode("github", "disabled", MODE_ACTOR),
        { more: VENDORS });
    expect((await config()).disabledGatekeepers).toEqual(["github"]);
    expect((await config()).ambientGatekeeperModes).toStrictEqual({});
    await expect(inDo(admin => admin.setGatekeeperMode("github", "optional", MODE_ACTOR),
        { more: VENDORS })).rejects.toThrow("is not an auto-provisioning gatekeeper");
  });
});

describe("AdminSettings admin access bounds", () => {
  it("refuses an access level above ADMIN_WORKSPACE_ACCESS_MAX", async () => {
    const { inDo, appended, config, records } = adminSettings();
    await expect(inDo(admin => admin.setAdminWorkspaceAccess("full", ACTOR)))
        .rejects.toThrow("ADMIN_WORKSPACE_ACCESS_MAX");
    expect(appended).toEqual([]);

    await inDo(admin => admin.setAdminWorkspaceAccess("off", ACTOR));
    expect(records()[0]!.changes).toStrictEqual(
        [{ setting: "adminWorkspaceAccess", before: "metadata", after: "off" }]);

    await inDo(admin => admin.setAdminWorkspaceAccess("full", ACTOR),
        { more: { ADMIN_WORKSPACE_ACCESS_MAX: "full" } });
    expect((await config()).adminWorkspaceAccess).toBe("full");
  });

  it("allows nothing while ADMIN_WORKSPACE_ACCESS_MAX is not a level", async () => {
    const { inDo, appended } = adminSettings({ ADMIN_WORKSPACE_ACCESS_MAX: "none" });
    await expect(inDo(admin => admin.setAdminWorkspaceAccess("metadata", ACTOR)))
        .rejects.toThrow("ADMIN_WORKSPACE_ACCESS_MAX");
    expect(appended).toEqual([]);
    expect((await inDo(admin => admin.getSettings("admin"))).adminWorkspaceAccess)
        .toStrictEqual({ effective: "off", chosen: "metadata", max: "off" });
  });

  it("refuses a retention below ADMIN_AUDIT_RETENTION_MIN_DAYS", async () => {
    const { inDo, appended, config } = adminSettings();
    for (let days of [30, 89, 90.5, 3651]) {
      await expect(inDo(admin => admin.setAdminAuditRetentionDays(days, ACTOR)))
          .rejects.toThrow("ADMIN_AUDIT_RETENTION_MIN_DAYS");
    }
    expect(appended).toEqual([]);
    await inDo(admin => admin.setAdminAuditRetentionDays(120, ACTOR));
    expect((await config()).adminAuditRetentionDays).toBe(120);

    const raised = { more: { ADMIN_AUDIT_RETENTION_MIN_DAYS: "365" } };
    await expect(inDo(admin => admin.setAdminAuditRetentionDays(200, ACTOR), raised))
        .rejects.toThrow("from 365");
    await inDo(admin => admin.setAdminAuditRetentionDays(400, ACTOR), raised);
    expect((await config()).adminAuditRetentionDays).toBe(400);
  });

  it("reports the level and retention enforced, chosen and bounded", async () => {
    const { inDo, appended } = adminSettings();
    const full = { more: { ADMIN_WORKSPACE_ACCESS_MAX: "full" } };
    await inDo(admin => admin.setAdminWorkspaceAccess("full", ACTOR), full);
    await inDo(admin => admin.setAdminAuditRetentionDays(100, ACTOR));

    const settings = (more: object) =>
        inDo(admin => admin.getSettings("admin"), { more });
    expect(await settings({ ADMIN_WORKSPACE_ACCESS_MAX: "full" })).toMatchObject({
      adminWorkspaceAccess: { effective: "full", chosen: "full", max: "full" },
      adminAuditRetentionDays: { effective: 100, chosen: 100, min: 90 },
    });
    // Lowering the bounds keeps the admins' choices, but enforces the bounds.
    expect(await settings({ ADMIN_AUDIT_RETENTION_MIN_DAYS: "180" })).toMatchObject({
      adminWorkspaceAccess: { effective: "metadata", chosen: "full", max: "metadata" },
      adminAuditRetentionDays: { effective: 180, chosen: 100, min: 180 },
    });

    // A record is kept for the retention in effect when it is made.
    await inDo(admin => admin.updateAdminConfig({ siteName: "Acme" }, ACTOR),
        { more: { ADMIN_AUDIT_RETENTION_MIN_DAYS: "180" } });
    expect(appended.at(-1)!.retentionDays).toBe(180);
  });

  it("appends to the deployment-wide audit log", async () => {
    const { inDo } = adminSettings();
    const admin = `audit-${crypto.randomUUID()}@example.test`;
    const sessionId = crypto.randomUUID();
    await inDo(settings => settings.updateAdminConfig(
        { siteName: "Logged" }, { ...ACTOR, admin, sessionId }), { fake: false });

    const page = await env.TEST_ADMIN_AUDIT.getByName("").list(
        { kind: "setting", admin, limit: 10 }, 90);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      kind: "setting", admin, sessionId, via: "cli", method: "setSiteName",
      changes: [{ setting: "siteName", before: "", after: "Logged" }],
    });
  });
});
