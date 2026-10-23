// The facet and the sessions it opens. Every session comes from the facet's startAdminSession(),
// over RPC, in the capnwebValidate() build: so these cases fail if that method loses its
// @skipRpcValidation(), which would wrap the session in a proxy refusing every AdminApi method.

import { env } from "cloudflare:test";
import { RpcTarget, exports } from "cloudflare:workers";
import type { InstanceAdminCallResult } from "@gadgets/workshop-shared/instance-admin";
import { describe, expect, it, vi } from "vitest";
import { adminDeclarations, approvalMessage } from "../../src/surface.js";

const hooks = env.TEST_HOOKS.getByName("hooks");

/** The session's stub, as the agent's code sees it: AdminApi's methods, which its type can't name. */
type AdminSession = Disposable & Record<string, (...args: unknown[]) => Promise<any>>;

/** Stands in for the Workshop's grant: answers each call with `answer`, and records it. */
class FakeGrant extends RpcTarget {
  readonly calls: { method: string; args: unknown[] }[] = [];
  disposed = 0;
  readonly #answer: (method: string) => InstanceAdminCallResult;

  constructor(answer: (method: string) => InstanceAdminCallResult) {
    super();
    this.#answer = answer;
  }

  async callAdminApi(method: string, args: unknown[]): Promise<InstanceAdminCallResult> {
    this.calls.push({ method, args });
    return this.#answer(method);
  }

  [Symbol.dispose](): void {
    this.disposed++;
  }
}

/** Stands in for the AdminWorkspaceView the Workshop answers inspectWorkspace() with. */
class FakeView extends RpcTarget {
  disposed = 0;

  async listChats(): Promise<{ id: number }[]> {
    return [{ id: 1 }];
  }

  [Symbol.dispose](): void {
    this.disposed++;
  }
}

let facets = 0;

/** A session from a facet of its own, over `grant`. */
async function openSession(grant: FakeGrant): Promise<AdminSession> {
  return await hooks.startAdminSession(`session-${++facets}`, grant as never) as unknown as AdminSession;
}

const answered = (value: unknown) => (): InstanceAdminCallResult => ({ outcome: "answered", value });

/**
 * What `call` rejects with. Settled through then() alone: `expect(...).rejects` reads other
 * properties of the RPC promise, each a pipelined promise of its own that rejects unhandled.
 */
function rejection(call: Promise<unknown>): Promise<unknown> {
  return call.then(() => new Error("did not reject"), (error: unknown) => error);
}

/** The message of what `call` rejects with. */
async function rejectionMessage(call: Promise<unknown>): Promise<string> {
  return ((await rejection(call)) as Error).message;
}

describe("the facet", () => {
  it("describes the binding and serves the generated declarations", async () => {
    expect(await hooks.describe("describe")).toEqual({
      url: "instanceadmin://deployment",
      title: "Instance admin",
      snippet: "This deployment's Admin API, as the workspace's owner.",
      suggestedBindingName: "INSTANCE_ADMIN",
      tsType: "AdminApi",
    });
    expect(await hooks.getTypeScriptTypes("types")).toBe(adminDeclarations());
  });

  it("refuses the entry points the Workshop never calls on it", async () => {
    expect(await hooks.refusal("refuse", "startSession"))
      .toBe("The Workshop opens instance admin sessions with startAdminSession() only.");
    expect(await hooks.refusal("refuse", "applyAction")).toMatch(/submits no actions/);
    expect(await hooks.refusal("refuse", "revertAction")).toMatch(/submits no actions/);
    expect(await hooks.refusal("refuse", "addObserver"))
      .toBe("Nobody but this workspace's owner can see what the instance admin binding read.");
    expect(await hooks.rejectAction("refuse")).toBeUndefined();
  });

  it("gives the account no URL-addressed resources", async () => {
    const account = exports.InstanceAdminAccount({});
    const message = "The instance admin gatekeeper has no URL-addressed resources.";
    expect(await rejectionMessage(account.getGatekeeperClassFor("instanceadmin://deployment")))
      .toBe(message);
    expect(await rejectionMessage(account.startResourceConfigurator("instanceadmin://*")))
      .toBe(message);
  });
});

describe("a session", () => {
  it("returns a read's value unchanged", async () => {
    const value = { signupsEnabled: true, siteName: "Example", formats: [{ noun: "note" }] };
    const grant = new FakeGrant(answered(value));
    using session = await openSession(grant);

    expect(await session.getSettings()).toEqual(value);
    expect(grant.calls).toEqual([{ method: "getSettings", args: [] }]);
  });

  it("keeps a capability callable after the call that returned it", async () => {
    const view = new FakeView();
    const grant = new FakeGrant(answered(view));
    using session = await openSession(grant);

    // The session disposes the grant's result before it returns; the view it passes on is a dup().
    using returned = await session.inspectWorkspace("workspace-1", "Support ticket 12");
    expect(await returned.listChats()).toEqual([{ id: 1 }]);
    expect(view.disposed).toBe(0);
    expect(grant.calls).toEqual([
      { method: "inspectWorkspace", args: ["workspace-1", "Support ticket 12"] },
    ]);
  });

  it("resolves a queued change to undefined", async () => {
    const grant = new FakeGrant(() => ({ outcome: "queued", actionId: 7 }));
    using session = await openSession(grant);

    expect(await session.setSiteName("Example")).toBeUndefined();
    expect(grant.calls).toEqual([{ method: "setSiteName", args: ["Example"] }]);
  });

  it("throws what to do for each call that waits for approval", async () => {
    for (const reason of ["activate", "confirm", "inspect"] as const) {
      for (const existing of [false, true]) {
        const approval = { outcome: "needsApproval", actionId: 9, existing, reason } as const;
        using session = await openSession(new FakeGrant(() => approval));

        expect(await rejectionMessage(session.testGatewayModel("@cf/model")))
          .toBe(approvalMessage("testGatewayModel", approval));
      }
    }
  });

  it("refuses bad arguments before they reach the grant", async () => {
    const grant = new FakeGrant(answered(undefined));
    using session = await openSession(grant);

    const wrongType = await rejection(session.setSiteName(42));
    expect(wrongType).toBeInstanceOf(TypeError);
    expect((wrongType as TypeError).message)
      .toBe("Invalid arguments for AdminApi.setSiteName: name: expected string");
    expect(await rejection(session.setSiteName("one", "two"))).toBeInstanceOf(TypeError);
    expect(grant.calls).toEqual([]);
  });

  it("exposes nothing but AdminApi's methods", async () => {
    const grant = new FakeGrant(answered(undefined));
    using session = await openSession(grant);

    expect(await rejectionMessage(session.deleteEverything()))
      .toMatch(/does not implement the method "deleteEverything"/);
    expect(await rejectionMessage(session.callAdminApi("setSiteName", ["Example"])))
      .toMatch(/does not implement the method "callAdminApi"/);
    // workerd may resolve a missing property to undefined rather than reject; either way, no grant.
    const grantProperty = await (session.grant as unknown as Promise<unknown>).catch(() => undefined);
    expect(grantProperty).toBeUndefined();
    expect(grant.calls).toEqual([]);
  });

  it("disposes the grant when it is disposed", async () => {
    const grant = new FakeGrant(answered(true));
    const session = await openSession(grant);
    await session.isBlueprintFeatured("blueprint-1");
    expect(grant.disposed).toBe(0);

    session[Symbol.dispose]();
    await vi.waitFor(() => expect(grant.disposed).toBe(1));
  });

  it("passes on the message of an error the grant throws", async () => {
    const grant = new FakeGrant(() => {
      throw new Error("No such model: @cf/missing");
    });
    using session = await openSession(grant);

    expect(await rejectionMessage(session.testGatewayModel("@cf/missing")))
      .toBe("No such model: @cf/missing");
  });
});
