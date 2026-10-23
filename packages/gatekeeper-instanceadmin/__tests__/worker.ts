// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// them, and adds a hook Durable Object that hosts the facet.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from `ctx.exports` is reachable
// only through `ctx.facets`, which is how the Overseer instantiates a gatekeeper in production.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { InstanceAdminGrant } from "@gadgets/workshop-shared/instance-admin";
import type { InstanceAdminGatekeeper } from "../src/worker.js";

// Named, not `export *`: the pool finds the entrypoints ctx.exports offers by reading this module's
// exports without bundling it, so a star re-export would hide them.
export { default } from "../src/worker.js";
export {
  GatekeeperVendor, InstanceAdminAccount, InstanceAdminGatekeeper, InstanceAdminVerifier,
} from "../src/worker.js";

/** The facet's entry points the Workshop never calls, each of which should refuse. */
export type RefusedEntryPoint = "startSession" | "applyAction" | "revertAction" | "addObserver";

/** Stands in for the ApprovalQueue and GitCache those entry points take; never called. */
class Unused extends RpcTarget {}
const unused = () => new RpcStub(new Unused()) as never;

/** The message `call` throws, or "did not throw". */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "did not throw";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  // Each case names its own facet, so no case sees another's state.
  #facet(name: string) {
    return this.ctx.facets.get<InstanceAdminGatekeeper>(name, () => ({
      class: this.ctx.exports.InstanceAdminGatekeeper({}),
    }));
  }

  async describe(name: string): Promise<ResourceDescription> {
    return this.#facet(name).describe();
  }

  async getTypeScriptTypes(name: string): Promise<string> {
    return this.#facet(name).getTypeScriptTypes();
  }

  async refusal(name: string, entry: RefusedEntryPoint): Promise<string> {
    const facet = this.#facet(name);
    switch (entry) {
      case "startSession": return refusal(() => facet.startSession(unused()));
      case "applyAction": return refusal(() => facet.applyAction(1, unused()));
      case "revertAction": return refusal(() => facet.revertAction(1));
      case "addObserver":
        return refusal(() => facet.addObserver("observer-1", this.ctx.exports.InstanceAdminVerifier({})));
    }
  }

  async rejectAction(name: string): Promise<void> {
    await this.#facet(name).rejectAction(1);
  }

  /** Opens a session through the facet's startAdminSession(), as the Overseer does. */
  async startAdminSession(name: string, grant: RpcStub<InstanceAdminGrant>) {
    return await this.#facet(name).startAdminSession(grant);
  }
}
