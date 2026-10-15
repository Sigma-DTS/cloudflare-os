// The Worker the unit suites run inside: the production Worker's exports (so `ctx.exports` resolves
// the real Durable Objects and callbacks) plus test-only entrypoints that stand in for other Workers.

import { DurableObject, RpcTarget, WorkerEntrypoint, restore, type RpcStub } from "cloudflare:workers";
import type { AccountDescription, ActionDescription, Gatekeeper, ApprovalQueue, GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import type { AgentContext, AgentTurnEvent, AgentTurnInfo, AgentTurnParticipant,
  GatekeeperActionContext } from "@gadgets/workshop-shared/agent-integration";
import { GatekeeperConnectCallbackImpl } from "../src/user.js";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow.js";
import { OverseerDurableObject as RealOverseerDurableObject } from "../src/server.js";
import { GatekeeperLoopback as RealGatekeeperLoopback } from "../src/overseer";

export * from "../src/server.js";
export { default } from "../src/server.js";

/**
 * The pool stands a proxy class in front of every Durable Object (`createDurableObjectWrapper`) and
 * forwards only string-keyed methods to the instance it constructs, so when the runtime looks up
 * `[restore]` on the entrypoint -- which is what `ctx.restore()` does -- it finds nothing. The
 * wrapper's prototype chain does end at `DurableObject.prototype`, and it hands the instance the
 * very `ctx` it was given, so a `[restore]()` there can route by `ctx` to any instance that has
 * registered itself (below).
 */
const restoreTargets = new WeakMap<DurableObjectState, DurableObject>();
function bridgedRestore(this: DurableObject, params: unknown): unknown {
  const target = restoreTargets.get(this.ctx) as { [restore]?: (params: unknown) => unknown } | undefined;
  if (target?.[restore] === undefined || target[restore] === bridgedRestore) {
    throw new TypeError("This Durable Object does not implement a [restore]() method.");
  }
  return target[restore](params);
}
(DurableObject.prototype as unknown as Record<symbol, unknown>)[restore] = bridgedRestore;

/** The overseer, registered for the bridge above so tests can exercise `ctx.restore()`. */
export class OverseerDurableObject extends RealOverseerDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    restoreTargets.set(ctx, this);
  }

}
/**
 * The `self` object / spawnCallable() stub entrypoint, named explicitly for the same reason as the
 * callbacks below: the overseer mints it through `ctx.exports.AgentSelfLoopback({props})`.
 */
export { AgentSelfLoopback } from "../src/server.js";
/** What a loaded gadget's `env.GADGET` and tail worker are minted from, likewise. */
export { GadgetTailLoopback } from "../src/server.js";
/**
 * The pool invokes declared prototype methods, bypassing the constructor's dynamic session
 * proxy. Forward the fixture API through that real proxy so binding tests exercise its routing.
 */
export class GatekeeperLoopback extends WorkerEntrypoint<Cloudflare.Env, ConstructorParameters<typeof RealGatekeeperLoopback>[0]["props"]> {
  #open() {
    return new RealGatekeeperLoopback(this.ctx, this.env) as RealGatekeeperLoopback & Fetcher<IntegrationTestSession>;
  }
  getTurn(): Promise<AgentTurnInfo | null> { return this.#open().getTurn(); }
  submitAction(...args: Parameters<IntegrationTestSession["submitAction"]>): Promise<void> {
    return this.#open().submitAction(...args);
  }
}
/** What an executeCode run's tail worker is minted from, likewise. */
export { CodeModeTailLoopback } from "../src/server.js";
/**
 * The Workshop's connect callback, reachable through `ctx.exports`: the pool derives those from this
 * module's own declarations, so an entrypoint a test reaches that way has to be named here rather
 * than covered by the `export *`.
 */
export class TestConnectCallback extends GatekeeperConnectCallbackImpl {}
/** The sign-in callback, reachable the same way. */
export class TestLoginCallback extends LoginConnectCallbackImpl {}

/** What each FakeGatekeeperAccount has been asked to do, by its `name` prop. */
const accountCalls = new Map<string, string[]>();

/**
 * A gatekeeper account as the Workshop sees one: a persistent stub it can store and call back into.
 * Records calls by `props.name` so a test can ask any instance what happened (`calls()`); with
 * `failRevoke` / `failDescribe`, that method rejects after being recorded.
 */
export class FakeGatekeeperAccount
    extends WorkerEntrypoint<unknown, { name: string; failRevoke?: boolean; failDescribe?: boolean }> {
  #record(call: string) {
    const calls = accountCalls.get(this.ctx.props.name) ?? [];
    calls.push(call);
    accountCalls.set(this.ctx.props.name, calls);
  }

  async describe(): Promise<AccountDescription> {
    this.#record("describe");
    if (this.ctx.props.failDescribe) throw new Error("describe failed");
    return { displayName: this.ctx.props.name, uniqueName: this.ctx.props.name };
  }

  async revoke(): Promise<void> {
    this.#record("revoke");
    if (this.ctx.props.failRevoke) throw new Error("revoke failed");
  }

  async commitReconnect(stageId: string): Promise<void> {
    this.#record(`commitReconnect(${stageId})`);
  }

  async reconnect(): Promise<{ url: string }> {
    this.#record("reconnect");
    return { url: `https://gk.example/reconnect/${this.ctx.props.name}` };
  }

  /**
   * Nothing to grant for an empty list, as a real gatekeeper answers when the grant already covers
   * every requested resource.
   */
  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    this.#record(`ensureResources(${resourceUrlPatterns.join(",")})`);
    if (resourceUrlPatterns.length === 0) return {};
    return { url: `https://gk.example/expand/${this.ctx.props.name}` };
  }

  async calls(): Promise<string[]> {
    return accountCalls.get(this.ctx.props.name) ?? [];
  }
}

const integrationCallbacks = new Map<string, { fail: boolean; reregister?: boolean;
  blocked?: {kind: AgentTurnEvent["kind"]; wait: Promise<void>; release: () => void};
  calls: { event: AgentTurnEvent; turn: AgentTurnInfo }[] }>();

/** A genuinely persistent native callback, so outbox tests cross RPC and DO storage boundaries. */
export class IntegrationTestParticipant extends WorkerEntrypoint<unknown, { name: string }>
    implements AgentTurnParticipant {
  #state() {
    let state = integrationCallbacks.get(this.ctx.props.name);
    if (!state) integrationCallbacks.set(this.ctx.props.name, state = { fail: false, calls: [] });
    return state;
  }
  async onAgentTurnEvent(event: AgentTurnEvent, context: RpcStub<AgentContext>): Promise<void> {
    using borrowed = context;
    const call = {event, turn: await borrowed.getTurn()};
    this.#state().calls.push(call);
    if (this.#state().reregister && (event.kind === "started" || event.kind === "resumed")) {
      const exports = this.ctx.exports as typeof this.ctx.exports & {
        IntegrationTestParticipant(options: {props: {name: string}}): Fetcher<IntegrationTestParticipant>;
      };
      await borrowed.participate(exports.IntegrationTestParticipant({props: this.ctx.props}));
    }
    const blocked = this.#state().blocked;
    if (blocked?.kind === event.kind) await blocked.wait;
    if (this.#state().fail) throw new Error("participant unavailable");
  }
  setFailure(fail: boolean): void { this.#state().fail = fail; }
  setReregister(): void { this.#state().reregister = true; }
  block(kind: AgentTurnEvent["kind"]): void {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    this.#state().blocked = {kind, wait, release};
  }
  releaseBlock(): void {
    this.#state().blocked?.release();
    delete this.#state().blocked;
  }
  calls() { return this.#state().calls; }
}

/** Real facet RPC dispatch: contextual failure must never fall back to the legacy handler. */
export class IntegrationTestActionGatekeeper extends DurableObject<Cloudflare.Env>
    implements Gatekeeper<object> {
  async describe() { return { url: "container://test", title: "Test", suggestedBindingName: "TEST", tsType: "object" }; }
  async getTypeScriptTypes(): Promise<string> { return ""; }
  async getAutoApprovableActions() { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<IntegrationTestSession> {
    using borrowed = queue;
    return new IntegrationTestSession(borrowed.dup());
  }
  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
  async rejectAction(_action: number): Promise<void> {}
  async revertAction(_action: number): Promise<void> {}
  async applyAction(action: number): Promise<void> { this.#record({ action, handler: "legacy" }); }
  async applyActionInContext(action: number, context: RpcStub<GatekeeperActionContext>): Promise<void> {
    using borrowed = context;
    if (this.ctx.storage.kv.get(`receipt:${action}`)) return;
    using agent = await borrowed.getAgentContext();
    this.#record({ action, handler: "contextual", turn: agent ? await agent.getTurn() : null });
    const followup = this.ctx.storage.kv.get<ActionDescription>("followup");
    if (action === 42 && followup) {
      await borrowed.submitAction(43, followup);
      await borrowed.submitAction(43, followup); // Lost-ACK replay must not publish a second card.
    }
    if (this.ctx.storage.kv.get("fail")) throw new Error("Contextual handler failed");
    if (this.ctx.storage.kv.get("recoverable")) this.ctx.storage.kv.put(`receipt:${action}`, true);
  }
  setRecoverable(): void { this.ctx.storage.kv.put("recoverable", true); }
  setFollowup(description: ActionDescription): void { this.ctx.storage.kv.put("followup", description); }
  setFailure(fail: boolean): void { this.ctx.storage.kv.put("fail", fail); }
  calls(): { action: number; handler: string; turn?: AgentTurnInfo | null }[] {
    return this.ctx.storage.kv.get("calls") ?? [];
  }
  #record(call: ReturnType<IntegrationTestActionGatekeeper["calls"]>[number]): void {
    this.ctx.storage.kv.put("calls", [...this.calls(), call]);
  }
}

class IntegrationTestSession extends RpcTarget {
  constructor(private queue: RpcStub<ApprovalQueue>) { super(); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
  async getTurn(): Promise<AgentTurnInfo | null> {
    using context = await this.queue.getAgentContext();
    return context ? await context.getTurn() : null;
  }
  submitAction(action: number, description: ActionDescription): Promise<void> {
    return this.queue.submitAction(action, description);
  }
}
