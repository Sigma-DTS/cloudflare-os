// Denying an action through OverseerImpl.rejectPendingAction always resolves it, even when the
// gatekeeper refuses to withdraw it or the connection is gone; only then is it flagged
// outcomeUnconfirmed. Runs against a real OverseerDurableObject (the TEST_OVERSEER binding), with
// the gatekeeper facet stubbed on the instance as git-push-actions.test.ts does.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const GATEKEEPER = 3;
const USER = { type: "user" as const, id: "alice@example.com", name: "Alice" };
const SEND: ActionDescription = {
  title: "Send an email",
  description: "Sends the email.",
  implementsRevert: false,
};
const LABEL: ActionDescription = {
  title: "Label an email",
  description: "Labels the email.",
  implementsRevert: false,
  autoApprovable: true,
  actionKind: { tag: "label", label: "Labels" },
};

async function inOverseer(name: string, fn: (impl: any) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_OVERSEER.getByName(name),
      async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.storage.gatekeepers.put({
      id: GATEKEEPER,
      resourceTitle: "Mailbox",
      class: {} as any,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: "https://example.com/mailbox",
        typeUrlPattern: "https://*",
      },
    });
    await fn(impl);
  });
}

function queue(impl: any, id: number, description: ActionDescription,
               caller: object = { from: "user" }): any {
  let record = {
    id, gatekeeperId: GATEKEEPER, caller, createdAt: new Date(), state: "pending",
    type: "action", action: id, description,
  };
  impl.storage.actions.put(record);
  impl.storage.nextActionId.put(id + 1);
  return impl.storage.actions.get(id);
}

describe("rejectPendingAction", () => {
  it("denies an action whose gatekeeper refuses, resuming the agent turn and the drain behind it",
      async () => {
    await inOverseer("reject-refused", async impl => {
      let warn = vi.spyOn(impl.logger, "warn").mockImplementation(() => {});
      let resumed = vi.spyOn(impl, "resumeAgentAfterDecision").mockImplementation(() => {});
      let applied: number[] = [];
      impl.getGatekeeperFacet = async () => ({
        async rejectAction() { throw new Error("The send's outcome is unknown."); },
        async applyAction(action: number) { applied.push(action); },
      });
      impl.storage.autoApproveTags.put(
          { gatekeeperId: GATEKEEPER, actionKind: LABEL.actionKind, enabledBy: USER });
      let send = queue(impl, 1, SEND, { from: "agent", chatId: 9 });
      queue(impl, 2, LABEL);

      // The manual action ahead holds back the auto-approvable one.
      await impl.drainAutoApprovals(GATEKEEPER);
      expect(applied).toEqual([]);

      await impl.rejectPendingAction(send, USER);

      let rejected = impl.storage.actions.get(1);
      expect(rejected.state).toBe("rejected");
      expect(rejected.outcomeUnconfirmed).toBe(true);
      expect(rejected.resolvedBy).toEqual(USER);
      expect(warn).toHaveBeenCalledWith(expect.any(String),
          expect.objectContaining({ event: "action.reject.unconfirmed", actionId: 1 }));
      expect(resumed).toHaveBeenCalledWith(9, 1);

      await impl.drainAutoApprovals(GATEKEEPER);
      expect(applied).toEqual([2]);
      expect(impl.storage.actions.get(2).state).toBe("approved");
    });
  });

  it("denies an action whose connection was removed, with no facet to ask", async () => {
    await inOverseer("reject-orphaned", async impl => {
      vi.spyOn(impl.logger, "warn").mockImplementation(() => {});
      let send = queue(impl, 1, SEND);
      impl.storage.gatekeepers.delete(GATEKEEPER);

      await impl.rejectPendingAction(send, USER);

      let rejected = impl.storage.actions.get(1);
      expect(rejected.state).toBe("rejected");
      expect(rejected.outcomeUnconfirmed).toBe(true);
    });
  });

  it("leaves a denial the gatekeeper confirmed unflagged", async () => {
    await inOverseer("reject-confirmed", async impl => {
      let withdrawn: number[] = [];
      impl.getGatekeeperFacet = async () => ({
        async rejectAction(action: number) { withdrawn.push(action); },
      });
      let send = queue(impl, 1, SEND);

      await impl.rejectPendingAction(send, USER);

      expect(withdrawn).toEqual([1]);
      let rejected = impl.storage.actions.get(1);
      expect(rejected.state).toBe("rejected");
      expect(rejected.outcomeUnconfirmed).toBeUndefined();
    });
  });
});
