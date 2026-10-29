import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { ActionStore } from "../src/action-store.js";

function storage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...args: (string | number | null)[]) {
      const statement = db.prepare(query);
      const rows = statement.all(...args);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw Error("Expected one row");
          return rows[0];
        },
      };
    },
  } as unknown as ConstructorParameters<typeof ActionStore>[0];
}
const expected = {
  version: 1 as const,
  facet: "a".repeat(64),
  grant: "b".repeat(64),
  resource: "c".repeat(64),
};
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

it("binds a key to the original action and rejects changed arguments or scope after reconstruction", () => {
  const sql = storage(),
    first = new ActionStore(sql);
  const operation = first.stageTool(key, "send", { b: 2, a: 1 }, expected, 7, "d".repeat(64));
  const restored = new ActionStore(sql);
  expect(
    restored.stageTool(key, "send", { a: 1, b: 2 }, expected, 7, "d".repeat(64)),
  ).toMatchObject({
    id: operation.id,
    actionId: operation.actionId,
    state: "failed",
  });
  expect(() => restored.stageTool(key, "send", { a: 2 }, expected, 7, "d".repeat(64))).toThrow(
    /reused/,
  );
  expect(() =>
    restored.stageTool(
      key,
      "send",
      { a: 1, b: 2 },
      { ...expected, grant: "d".repeat(64) },
      8,
      "d".repeat(64),
    ),
  ).toThrow(/reused/);
  expect(sql.exec("SELECT count(*) AS count FROM mcp_actions").one()).toEqual({ count: 1 });
});

it("retains an original uncertain action after restart without replaying its effect", async () => {
  const sql = storage(),
    first = new ActionStore(sql);
  const operation = first.stageTool(key, "send", {}, expected, 7, "d".repeat(64));
  let release!: () => void,
    calls = 0;
  const applying = first.apply(
    operation.actionId!,
    async () => {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { content: [] };
    },
    log,
  );
  const restored = new ActionStore(sql);
  expect(restored.toolOperation(key)?.state).toBe("uncertain");
  await expect(
    restored.apply(
      operation.actionId!,
      async () => {
        calls++;
        return { content: [] };
      },
      log,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  release();
  await applying;
});

it("distinguishes an applied tool error from missing or oversized retained results", async () => {
  const sql = storage(),
    store = new ActionStore(sql);
  const failedTool = store.stageTool(key, "send", {}, expected, 7, "d".repeat(64));
  await store.apply(
    failedTool.actionId,
    async () => ({ content: [{ type: "text", text: "business refusal" }], isError: true }),
    log,
  );
  expect(store.toolOperation(key)).toMatchObject({ state: "applied", resultRetained: true });
  expect(store.get(failedTool.actionId)?.result?.isError).toBe(true);
  const oversizedKey = "00000000-0000-0000-0000-000000000002";
  const oversized = store.stageTool(oversizedKey, "send", {}, expected, 7, "d".repeat(64));
  await store.apply(
    oversized.actionId,
    async () => ({ content: [{ type: "text", text: "private".repeat(30000) }] }),
    log,
  );
  expect(store.toolOperation(oversizedKey)).toMatchObject({
    state: "applied",
    resultRetained: false,
  });
});

it("allows only the original native action after lost queue acknowledgement", async () => {
  const store = new ActionStore(storage());
  const operation = store.stageTool(key, "send", {}, expected, 7, "d".repeat(64));
  operation.state = "uncertain";
  store.putToolOperation(operation);
  let calls = 0;
  await store.apply(
    operation.actionId,
    async () => {
      calls++;
      return { content: [] };
    },
    log,
  );
  await store.apply(
    operation.actionId,
    async () => {
      calls++;
      return { content: [] };
    },
    log,
  );
  expect(calls).toBe(1);
  expect(store.toolOperation(key)?.state).toBe("applied");
});
