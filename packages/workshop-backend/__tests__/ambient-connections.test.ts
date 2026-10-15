import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall }
  from "@earendil-works/pi-ai";
import type { AiChatMessage, GatekeeperVendorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { UserDurableObject } from "../src/user.js";
import { DEFAULT_ADMIN_CONFIG, serializeAdminConfig } from "../src/admin-config.js";
import { openFakeOverseer } from "./fixtures.js";
import { runAgent } from "../src/agent.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const container: GatekeeperVendorInfo = {
  id: "container", description: {
    displayName: "Linux Container", url: "https://workshop.example/",
    autoProvisionsAccount: true,
  }, supportedResources: [],
};
const repository: GatekeeperVendorInfo = {
  id: "github", description: { displayName: "GitHub", url: "https://github.com" },
  supportedResources: [{ title: "Repository", description: "Git repository",
    urlPattern: "https://github.com/:owner/:repo" }],
};
const request = { vendorId: "container", bindingName: "CONTAINER", reason: "Run unit tests." };
const author = { type: "agent" as const, id: "test-model", name: "Test model" };

function userForDiscovery(mode: "optional" | "enabled" | "disabled" = "optional") {
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env: { BLUEPRINTS: { get: async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: { container: mode } }) } },
    storage: { profile: { get: () => ({ id: "owner" }) } },
    vendors: new Map([container, repository].map(vendor => [vendor.id, {
      describe: async () => vendor.description,
      getSupportedResources: async () => vendor.supportedResources,
    }])),
  });
  return user;
}

describe("ambient account discovery", () => {
  it("keeps resource pickers resource-only but offers optional accounts to the agent", async () => {
    const user = userForDiscovery();
    expect((await user.listGatekeeperVendors()).map(v => v.id)).toEqual(["github"]);
    expect((await user.listGatekeeperVendors({}, true)).map(v => v.id))
      .toEqual(["container", "github"]);
  });
  it.each(["optional", "enabled"] as const)("offers %s accounts without provisioning them", async mode => {
    expect((await userForDiscovery(mode).listGatekeeperVendors({}, true)).map(v => v.id))
      .toContain("container");
  });
  it("does not offer administratively disabled accounts", async () => {
    expect((await userForDiscovery("disabled").listGatekeeperVendors({}, true)).map(v => v.id))
      .toEqual(["github"]);
  });
});

let sequence = 0;
async function workspace(test: (fixture: {
  impl: any;
  owner: {
    provisionAmbientAccount: ReturnType<typeof vi.fn>;
    listGatekeeperVendors: ReturnType<typeof vi.fn>;
    listProvidedAccounts: ReturnType<typeof vi.fn>;
    getSingletonGatekeeperClass: ReturnType<typeof vi.fn>;
  };
  client: Awaited<ReturnType<typeof openFakeOverseer>>;
  resume: ReturnType<typeof vi.fn>;
  persistRequest: (options?: typeof request) => Promise<AiChatMessage & { type: "connectionRequest" }>;
}) => Promise<void>, vendors = [container, repository]) {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`ambient-connections-${++sequence}`),
      async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as { impl: any }).impl;
    const added = new Set<string>();
    const owner = {
      id: { toString: () => "owner-id" },
      listGatekeeperVendors: vi.fn(async () => vendors),
      provisionAmbientAccount: vi.fn(async (vendorId: string) => { added.add(vendorId); }),
      listProvidedAccounts: vi.fn(async () => vendors.flatMap((vendor, index) => added.has(vendor.id)
        ? [{ accountId: index + 5, vendorId: vendor.id, description: {
          displayName: vendor.description.displayName, uniqueName: vendor.id, singleton: { tsType: "{}" },
        } }] : [])),
      getSingletonGatekeeperClass: vi.fn(async () => impl.ctx.exports.AgentSpawnerGatekeeper({ props: {
        overseerId: impl.ctx.id.toString(), config: { displayName: "Container fixture", modelId: null, env: {} },
      } })),
      whoami: async () => ({ id: "owner-profile", name: "Owner" }),
      setGadgetLastActive: async () => {},
      getChatContext: async () => ({ profile: { type: "user", id: "owner", name: "Owner" },
        aiModel: { profile: author, config: {} } }),
    };
    impl.ownerId = "owner-id";
    impl.users = { idFromString: (id: string) => id, get: () => owner };
    impl.storage.chatMeta.put({ id: 1, title: "Tests", started: new Date(0), lastActive: new Date(0) });
    impl.storage.chatContext.put({ chatId: 1, bindings: {}, alwaysAvailableCapsuleIds: [] });
    impl.storage.chats.put({ chatId: 1, sequence: 0, timestamp: new Date(0), author,
      type: "message", message: "I need to run unit tests." });
    const resume = vi.fn();
    const client = await openFakeOverseer(impl.storage, { impl: {
      users: impl.users, startAgent: resume, waitForChatMessagePreparation: () => undefined,
      getChatTimestamp: () => impl.getChatTimestamp(), ensureAmbientCapsules: () => impl.ensureAmbientCapsules(),
    } });
    let requestSequence = 1;
    const persistRequest = async (options = request) => {
      expect(await impl.requestConnection(1, options)).toMatchObject({ requested: true });
      const [body] = impl.consumeCapturedConnectionRequests(1);
      const card = { ...body, chatId: 1, sequence: requestSequence++, timestamp: impl.getChatTimestamp(), author };
      impl.storage.chats.put(card);
      return card;
    };
    try { await test({ impl, owner, client, resume, persistRequest }); }
    finally { client[Symbol.dispose](); }
  });
}

describe("on-demand ambient connection requests", () => {
  it("offers the container and creates a prompt without provisioning or starting it", () => workspace(async f => {
    expect(await f.impl.listConnectableVendors()).toContainEqual({ id: "container", displayName: "Linux Container" });
    expect(f.owner.listGatekeeperVendors).toHaveBeenCalledWith({}, true);
    const instructions = await f.impl.listConnectableResources("container");
    expect(instructions).toContain("omitting resourceUrl");
    expect(instructions).toContain("The workspace owner can connect it directly in chat");
    expect(instructions).toContain("this does not approve any subsequent actions");
    const card = await f.persistRequest();
    expect(card).toMatchObject({ ...request, type: "connectionRequest", connectionType: "ambient", state: "pending" });
    expect(card.resourceUrlPattern).toBeUndefined();
    expect(f.owner.provisionAmbientAccount).not.toHaveBeenCalled();
    expect([...f.impl.storage.gatekeepers.list()]).toEqual([]);
  }));

  it("accepts into an already-started chat and resumes without approving an action", () => workspace(async f => {
    const card = await f.persistRequest();
    await f.client.acceptConnectionRequest(card.requestId);
    expect(f.owner.provisionAmbientAccount).toHaveBeenCalledWith("container");
    const [capsule] = [...f.impl.storage.gatekeepers.list()];
    expect(capsule.creationSpec).toEqual({ type: "ambient", vendorId: "container", accountId: 5 });
    const decided = [...f.impl.storage.chats.list()].find(m => m.type === "connectionRequest");
    expect(decided).toMatchObject({ state: "accepted", bindingName: "CONTAINER", gatekeeperId: capsule.id });
    expect(f.resume).toHaveBeenCalledOnce();
    // History introduces the explicitly accepted binding; do not silently rewrite the frozen seed.
    expect(f.impl.storage.chatContext.get(1)).toMatchObject({ bindings: {}, alwaysAvailableCapsuleIds: [] });
    expect([...f.impl.storage.actions.list()]).toEqual([]);
    await f.impl.ensureAmbientCapsules();
    expect([...f.impl.storage.gatekeepers.list()]).toHaveLength(1);
  }));

  it("refreshes the account snapshot for concurrent acceptances without duplicating capsules", () => {
    const scheduler = { ...container, id: "scheduler", description: {
      ...container.description, displayName: "Scheduled Tasks",
    } };
    return workspace(async f => {
      const firstCard = await f.persistRequest();
      const secondCard = await f.persistRequest({
        vendorId: "scheduler", bindingName: "SCHEDULER", reason: "Schedule a follow-up.",
      });
      await f.impl.ensureAmbientCapsules();
      const firstSnapshotRead = Promise.withResolvers<void>();
      const releaseFirstPass = Promise.withResolvers<void>();
      const secondReconcileRequested = Promise.withResolvers<void>();
      const getClass = f.owner.getSingletonGatekeeperClass.getMockImplementation()!;
      f.owner.getSingletonGatekeeperClass.mockImplementationOnce(async () => {
        firstSnapshotRead.resolve();
        await releaseFirstPass.promise;
        return getClass();
      });
      const reconcile = f.impl.ensureAmbientCapsules.bind(f.impl);
      let calls = 0;
      vi.spyOn(f.impl, "ensureAmbientCapsules").mockImplementation(() => {
        const pending = reconcile();
        if (++calls === 2) secondReconcileRequested.resolve();
        return pending;
      });

      const firstAccept = f.client.acceptConnectionRequest(firstCard.requestId);
      await firstSnapshotRead.promise;
      // The first pass already captured just the container account. Provision Scheduler now,
      // and ensure its acceptance joins reconciliation before allowing that older pass to finish.
      const secondAccept = f.client.acceptConnectionRequest(secondCard.requestId);
      const accepted = Promise.all([firstAccept, secondAccept]);
      await secondReconcileRequested.promise;
      releaseFirstPass.resolve();
      await accepted;

      expect([...f.impl.storage.gatekeepers.list()].map(gk => gk.creationSpec.vendorId).toSorted())
        .toEqual(["container", "scheduler"]);
      expect(f.owner.getSingletonGatekeeperClass).toHaveBeenCalledTimes(2);
      const cards = [...f.impl.storage.chats.list()].filter(m => m.type === "connectionRequest");
      expect(cards.map(card => card.state)).toEqual(["accepted", "accepted"]);
      expect(new Set(cards.map(card => card.gatekeeperId)).size).toBe(2);
      expect(f.resume).toHaveBeenCalledOnce();
    }, [container, scheduler, repository]);
  });

  it("does not let a failed reconciliation poison a queued fresh pass", () => workspace(async f => {
    await f.impl.ensureAmbientCapsules();
    await f.owner.provisionAmbientAccount("container");
    f.owner.listProvidedAccounts.mockRejectedValueOnce(new Error("Account lookup interrupted."));
    const failed = f.impl.ensureAmbientCapsules();
    const retry = f.impl.ensureAmbientCapsules();
    await expect(failed).rejects.toThrow("Account lookup interrupted.");
    await expect(retry).resolves.toBeUndefined();
    expect([...f.impl.storage.gatekeepers.list()]).toHaveLength(1);
  }));

  it("replays the accepted binding into the agent's env without reseeding the chat", () => workspace(async f => {
    const user = { type: "user" as const, id: "owner", name: "Owner" };
    f.impl.storage.chats.put({ chatId: 1, sequence: 0, timestamp: new Date(0), author: user,
      type: "message", message: "Run unit tests." });
    f.impl.getInstanceInstructions = async () => "";
    f.impl.describeStandardFormats = async () => "";
    const faux = createFauxCore({ models: [{ id: "test-model" }] });
    const run = () => runAgent(f.impl, { model: faux.getModel(), stream: faux.stream }, 1,
      author, new AbortController().signal, user,
      { provider: "cloudflare", model: "test-model", apiToken: "" } as any);
    const toolSets: string[][] = [];
    faux.setResponses([context => {
      toolSets.push(context.messages.flatMap(message =>
        message.role === "system" ? (message.toolsAdded ?? []).map(tool => tool.name) : []));
      return fauxAssistantMessage(fauxToolCall("requestConnection", request), { stopReason: "toolUse" });
    }]);
    await run();
    const card = [...f.impl.storage.chats.list()].find(m => m.type === "connectionRequest");
    expect(card).toMatchObject({ connectionType: "ambient", state: "pending" });
    expect(f.owner.provisionAmbientAccount).not.toHaveBeenCalled();
    await f.client.acceptConnectionRequest(card.requestId);
    faux.setResponses([
      context => {
        toolSets.push(context.messages.flatMap(message =>
          message.role === "system" ? (message.toolsAdded ?? []).map(tool => tool.name) : []));
        return fauxAssistantMessage(fauxToolCall("describeBinding", { name: "CONTAINER" }),
          { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxText("Container connected; command approval is separate.")),
    ]);
    await run();
    const calls = [...f.impl.storage.chats.list()].flatMap(m => m.type === "message" ? m.toolCalls ?? [] : []);
    expect(calls.find(call => call.toolName === "describeBinding")).toMatchObject({
      input: { name: "CONTAINER" }, output: expect.any(String),
    });
    expect(calls.find(call => call.toolName === "describeBinding").error).toBeUndefined();
    expect(f.impl.storage.chatContext.get(1).bindings).toEqual({});
    expect([...f.impl.storage.actions.list()]).toEqual([]);
    // Neither an unconnected chat nor a connected one gets an unapproved kernel shell fallback.
    expect(toolSets).toHaveLength(2);
    for (const tools of toolSets) {
      expect(tools).toContain("executeCode");
      expect(tools).not.toContain("executePosix");
      expect(tools).not.toContain("shutdownContainer");
    }
  }));

  it("denies without provisioning or resuming", () => workspace(async f => {
    const card = await f.persistRequest();
    await f.client.denyConnectionRequest(card.requestId);
    expect(f.owner.provisionAmbientAccount).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
  }));

  it("rechecks policy at acceptance and leaves a failed request retryable", () => workspace(async f => {
    const card = await f.persistRequest();
    f.owner.provisionAmbientAccount.mockRejectedValueOnce(new Error("Gatekeeper is disabled."));
    await expect(f.client.acceptConnectionRequest(card.requestId)).rejects.toThrow("disabled");
    expect([...f.impl.storage.chats.list()].find(m => m.type === "connectionRequest").state).toBe("pending");
    expect(f.resume).not.toHaveBeenCalled();
    await f.client.acceptConnectionRequest(card.requestId);
    expect(f.resume).toHaveBeenCalledOnce();
  }));

  it("does not overwrite a concurrent denial while provisioning", () => workspace(async f => {
    const card = await f.persistRequest();
    const provision = f.owner.provisionAmbientAccount.getMockImplementation()!;
    f.owner.provisionAmbientAccount.mockImplementationOnce(async vendorId => {
      await f.client.denyConnectionRequest(card.requestId);
      await provision(vendorId);
    });
    await expect(f.client.acceptConnectionRequest(card.requestId)).rejects.toThrow("Connection request is not pending");
    expect([...f.impl.storage.gatekeepers.list()]).toHaveLength(1);
    expect([...f.impl.storage.chats.list()].find(m => m.type === "connectionRequest").state).toBe("denied");
    expect(f.resume).not.toHaveBeenCalled();
  }));

  it("rejects ambient resource URLs and caller-selected gatekeepers", () => workspace(async f => {
    expect(await f.impl.requestConnection(1, { ...request, resourceUrl: "https://example.com" }))
      .toMatchObject({ requested: false });
    expect(f.impl.consumeCapturedConnectionRequests(1)).toEqual([]);
    const card = await f.persistRequest();
    await expect(f.client.acceptConnectionRequest(card.requestId, { gatekeeperId: 999 }))
      .rejects.toThrow("cannot select");
    expect(f.owner.provisionAmbientAccount).not.toHaveBeenCalled();
  }));

  it("does not let a use-only collaborator provision the owner's account", () => workspace(async f => {
    const card = await f.persistRequest();
    const viewer = await openFakeOverseer(f.impl.storage, { role: "use" });
    try {
      await expect(viewer.acceptConnectionRequest(card.requestId)).rejects.toThrow();
      expect(f.owner.provisionAmbientAccount).not.toHaveBeenCalled();
      expect([...f.impl.storage.chats.list()].find(m => m.type === "connectionRequest").state).toBe("pending");
    } finally { viewer[Symbol.dispose](); }
  }));

  it("preserves resource requests and still requires their selected gatekeeper", () => workspace(async f => {
    expect(await f.impl.requestConnection(1, { ...request, vendorId: "github",
      resourceUrl: "https://github.com/openai/codex", bindingName: "REPO" })).toMatchObject({ requested: true });
    const [body] = f.impl.consumeCapturedConnectionRequests(1);
    const card = { ...body, chatId: 1, sequence: 1, timestamp: new Date(), author };
    expect(card.connectionType).toBeUndefined();
    expect(card.resourceUrlPattern).toBe(repository.supportedResources[0].urlPattern);
    f.impl.storage.chats.put(card);
    await expect(f.client.acceptConnectionRequest(card.requestId)).rejects.toThrow("requires a gatekeeper id");
    await f.client.acceptConnectionRequest(card.requestId, { gatekeeperId: 42 });
    expect(f.owner.provisionAmbientAccount).not.toHaveBeenCalled();
    expect(f.resume).toHaveBeenCalledOnce();
  }));

});
