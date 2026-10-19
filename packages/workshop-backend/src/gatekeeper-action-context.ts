import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AgentContext, GatekeeperActionContext } from "@gadgets/workshop-shared/agent-integration";
import type { GitCache } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "./overseer";
import type { ActionRecord } from "./storage-schema/overseer-storage";
import { GitCacheImpl } from "./git-cache";

type Impl = OverseerDurableObject["impl"];

/** Apply-time scope expires with the dispatch; it never adopts a later turn's authority. */
@validateRpc()
export class GatekeeperActionContextImpl extends RpcTarget implements GatekeeperActionContext {
  #active = true;
  constructor(private impl: Impl, private record: ActionRecord & {type: "action"}) { super(); }
  #check() {
    if (!this.#active || !this.impl.integrationGrant(this.record.gatekeeperId).contextualActions) {
      throw new Error("Action context expired or grant revoked.");
    }
  }
  [Symbol.dispose]() { this.#active = false; }
  async getGitCache(): Promise<GitCache> {
    this.#check();
    return new GitCacheImpl(this.impl.gitCache, this.record.gatekeeperId, this.record.id);
  }
  async getAgentContext(): Promise<AgentContext | null> {
    this.#check();
    const origin = this.record.integrationOrigin;
    const current = origin && this.impl.storage.activeAgents.get(origin.chatId)?.integration;
    if (!origin || current?.turnId !== origin.turnId) return null;
    return this.impl.integrations.context(this.record.gatekeeperId,
      {...origin, segmentId: current.segmentId}, "applyingAction", () => this.#active);
  }
}
