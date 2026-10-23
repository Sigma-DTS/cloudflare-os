import { describe, expect, it } from "vitest";
import { INSTANCE_ADMIN_VENDOR_ID } from "@gadgets/workshop-shared/instance-admin";
import {
  DEFAULT_AMBIENT_GATEKEEPER_MODE, ambientGatekeeperMode, defaultAmbientGatekeeperMode,
  isGatekeeperDisabled, shouldAutoProvisionAccount,
} from "../src/provisioning-policy.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig,
} from "../src/storage-schema/admin-settings-storage.js";

function config(patch: Partial<AdminConfig> = {}): AdminConfig {
  return { ...DEFAULT_ADMIN_CONFIG, ...patch };
}

describe("ambient gatekeeper defaults", () => {
  it("is optional for every vendor but the instance admin gatekeeper, which is disabled", () => {
    expect(DEFAULT_AMBIENT_GATEKEEPER_MODE).toBe("optional");
    expect(defaultAmbientGatekeeperMode("websearch")).toBe("optional");
    expect(defaultAmbientGatekeeperMode("context")).toBe("optional");
    expect(defaultAmbientGatekeeperMode(INSTANCE_ADMIN_VENDOR_ID)).toBe("disabled");
    expect(defaultAmbientGatekeeperMode("InstanceAdmin")).toBe("disabled");
  });

  it("reads a mode an admin set, else the vendor's default", () => {
    let unset = config();
    expect(ambientGatekeeperMode(unset, "websearch")).toBe("optional");
    expect(ambientGatekeeperMode(unset, "instanceadmin")).toBe("disabled");
    expect(shouldAutoProvisionAccount(unset, "instanceadmin")).toBe(false);

    let set = config({ ambientGatekeeperModes: { websearch: "disabled", instanceadmin: "enabled" } });
    expect(ambientGatekeeperMode(set, "WebSearch")).toBe("disabled");
    expect(ambientGatekeeperMode(set, "InstanceAdmin")).toBe("enabled");
    expect(shouldAutoProvisionAccount(set, "instanceadmin")).toBe(true);

    // A config persisted before ambientGatekeeperModes existed.
    let legacy = config({ ambientGatekeeperModes: undefined as never });
    expect(ambientGatekeeperMode(legacy, "websearch")).toBe("optional");
    expect(ambientGatekeeperMode(legacy, "instanceadmin")).toBe("disabled");
  });
});

describe("isGatekeeperDisabled", () => {
  it("is true for an ordinary vendor exactly when disabledGatekeepers lists it", () => {
    expect(isGatekeeperDisabled(config(), "github")).toBe(false);
    expect(isGatekeeperDisabled(config({ disabledGatekeepers: ["github"] }), "github")).toBe(true);
    expect(isGatekeeperDisabled(config({ disabledGatekeepers: ["github"] }), "GitHub")).toBe(true);
    expect(isGatekeeperDisabled(config({ disabledGatekeepers: ["google"] }), "github")).toBe(false);
  });

  it("is true for an ambient vendor in mode disabled, or listed", () => {
    expect(isGatekeeperDisabled(config(), "websearch")).toBe(false);
    for (let mode of ["optional", "enabled"] as const) {
      expect(isGatekeeperDisabled(
          config({ ambientGatekeeperModes: { websearch: mode } }), "websearch")).toBe(false);
    }
    expect(isGatekeeperDisabled(
        config({ ambientGatekeeperModes: { websearch: "disabled" } }), "WebSearch")).toBe(true);
    expect(isGatekeeperDisabled(config({ disabledGatekeepers: ["websearch"] }), "websearch"))
        .toBe(true);
  });

  it("is true for the instance admin gatekeeper until an admin sets a mode that offers it", () => {
    expect(isGatekeeperDisabled(config(), INSTANCE_ADMIN_VENDOR_ID)).toBe(true);
    for (let mode of ["optional", "enabled"] as const) {
      let offered = config({ ambientGatekeeperModes: { instanceadmin: mode } });
      expect(isGatekeeperDisabled(offered, INSTANCE_ADMIN_VENDOR_ID)).toBe(false);
      expect(isGatekeeperDisabled({ ...offered, disabledGatekeepers: ["instanceadmin"] },
          INSTANCE_ADMIN_VENDOR_ID)).toBe(true);
    }
    expect(isGatekeeperDisabled(config({ ambientGatekeeperModes: { instanceadmin: "disabled" } }),
        INSTANCE_ADMIN_VENDOR_ID)).toBe(true);
  });
});
