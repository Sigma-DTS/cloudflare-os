// What ensureObserver does with a binding it could not verify: every failure is collected and
// reported as a denial the user can act on, and nothing the call did not create is torn down.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// git-migration-do.test.ts); the gatekeeper facet and the client's User DO are the only fakes.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type ObserverImpl = OverseerDurableObject["impl"];
type ObserverClientUser = Parameters<ObserverImpl["ensureObserver"]>[1];
type ObserverConfigureCallback = NonNullable<Parameters<ObserverImpl["ensureObserver"]>[3]>;

// Seed the owner profile id, so the sharing manager needs no User DO round trip.
function seedOwner(impl: any): void {
  impl.ownerProfileId = "owner";
}

function seedGatekeepers(impl: any, ids: number[] = [1, 2]): void {
  for (let id of ids) {
    impl.storage.gatekeepers.put({
      id,
      resourceTitle: `Connection ${id}`,
      class: {} as any,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: `https://example.com/${id}`,
        typeUrlPattern: "https://*",
      },
    });
  }
}

// A client User DO that always has the account and always mints a verifier.
const fakeClientUser = {
  getVerifier: async () => ({}),
  describeConnectedAccount: async () => null,
} as any;

// Facets for every seeded connection, registering through `hooks`.
function setObserverFacets(impl: ObserverImpl, hooks: {
  addObserver?(id: number, observerId: string): Promise<void>;
  removeObserver?(id: number): Promise<void>;
} = {}): void {
  const getFacet = async (id: number) => ({
    addObserver: async (observerId: string) => { await hooks.addObserver?.(id, observerId); },
    removeObserver: async () => { await hooks.removeObserver?.(id); },
  });
  // Admission calls only these two methods, not the full RPC facet.
  impl.getGatekeeperFacet = getFacet as unknown as ObserverImpl["getGatekeeperFacet"];
}

// Chooses account `gatekeeperId * 10` for every binding it is asked about.
function chooseAll(needs: {gatekeeperId: number}[]): {gatekeeperId: number, accountId: number}[] {
  return needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: need.gatekeeperId * 10 }));
}

// A local stand-in for the client's RPC callback, on which admission calls only `configure()`.
function configCallback(configure: (needs: {gatekeeperId: number}[]) =>
    Promise<{gatekeeperId: number, accountId: number}[]>): ObserverConfigureCallback {
  return { configure } as unknown as ObserverConfigureCallback;
}

const configureAll = configCallback(async needs => chooseAll(needs));

describe("a binding that fails verification", () => {
  it("reports a verifier rejection as a denial, not as the raw RPC error", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-getverifier");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedOwner(impl);
      seedGatekeepers(impl);
      // Already-configured coverage for both gatekeepers, as a previous successful open left it.
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      let removed: number[] = [];
      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => {},
        removeObserver: async () => { removed.push(id); },
      });

      // Gatekeeper 1's verifier never materializes: the client's User DO *rejects* (the
      // deterministic vendor-mismatch throw, or any cross-worker transport failure) rather than
      // returning null.
      let failingClientUser = {
        getVerifier: async (accountId: number) => {
          if (accountId === 10) throw new Error("account is for a different vendor");
          return {};
        },
        describeConnectedAccount: async () => null,
      } as any;

      // The rejection is caught per binding like any other refusal, so with no repair channel the
      // open is denied with the descriptive message that names what to fix -- rather than the
      // transport error escaping mid-Promise.all.
      await expect(impl.ensureObserver("alice", failingClientUser, "build"))
          .rejects.toThrow(/could not confirm/);

      // Alice was already an admitted observer, so this call registered nothing and there is
      // nothing for the rollback to remove. Her registrations are what make gatekeepers name her
      // in `excludeObservers`, so dropping one would be fail-open.
      expect(removed).toEqual([]);

      // Neither producer's restricted reads are blocked, though -- both are verifiable, so
      // admission is the whole enforcement and nobody unverified can be watching.
      let restricted = { title: "t", description: "d", containsRestrictedData: true };
      await expect(impl.authorizeObservation(1, restricted, { from: "user" }))
          .resolves.toBeUndefined();
      await expect(impl.authorizeObservation(2, restricted, { from: "user" }))
          .resolves.toBeUndefined();
    });
  });

  it("keeps all of a returning observer's registrations, including ones this call added",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-keeps-registration");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedOwner(impl);
      seedGatekeepers(impl);
      // Alice's previous open covered gatekeeper 1 only; gatekeeper 2 is a binding added since,
      // which she has never been verified against.
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10 } });

      let removed: number[] = [];
      impl.getGatekeeperFacet = (id: number) => ({
        // Gatekeeper 1 has revoked her access upstream: the binding she *was* admitted for is the
        // one that now refuses, which is exactly the case that used to drop her registration.
        addObserver: async () => { if (id === 1) throw new Error("access revoked upstream"); },
        removeObserver: async () => { removed.push(id); },
      });

      let configureCb = { configure: async (needs: {gatekeeperId: number}[]) =>
          needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: 20 })) } as any;

      await expect(impl.ensureObserver("alice", fakeClientUser, "build", configureCb))
          .rejects.toThrow(/could not confirm/);

      // Gatekeeper 1's registration predates this call and survives, so it keeps naming her in
      // `excludeObservers`. Gatekeeper 2's was created by this call, but Alice's persisted
      // observerId remains resolvable to exclusion checks too: de-registering is the fail-open
      // direction, and a spurious registration only blocks fail-closed until a later open
      // re-verifies it.
      expect(removed).toEqual([]);
    });
  });

  it("queues a successful open after a failed one without blocking another profile", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-concurrent");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl, [1, 2, 3]);
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10 } });

      let removed: number[] = [];
      let releaseVerifier!: () => void;
      let verifierParked = new Promise<void>(resolve => { releaseVerifier = resolve; });
      let reached!: () => void;
      let verifierReached = new Promise<void>(resolve => { reached = resolve; });
      let firstAttempt = true;
      // A local stand-in for the client's User DO, supplying only the methods admission calls.
      let parkingClientUser = {
        getVerifier: async (accountId: number) => {
          if (accountId === 30) {
            if (firstAttempt) {
              firstAttempt = false;
              reached();
              await verifierParked;
            }
            throw new Error("no access");
          }
          return {};
        },
        describeConnectedAccount: async () => null,
      } as unknown as ObserverClientUser;
      setObserverFacets(impl, { removeObserver: async id => { removed.push(id); } });

      let callA = impl.ensureObserver("alice", parkingClientUser, "build", configureAll);
      callA.catch(() => {});  // asserted below; not unhandled while its verifier is parked
      await verifierReached;

      let queuedPrompts = 0;
      let queuedConfig = configCallback(async needs => {
        queuedPrompts++;
        return chooseAll(needs);
      });
      let callB = impl.ensureObserver("alice", fakeClientUser, "build", queuedConfig);

      // Bob can finish while Alice's first open is parked, but her second open cannot prompt yet.
      await impl.ensureObserver("bob", fakeClientUser, "build", configureAll);
      let queuedPromptsBeforeRelease = queuedPrompts;
      let choicesBeforeRelease = impl.storage.observers.get("alice")?.accountChoices;

      releaseVerifier();
      await expect(callA).rejects.toThrow(/could not confirm/);
      await callB;

      expect(impl.storage.observers.get("bob")).toBeDefined();
      expect(queuedPromptsBeforeRelease).toBe(0);
      expect(choicesBeforeRelease).toEqual({ 1: 10 });
      expect(queuedPrompts).toBe(1);
      expect(removed).toEqual([]);
      expect(impl.storage.observers.get("alice")).toEqual({
        profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20, 3: 30 },
      });
    });
  });

  it("a first-ever verification failure still rolls its registrations back", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-first-ever");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedOwner(impl);
      seedGatekeepers(impl);
      // No observer record: Alice has never been admitted, so the observerId minted for this call
      // is discarded with the unpersisted record and anything registered under it would linger
      // unresolvable.
      let removed: number[] = [];
      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => { if (id === 2) throw new Error("no access"); },
        removeObserver: async () => { removed.push(id); },
      });

      let configureCb = { configure: async (needs: {gatekeeperId: number}[]) =>
          needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: need.gatekeeperId * 10 }))
      } as any;

      await expect(impl.ensureObserver("alice", fakeClientUser, "build", configureCb))
          .rejects.toThrow(/could not confirm/);

      // Both the one that verified and the one that refused are rolled back, and no record is
      // persisted.
      expect(removed.toSorted()).toEqual([1, 2]);
      expect(impl.storage.observers.get("alice")).toBeUndefined();
    });
  });

  it("reuses one observer identity for first-ever concurrent successful opens", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-first-concurrent");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      let registrations: {id: number, observerId: string}[] = [];
      setObserverFacets(impl, {
        addObserver: async (id, observerId) => { registrations.push({id, observerId}); },
      });
      let release!: () => void;
      let reached!: () => void;
      let parked = new Promise<void>(resolve => { release = resolve; });
      let prompted = new Promise<void>(resolve => { reached = resolve; });
      let firstPrompts = 0;
      let firstConfig = configCallback(async needs => {
        firstPrompts++;
        reached();
        await parked;
        return chooseAll(needs);
      });
      let secondPrompts = 0;
      let secondConfig = configCallback(async needs => {
        secondPrompts++;
        return chooseAll(needs);
      });

      let callA = impl.ensureObserver("alice", fakeClientUser, "build", firstConfig);
      await prompted;
      let callB = impl.ensureObserver("alice", fakeClientUser, "build", secondConfig);

      // Another profile makes progress while Alice chooses, without opening her second prompt.
      await impl.ensureObserver("bob", fakeClientUser, "build", configureAll);
      let secondPromptsBeforeRelease = secondPrompts;
      let observerBeforeRelease = impl.storage.observers.get("alice");

      release();
      await Promise.all([callA, callB]);

      let alice = impl.storage.observers.get("alice")!;
      let bob = impl.storage.observers.get("bob")!;
      let aliceRegistrations = registrations.filter(entry => entry.observerId !== bob.observerId);
      expect(secondPromptsBeforeRelease).toBe(0);
      expect(observerBeforeRelease).toBeUndefined();
      expect(firstPrompts).toBe(1);
      expect(secondPrompts).toBe(0);
      expect(alice.accountChoices).toEqual({ 1: 10, 2: 20 });
      // Both opens register both connections, under the one id the first persisted.
      expect(aliceRegistrations).toHaveLength(4);
      expect(aliceRegistrations.every(entry => entry.observerId === alice.observerId)).toBe(true);
    });
  });

  it("releases the profile queue when account selection is refused", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-queue-refusal");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      setObserverFacets(impl);
      let release!: () => void;
      let reached!: () => void;
      let parked = new Promise<void>(resolve => { release = resolve; });
      let prompted = new Promise<void>(resolve => { reached = resolve; });
      // A rejected client RPC must release the same queue as a verifier refusal.
      let refusingConfig = configCallback(async () => {
        reached();
        await parked;
        throw new Error("account selection refused");
      });

      let refused = impl.ensureObserver("alice", fakeClientUser, "build", refusingConfig);
      refused.catch(() => {});
      await prompted;
      let admitted = impl.ensureObserver("alice", fakeClientUser, "build", configureAll);
      release();

      await expect(refused).rejects.toThrow("account selection refused");
      await admitted;
      expect(impl.storage.observers.get("alice")?.accountChoices).toEqual({ 1: 10, 2: 20 });
    });
  });
});
