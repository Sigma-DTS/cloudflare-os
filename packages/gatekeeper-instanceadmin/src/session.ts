// The session the instance admin binding opens for each call: AdminApi as the generated surface
// declares it, every method a forward to the grant the Workshop lent this session. The session
// decides nothing; the grant runs the call, queues it for approval or refuses it.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { checkArguments } from "@gadgets/api-schema/check";
import { createLogger } from "@gadgets/observability/logger";
import {
  INSTANCE_ADMIN_VENDOR_ID, type InstanceAdminCallResult, type InstanceAdminGrant,
} from "@gadgets/workshop-shared/instance-admin";
import { ADMIN_METHODS, ADMIN_SCHEMA, approvalMessage } from "./surface.js";

// Event names only: a call's arguments, its result and the Admin API's errors (which can quote an
// argument) are the owner's deployment admin data, kept in their workspace's activity.
const logger = createLogger<{ vendorId: string }>({
  component: "gatekeeper.instanceadmin", vendorId: INSTANCE_ADMIN_VENDOR_ID,
});

/** Whether `value` is a capability, which only inspectWorkspace() answers with (a view). */
function isStub(value: unknown): value is RpcStub<RpcTarget> {
  return value instanceof RpcStub;
}

/**
 * AdminApi, served by forwarding each call to an InstanceAdminGrant.
 *
 * No @validateRpc(), the one exception to that rule here: its methods come from the schema at load,
 * so its TypeScript type declares none of them and a validator built from it would refuse them all.
 * #call checks each call's arguments against the schema instead, and the Workshop validates them
 * again, at its grant and at the Admin API.
 */
export class InstanceAdminSession extends RpcTarget {
  /** Real private: RPC exposes an RpcTarget's properties as well as its methods. */
  readonly #grant: RpcStub<InstanceAdminGrant>;

  /** Keeps `grant.dup()`: the argument is disposed when startAdminSession() returns. */
  constructor(grant: RpcStub<InstanceAdminGrant>) {
    super();
    this.#grant = grant.dup();
  }

  // One prototype method per AdminApi method, where Workers RPC exposes it. Defined inside the class
  // body so each reaches #call, and neither enumerable, writable nor configurable.
  static {
    for (const name of ADMIN_METHODS) {
      Object.defineProperty(InstanceAdminSession.prototype, name, {
        value: function (this: InstanceAdminSession, ...args: unknown[]) {
          return this.#call(name, args);
        },
      });
    }
  }

  /**
   * Checks the arguments, then asks the grant: an answer's value (a dup() of a capability, so it
   * outlives the grant's result), undefined for a queued change, and an Error saying what to do for
   * a call that waits for approval.
   */
  async #call(name: string, args: unknown[]): Promise<unknown> {
    const problems = checkArguments(ADMIN_SCHEMA, "AdminApi", name, args);
    if (problems.length > 0) {
      throw new TypeError(`Invalid arguments for AdminApi.${name}: ${problems.join("; ")}`);
    }
    let result;
    try {
      result = await this.#grant.callAdminApi(name, args);
    } catch (error) {
      logger.warn("admin api call failed", { event: "session.call_failed" });
      throw error;
    }
    // The RPC result's type drops the "answered" branch, whose value is `unknown`.
    const reply = result as InstanceAdminCallResult;
    try {
      switch (reply.outcome) {
        case "answered":
          return isStub(reply.value) ? reply.value.dup() : reply.value;
        case "queued":
          return undefined;
        case "needsApproval":
          throw new Error(approvalMessage(name, reply));
      }
    } finally {
      result[Symbol.dispose]();
    }
  }

  [Symbol.dispose](): void {
    this.#grant[Symbol.dispose]();
  }
}
