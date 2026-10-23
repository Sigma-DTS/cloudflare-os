// The user DO offers, provisions, lists and lends the instance admin account only to a user who is a
// deployment admin now, and never while the deployment disabled the vendor. These run against a real
// UserDurableObject: the listing and provisioning methods use brand-checked private members, so a DO
// built from its prototype could not run them.

import { env, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AmbientGatekeeperMode, ConnectedAccountsSubscriber } from "@gadgets/workshop-shared/api";
import type { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import { INSTANCE_ADMIN_VENDOR_ID } from "@gadgets/workshop-shared/instance-admin";
import { serializeAdminConfig } from "../src/admin-config.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage.js";
import type { UserDurableObject } from "../src/user.js";
import type { FakeGatekeeperAccount } from "./test-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const ORDINARY = "ordinaryambient";
const UNAVAILABLE = "This instance admin account is no longer available to you.";
const disabled = (vendorId: string) =>
  `The "${vendorId}" gatekeeper is disabled on this deployment by an administrator.`;

type AccountProps = { name: string; singleton?: string };

// What the tests reach inside the user's DO: its public methods (Omit drops the private members,
// which an intersection with these would reduce to never) and the fields they replace or read.
type UserInternals = Omit<UserDurableObject, "env" | "ctx"> & {
  env: Cloudflare.Env;
  vendors: Map<string, Service<GatekeeperVendor>>;
  storage: {
    nextAccountId: { get(): number; put(value: number): void };
    connectedAccounts: {
      get(id: number): { id: number; vendorId: string } | undefined;
      put(record: unknown): void;
    };
  };
  ctx: DurableObjectState & {
    exports: {
      FakeGatekeeperAccount(options: { props: AccountProps }): Fetcher<FakeGatekeeperAccount>;
    };
  };
};

/** The deployment as one case sees it. */
type Deployment = {
  admin: boolean;
  modes?: Record<string, AmbientGatekeeperMode>;
  disabledGatekeepers?: readonly string[];
};

function uniqueUser(): string {
  return `provisioning-${crypto.randomUUID()}@example.test`;
}

// The name of the account `vendorId`'s fake vendor mints for `userId`, by which its calls are read.
const accountName = (userId: string, vendorId: string) => `${userId}/${vendorId}`;

/**
 * Runs `f` in `userId`'s DO (created on first use) as `deployment` describes: ADMINS lists the user
 * or nobody, the admin config holds the given modes, and the bound vendors are two ambient fakes,
 * the instance admin Gatekeeper and an ordinary one. Set on every call, so a case changes the
 * deployment between calls.
 */
function inUser<T>(userId: string, deployment: Deployment, f: (user: UserInternals) => Promise<T>)
    : Promise<T> {
  return runInDurableObject(env.TEST_USER.getByName(userId), async (instance: UserDurableObject) => {
    const user = instance as unknown as UserInternals;
    await user.authenticateFromCfAccess(userId, true);
    const config = serializeAdminConfig({
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: deployment.modes ?? {},
      disabledGatekeepers: [...deployment.disabledGatekeepers ?? []],
    });
    const BLUEPRINTS = {
      get: async (key: string) => key === ADMIN_CONFIG_KEY ? config : null,
    } as unknown as KVNamespace;
    user.env = { ...user.env, BLUEPRINTS, ADMINS: deployment.admin ? [userId] : [] } as Cloudflare.Env;
    const fakeVendor = (vendorId: string, singleton: string) => ({
      describe: async () => ({
        displayName: vendorId, url: "", tagline: "", description: "", autoProvisionsAccount: true,
      }),
      createAccount: async () => user.ctx.exports.FakeGatekeeperAccount({
        props: { name: accountName(userId, vendorId), singleton },
      }),
    }) as unknown as Service<GatekeeperVendor>;
    user.vendors = new Map([
      [INSTANCE_ADMIN_VENDOR_ID, fakeVendor(INSTANCE_ADMIN_VENDOR_ID, "AdminApi")],
      [ORDINARY, fakeVendor(ORDINARY, "OrdinaryApi")],
    ]);
    return f(user);
  });
}

/** The vendors of the accounts `user` stores, whether or not any listing shows them. */
function storedVendors(user: UserInternals): string[] {
  const vendors: string[] = [];
  for (let id = 0; id < user.storage.nextAccountId.get(); id++) {
    const record = user.storage.connectedAccounts.get(id);
    if (record) vendors.push(record.vendorId);
  }
  return vendors.toSorted();
}

/** The id of the account of `vendorId` that `user` stores. */
function accountIdOf(user: UserInternals, vendorId: string): number {
  for (let id = 0; id < user.storage.nextAccountId.get(); id++) {
    if (user.storage.connectedAccounts.get(id)?.vendorId === vendorId) return id;
  }
  throw new Error(`no ${vendorId} account`);
}

/** The vendors of the accounts subscribeConnectedAccounts reports, up to its ready(). */
async function subscribedVendors(user: UserInternals, includeForced = false): Promise<string[]> {
  const vendors: string[] = [];
  let settle!: () => void;
  const ready = new Promise<void>(resolve => { settle = resolve; });
  class Subscriber extends RpcTarget implements ConnectedAccountsSubscriber {
    add(_id: number, _description: unknown, _vendor: unknown, _resources: unknown,
        _credentialsValid: boolean, vendorId: string) {
      vendors.push(vendorId);
    }
    remove() {}
    ready() { settle(); }
  }
  const subscriber = new RpcStub(new Subscriber());
  // The Workshop types its subscriber as capnweb's stub; workerd's has the same shape here.
  const subscription = await user.subscribeConnectedAccounts(
      subscriber as unknown as Parameters<UserInternals["subscribeConnectedAccounts"]>[0],
      includeForced ? { includeForcedAutoProvisionedAccounts: true } : undefined);
  await ready;
  subscription[Symbol.dispose]();
  subscriber[Symbol.dispose]();
  return vendors.toSorted();
}

/** What every listing of `user` shows. */
async function listings(user: UserInternals, includeForced = false) {
  return {
    addable: (await user.listAddableGatekeepers()).map(vendor => vendor.id).toSorted(),
    provided: (await user.listProvidedAccounts()).map(account => account.vendorId).toSorted(),
    subscribed: await subscribedVendors(user, includeForced),
    selectable: {
      instanceAdmin: (await user.selectableGatekeeperUsers(INSTANCE_ADMIN_VENDOR_ID)).length,
      ordinary: (await user.selectableGatekeeperUsers(ORDINARY)).length,
    },
  };
}

/** What `userId`'s account of `vendorId` has been asked to do. */
function accountCalls(user: UserInternals, userId: string, vendorId: string): Promise<string[]> {
  return user.ctx.exports.FakeGatekeeperAccount({ props: { name: accountName(userId, vendorId) } })
      .calls();
}

/** Stores an instance admin account for `user` directly, as an earlier admin status would have. */
function plantInstanceAdminAccount(user: UserInternals, userId: string, autoProvisioned = true)
    : number {
  const id = user.storage.nextAccountId.get();
  user.storage.nextAccountId.put(id + 1);
  user.storage.connectedAccounts.put({
    id,
    account: user.ctx.exports.FakeGatekeeperAccount({
      props: { name: accountName(userId, INSTANCE_ADMIN_VENDOR_ID), singleton: "AdminApi" },
    }),
    description: { displayName: "Instance admin", singleton: { tsType: "AdminApi" } },
    vendorId: INSTANCE_ADMIN_VENDOR_ID,
    autoProvisioned,
  });
  return id;
}

describe("instance admin provisioning", () => {
  it("offers a non-admin nothing of the instance admin gatekeeper, in any mode", async () => {
    const userId = uniqueUser();
    const optional: Deployment =
        { admin: false, modes: { [INSTANCE_ADMIN_VENDOR_ID]: "optional", [ORDINARY]: "optional" } };
    await inUser(userId, optional, async user => {
      expect((await user.listAddableGatekeepers()).map(vendor => vendor.id)).toEqual([ORDINARY]);
      await expect(user.provisionAmbientAccount(INSTANCE_ADMIN_VENDOR_ID)).rejects.toThrow(
          "Only deployment admins can add the instance admin gatekeeper.");
      await user.provisionAmbientAccount(ORDINARY);
      expect(storedVendors(user)).toEqual([ORDINARY]);
      expect(await listings(user)).toEqual({
        addable: [], provided: [ORDINARY], subscribed: [ORDINARY],
        selectable: { instanceAdmin: 0, ordinary: 1 },
      });
    });

    const enabled: Deployment =
        { admin: false, modes: { [INSTANCE_ADMIN_VENDOR_ID]: "enabled", [ORDINARY]: "enabled" } };
    await inUser(userId, enabled, async user => {
      expect(await listings(user, true)).toEqual({
        addable: [], provided: [ORDINARY], subscribed: [ORDINARY],
        selectable: { instanceAdmin: 0, ordinary: 1 },
      });
      // Enabled mode provisions it for everyone but this user.
      expect(storedVendors(user)).toEqual([ORDINARY]);

      // An account the user somehow holds is still hidden, and refused before it is asked anything.
      const id = plantInstanceAdminAccount(user, userId);
      expect(await listings(user, true)).toEqual({
        addable: [], provided: [ORDINARY], subscribed: [ORDINARY],
        selectable: { instanceAdmin: 0, ordinary: 1 },
      });
      await expect(user.getSingletonGatekeeperClass(id)).rejects.toThrow(UNAVAILABLE);
      await expect(user.assertInstanceAdminAccount(id)).rejects.toThrow(UNAVAILABLE);
      expect(await accountCalls(user, userId, INSTANCE_ADMIN_VENDOR_ID)).toEqual([]);
    });
  });

  it("offers an admin the instance admin gatekeeper and lends its account", async () => {
    const userId = uniqueUser();
    const optional = { admin: true, modes: { [INSTANCE_ADMIN_VENDOR_ID]: "optional" } } as const;
    await inUser(userId, optional, async user => {
      expect((await user.listAddableGatekeepers()).map(vendor => vendor.id).toSorted())
          .toEqual([INSTANCE_ADMIN_VENDOR_ID, ORDINARY]);
      await user.provisionAmbientAccount(INSTANCE_ADMIN_VENDOR_ID);
      expect(await listings(user)).toEqual({
        addable: [ORDINARY],
        provided: [INSTANCE_ADMIN_VENDOR_ID],
        subscribed: [INSTANCE_ADMIN_VENDOR_ID],
        selectable: { instanceAdmin: 1, ordinary: 0 },
      });

      const id = accountIdOf(user, INSTANCE_ADMIN_VENDOR_ID);
      await user.assertInstanceAdminAccount(id);
      expect(await user.getSingletonGatekeeperClass(id)).toBeNull();
      expect(await accountCalls(user, userId, INSTANCE_ADMIN_VENDOR_ID))
          .toEqual(["describe", "getSingletonGatekeeperClass"]);
    });
  });

  it("provisions an admin's instance admin account in enabled mode", async () => {
    const userId = uniqueUser();
    const enabled = { admin: true, modes: { [INSTANCE_ADMIN_VENDOR_ID]: "enabled" } } as const;
    await inUser(userId, enabled, async user => {
      expect(await listings(user, true)).toEqual({
        addable: [ORDINARY],
        provided: [INSTANCE_ADMIN_VENDOR_ID],
        subscribed: [INSTANCE_ADMIN_VENDOR_ID],
        selectable: { instanceAdmin: 1, ordinary: 0 },
      });
      await user.assertInstanceAdminAccount(accountIdOf(user, INSTANCE_ADMIN_VENDOR_ID));
    });
  });

  it("checks only an auto-provisioned instance admin account of this user", async () => {
    const userId = uniqueUser();
    const optional = { admin: true, modes: { [INSTANCE_ADMIN_VENDOR_ID]: "optional" } } as const;
    await inUser(userId, optional, async user => {
      await user.provisionAmbientAccount(ORDINARY);
      await expect(user.assertInstanceAdminAccount(accountIdOf(user, ORDINARY)))
          .rejects.toThrow(UNAVAILABLE);
      await expect(user.assertInstanceAdminAccount(99)).rejects.toThrow(UNAVAILABLE);
      const linked = plantInstanceAdminAccount(user, userId, false);
      await expect(user.assertInstanceAdminAccount(linked)).rejects.toThrow(UNAVAILABLE);
    });
  });

  it("hides and refuses a demoted admin's instance admin account", async () => {
    const userId = uniqueUser();
    const modes = { [INSTANCE_ADMIN_VENDOR_ID]: "optional" } as const;
    const id = await inUser(userId, { admin: true, modes }, async user => {
      await user.provisionAmbientAccount(INSTANCE_ADMIN_VENDOR_ID);
      return accountIdOf(user, INSTANCE_ADMIN_VENDOR_ID);
    });

    await inUser(userId, { admin: false, modes }, async user => {
      expect(await listings(user, true)).toEqual({
        addable: [ORDINARY], provided: [], subscribed: [],
        selectable: { instanceAdmin: 0, ordinary: 0 },
      });
      await expect(user.getSingletonGatekeeperClass(id)).rejects.toThrow(UNAVAILABLE);
      await expect(user.assertInstanceAdminAccount(id)).rejects.toThrow(UNAVAILABLE);
      // The account is kept, for when the user is an admin again.
      expect(storedVendors(user)).toEqual([INSTANCE_ADMIN_VENDOR_ID]);
      expect(await accountCalls(user, userId, INSTANCE_ADMIN_VENDOR_ID)).toEqual(["describe"]);
    });
  });

  it("hides and refuses the instance admin account while the deployment disabled the vendor", async () => {
    const userId = uniqueUser();
    const id = await inUser(userId, { admin: true, modes: { [INSTANCE_ADMIN_VENDOR_ID]: "enabled" } },
        async user => {
          await user.listProvidedAccounts();
          return accountIdOf(user, INSTANCE_ADMIN_VENDOR_ID);
        });

    // Disabled is also its mode while an admin has chosen none.
    const disabledModes: Deployment["modes"][] = [{ [INSTANCE_ADMIN_VENDOR_ID]: "disabled" }, {}];
    for (const modes of disabledModes) {
      await inUser(userId, { admin: true, modes }, async user => {
        expect(await listings(user, true)).toEqual({
          addable: [ORDINARY], provided: [], subscribed: [],
          selectable: { instanceAdmin: 0, ordinary: 0 },
        });
        await expect(user.getSingletonGatekeeperClass(id))
            .rejects.toThrow(disabled(INSTANCE_ADMIN_VENDOR_ID));
        await expect(user.assertInstanceAdminAccount(id))
            .rejects.toThrow(disabled(INSTANCE_ADMIN_VENDOR_ID));
        await expect(user.provisionAmbientAccount(INSTANCE_ADMIN_VENDOR_ID)).rejects.toThrow(
            `The "${INSTANCE_ADMIN_VENDOR_ID}" gatekeeper is disabled on this deployment.`);
      });
    }
    await inUser(userId, { admin: true }, async user => {
      expect(await accountCalls(user, userId, INSTANCE_ADMIN_VENDOR_ID)).toEqual(["describe"]);
    });
  });

  it("leaves the ordinary ambient vendor to its mode, whoever the user is", async () => {
    const userId = uniqueUser();
    const id = await inUser(userId, { admin: false, modes: { [ORDINARY]: "enabled" } }, async user => {
      await user.listProvidedAccounts();
      const ordinaryId = accountIdOf(user, ORDINARY);
      expect(await user.getSingletonGatekeeperClass(ordinaryId)).toBeNull();
      return ordinaryId;
    });
    await inUser(userId, { admin: true, modes: { [ORDINARY]: "enabled" } }, async user => {
      expect((await user.listProvidedAccounts()).map(account => account.vendorId)).toEqual([ORDINARY]);
      expect(await user.getSingletonGatekeeperClass(id)).toBeNull();
    });

    const disabledDeployments: Deployment[] = [
      { admin: true, modes: { [ORDINARY]: "disabled" } },
      { admin: true, modes: { [ORDINARY]: "enabled" }, disabledGatekeepers: [ORDINARY] },
    ];
    for (const deployment of disabledDeployments) {
      await inUser(userId, deployment, async user => {
        expect(await user.listProvidedAccounts()).toEqual([]);
        await expect(user.getSingletonGatekeeperClass(id)).rejects.toThrow(disabled(ORDINARY));
      });
    }
    await inUser(userId, { admin: false }, async user => {
      expect(await accountCalls(user, userId, ORDINARY))
          .toEqual(["describe", "getSingletonGatekeeperClass", "getSingletonGatekeeperClass"]);
    });
  });
});
