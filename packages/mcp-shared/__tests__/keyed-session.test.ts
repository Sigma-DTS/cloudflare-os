import { DatabaseSync } from "node:sqlite";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";
import { expect, it } from "vitest";
import { McpFacetBase } from "../src/facet.js";
import { McpSessionBase } from "../src/session.js";
import { classifyTool } from "../src/tools.js";
import type { ConnectionAccount, WithClientOptions } from "../src/connection.js";
import { McpCallNotDispatchedError, type McpClient } from "../src/client.js";
import type { ToolScope } from "../src/scope.js";

const key = "00000000-0000-0000-0000-000000000001";
const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  with() {
    return this;
  },
};

function io() {
  const db = new DatabaseSync(":memory:"),
    kv = new Map<string, unknown>();
  return {
    kv: {
      get: <T>(entryKey: string) => kv.get(entryKey) as T | undefined,
      put: (entryKey: string, value: unknown) => {
        kv.set(entryKey, value);
      },
    },
    sql: {
      exec(query: string, ...args: (string | number | null)[]) {
        const rows = db.prepare(query).all(...args);
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw Error("Expected one row");
            return rows[0];
          },
        };
      },
    },
    transactionSync<T>(fn: () => T) {
      db.exec("BEGIN");
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

class Facet extends McpFacetBase<
  object,
  { endpoint: string; scope: ToolScope; accountObjectId: string },
  McpSessionBase
> {
  generation = 1;
  allowedNames = ["send"];
  writes = 0;
  response = { content: [{ type: "text", text: "private result" }], isError: true };
  protected get log() {
    return log;
  }
  protected get trust() {
    return "byo" as const;
  }
  protected get sessionClass() {
    return McpSessionBase;
  }
  protected get actionScopeTag() {
    return "fixture";
  }
  protected get observerName() {
    return "fixture";
  }
  get serverName() {
    return "Same display label";
  }
  async describe() {
    return { title: "Fixture", type: "mcp" } as never;
  }
  async getTypeScriptTypes() {
    return "";
  }
  protected account(): ConnectionAccount {
    return {
      getConnection: async () => ({
        authorization: null,
        sessionId: null,
        generation: this.generation,
      }),
      assertConnectionCurrent: async (_endpoint, generation) => {
        if (generation !== this.generation) throw Error("Fixture connection replaced");
      },
      setMcpSessionId: async () => true,
      noteCredentialsExpired: async () => {},
    };
  }
  override async findTool(name: string) {
    return this.allowedNames.includes(name) ? classifyTool({ name }, "byo") : undefined;
  }
  override async call<T>(
    fn: (client: McpClient) => Promise<T>,
    options?: WithClientOptions,
  ): Promise<T> {
    if (options?.expectedGeneration !== this.generation)
      throw new McpCallNotDispatchedError("Fixture connection replaced");
    return fn({
      callTool: async () => {
        this.writes++;
        return this.response;
      },
    } as unknown as McpClient);
  }
}

function fixture(
  storage = io(),
  account = "native-account",
  parent = "native-parent",
  binding = 5,
) {
  const facet = new Facet(
    {
      id: { toString: () => parent },
      props: { endpoint: "https://fixture.test/mcp", scope: {}, accountObjectId: account },
      storage,
    } as never,
    {},
  );
  const cache = { getBindingId: async () => binding, [Symbol.dispose]() {} };
  const submissions: number[] = [],
    observations: { containsRestrictedData?: boolean }[] = [];
  let loseAck = false,
    denyObservation = false;
  const queue = {
    async getGitCache() {
      return cache;
    },
    async authorizeObservation(value: { containsRestrictedData?: boolean }) {
      if (denyObservation) throw Error("Observation denied");
      observations.push(value);
    },
    async submitAction(id: number) {
      submissions.push(id);
      if (loseAck) throw Error("Fixture acknowledgement lost");
    },
  } as unknown as RpcStub<ApprovalQueue>;
  const session = new McpSessionBase(facet, queue);
  return {
    storage,
    facet,
    cache,
    queue,
    session,
    submissions,
    observations,
    loseAck() {
      loseAck = true;
    },
    denyObservation() {
      denyObservation = true;
    },
  };
}

it("reconstructs one pending original action, then reads only its witnessed restricted result", async () => {
  const first = fixture(),
    witness = await first.session.continuity();
  const receipts = await Promise.all([
    first.session.submitTool(key, "send", { b: 2, a: 1 }, witness),
    first.session.submitTool(key, "send", { a: 1, b: 2 }, witness),
  ]);
  expect(receipts[0].id).toBe(receipts[1].id);
  const expectedPayload = '{"args":{"a":1,"b":2},"name":"send"}';
  const expectedDigest = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expectedPayload)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  expect(receipts[0].digest).toBe(expectedDigest);
  expect(first.submissions).toHaveLength(1);
  expect(first.facet.writes).toBe(0);
  const restored = fixture(first.storage);
  const receipt = await restored.session.submitTool(key, "send", { a: 1, b: 2 }, witness);
  expect(receipt.state).toBe("pending");
  expect(restored.submissions).toEqual([]);
  await restored.facet.applyAction(receipt.actionId, restored.cache as never);
  await restored.facet.applyAction(receipt.actionId, restored.cache as never);
  expect(restored.facet.writes).toBe(1);
  expect(await restored.session.toolResult(key, witness)).toMatchObject({
    operationId: receipt.id,
    result: { status: "ok", text: "private result", isError: true },
  });
  expect(restored.observations.at(-1)?.containsRestrictedData).toBe(true);
  expect(JSON.stringify(await restored.session.toolOperation(key, witness))).not.toContain(
    "private result",
  );
  restored.denyObservation();
  await expect(restored.session.toolResult(key, witness)).rejects.toThrow("Observation denied");
});

it("refuses same-parent sibling bindings, two accounts and reconnects even with copied action storage", async () => {
  const first = fixture(),
    witness = await first.session.continuity();
  const receipt = await first.session.submitTool(key, "send", {}, witness);
  for (const other of [
    fixture(first.storage, "native-account", "native-parent", 6),
    fixture(first.storage, "another-account"),
    fixture(first.storage, "native-account", "another-parent"),
  ]) {
    await expect(other.session.toolOperation(key, witness)).rejects.toThrow(
      "unavailable for this continuity",
    );
    await expect(other.facet.applyAction(receipt.actionId, other.cache as never)).rejects.toThrow(
      "authorization changed",
    );
    expect(other.facet.writes).toBe(0);
  }
  first.facet.generation++;
  await expect(first.session.toolResult(key, witness)).rejects.toThrow(
    "unavailable for this continuity",
  );
  await expect(first.facet.applyAction(receipt.actionId, first.cache as never)).rejects.toThrow(
    "authorization changed",
  );
});

it("does not reinterpret another facet's colliding numeric action as the original result", async () => {
  const original = fixture(),
    witness = await original.session.continuity();
  const pending = await original.session.submitTool(key, "send", {}, witness);
  const rebound = fixture(),
    reboundWitness = await rebound.session.continuity();
  const unrelated = await rebound.session.submitTool(key, "send", {}, reboundWitness);
  expect(unrelated.actionId).toBe(pending.actionId);
  await rebound.facet.applyAction(unrelated.actionId, rebound.cache as never);
  await expect(rebound.session.toolResult(key, witness)).rejects.toThrow(
    "unavailable for this continuity",
  );
  expect((await original.session.toolOperation(key, witness))?.state).toBe("pending");
});

it("keeps a lost queue acknowledgement reconcilable through only its original action", async () => {
  const first = fixture(),
    witness = await first.session.continuity();
  first.loseAck();
  const receipt = await first.session.submitTool(key, "send", {}, witness);
  expect(receipt.state).toBe("uncertain");
  expect((await first.session.submitTool(key, "send", {}, witness)).id).toBe(receipt.id);
  expect(first.submissions).toHaveLength(1);
  await first.facet.applyAction(receipt.actionId, first.cache as never);
  expect((await first.session.toolOperation(key, witness))?.state).toBe("applied");
});

it("keeps native cache metadata alive until asynchronous continuity settles", async () => {
  const subject = fixture();
  let disposed = false,
    entered!: () => void,
    release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  subject.cache.getBindingId = async () => {
    entered();
    await waiting;
    if (disposed) throw Error("Fixture cache disposed early");
    return 5;
  };
  subject.cache[Symbol.dispose] = () => {
    disposed = true;
  };
  const pending = subject.session.continuity();
  await reading;
  release();
  await expect(pending).resolves.toMatchObject({ version: 1 });
  expect(disposed).toBe(true);
});

it("rolls back receipt and action together when persisting the application claim fails", async () => {
  const subject = fixture(),
    witness = await subject.session.continuity();
  const receipt = await subject.session.submitTool(key, "send", {}, witness);
  const exec = subject.storage.sql.exec;
  subject.storage.sql.exec = (query, ...args) => {
    if (query.includes("UPDATE mcp_actions SET state = ?"))
      throw Error("Fixture claim storage failure");
    return exec(query, ...args);
  };
  await expect(subject.facet.applyAction(receipt.actionId, subject.cache as never)).rejects.toThrow(
    "Fixture claim storage failure",
  );
  expect((await subject.session.toolOperation(key, witness))?.state).toBe("pending");
  expect(subject.facet.lookupAction(receipt.actionId)?.state).toBe("pending");
  expect(subject.facet.writes).toBe(0);
});

it("reports a retained result digest and preserves applied evidence after the private result expires", async () => {
  const subject = fixture(),
    witness = await subject.session.continuity();
  const operation = await subject.session.submitTool(key, "send", {}, witness);
  await subject.facet.applyAction(operation.actionId, subject.cache as never);
  const envelope = await subject.session.toolResult(key, witness);
  const result = envelope.result;
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(result))),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  expect(await subject.session.toolOperation(key, witness)).toMatchObject({
    state: "applied",
    resultAvailable: true,
  });
  expect(envelope.resultDigest).toBe(digest);
  expect(await subject.session.toolOperation(key, witness)).not.toHaveProperty("resultDigest");
  subject.storage.sql.exec("DELETE FROM mcp_actions WHERE id = ?", operation.actionId);
  expect(await subject.session.toolOperation(key, witness)).toMatchObject({
    state: "applied",
    resultAvailable: false,
  });
  await expect(subject.session.toolResult(key, witness)).rejects.toThrow(
    "effect must not be replayed",
  );
  expect((await subject.session.submitTool(key, "send", {}, witness)).id).toBe(operation.id);
  expect(subject.submissions).toHaveLength(1);
});

it("withholds an oversized result without treating its missing response as a missing effect", async () => {
  const subject = fixture(),
    witness = await subject.session.continuity();
  subject.facet.response = {
    content: [{ type: "text", text: "large".repeat(30_000) }],
    isError: false,
  };
  const operation = await subject.session.submitTool(key, "send", {}, witness);
  await subject.facet.applyAction(operation.actionId, subject.cache as never);
  expect(await subject.session.toolOperation(key, witness)).toMatchObject({
    state: "applied",
    resultAvailable: false,
  });
  await expect(subject.session.toolResult(key, witness)).rejects.toThrow(
    "effect must not be replayed",
  );
  expect(subject.facet.writes).toBe(1);
});

it("keeps rejection final and refuses a changed payload without queueing a replacement", async () => {
  const subject = fixture(),
    witness = await subject.session.continuity();
  const receipt = await subject.session.submitTool(key, "send", { target: "original" }, witness);
  await subject.facet.rejectAction(receipt.actionId);
  expect(
    (await subject.session.submitTool(key, "send", { target: "original" }, witness)).state,
  ).toBe("rejected");
  await expect(
    subject.session.submitTool(key, "send", { target: "changed" }, witness),
  ).rejects.toThrow("reused");
  expect(subject.submissions).toHaveLength(1);
  expect(subject.facet.writes).toBe(0);
});

it("keeps reserved producer method names reachable as ordinary tools through callTool", async () => {
  const subject = fixture();
  subject.facet.allowedNames = ["continuity", "submit_tool", "tool_operation", "tool_result"];
  for (const name of subject.facet.allowedNames) {
    expect(await subject.session.callTool(name, {})).toMatchObject({ status: "pending" });
  }
  expect(subject.submissions).toHaveLength(4);
  expect(subject.facet.writes).toBe(0);
});

it("keeps an unreadable original response applied while withholding its private reader", async () => {
  const subject = fixture(),
    witness = await subject.session.continuity();
  Object.defineProperty(subject.facet.response, "content", {
    get() {
      throw Error("Fixture unreadable private result");
    },
  });
  const receipt = await subject.session.submitTool(key, "send", {}, witness);
  await subject.facet.applyAction(receipt.actionId, subject.cache as never);
  expect(await subject.session.toolOperation(key, witness)).toMatchObject({
    state: "applied",
    resultAvailable: false,
  });
  await expect(subject.session.toolResult(key, witness)).rejects.toThrow(
    "effect must not be replayed",
  );
  expect(subject.facet.writes).toBe(1);
});
