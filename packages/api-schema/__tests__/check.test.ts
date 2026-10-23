// checkArguments(), on a hand-built schema with one parameter per kind it tells apart, and on the
// committed subset the instance admin Gatekeeper checks its calls against.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkArguments, MAX_ARGUMENT_PROBLEMS } from "../src/check.ts";
import { type ApiShape, FORMAT, type Schema, type SchemaParam } from "../src/schema.ts";

const param = (name: string, type: ApiShape, optional = false): SchemaParam => ({ name, type, optional, doc: "" });
const orUndefined = (shape: ApiShape): ApiShape => ({ kind: "union", branches: [shape, { kind: "undefined" }] });

const SHAPES: Record<string, ApiShape> = {
  Options: {
    kind: "object",
    properties: { limit: orUndefined({ kind: "number" }), query: { kind: "string" } },
  },
  Labels: { kind: "object", properties: { primary: { kind: "string" } }, index: { kind: "number" } },
  Mood: { kind: "union", branches: [{ kind: "literal", value: "busy" }, { kind: "literal", value: "calm" }] },
  Destination: {
    kind: "union",
    branches: [
      { kind: "object", properties: { kind: { kind: "literal", value: "inbox" } } },
      { kind: "object", properties: { kind: { kind: "literal", value: "folder" }, path: { kind: "string" } } },
    ],
  },
  Tree: { kind: "object", properties: { child: orUndefined({ kind: "ref", name: "Tree" }) } },
};

/** A schema whose service `Api` has `method(value)` for `type`, and `call` with `params`. */
function schemaOf(type: ApiShape, params: SchemaParam[] = []): Schema {
  return {
    format: FORMAT,
    entry: "Api",
    constants: {},
    services: {
      Api: {
        doc: "",
        direction: "server",
        methods: [
          { name: "call", doc: "", params, returns: { kind: "void" } },
          { name: "method", doc: "", params: [param("value", type)], returns: { kind: "void" } },
        ],
      },
    },
    shapes: SHAPES,
  };
}

/** The problems with `value` as the one argument of a parameter of `type`. */
const check = (type: ApiShape, value: unknown) => checkArguments(schemaOf(type), "Api", "method", [value]);

describe("kinds", () => {
  test("primitives, void, null and literals", () => {
    for (const [kind, good, bad] of [
      ["string", "a", 1], ["number", 1, "1"], ["boolean", false, 0], ["bigint", 1n, 1],
      ["null", null, undefined], ["undefined", undefined, null],
    ] as const) {
      expect(check({ kind }, good)).toEqual([]);
      expect(check({ kind }, bad)).toEqual([`value: expected ${kind}`]);
    }
    expect(check({ kind: "void" }, undefined)).toEqual([]);
    expect(check({ kind: "void" }, 0)).toEqual(["value: expected undefined"]);
    expect(check({ kind: "literal", value: "on" }, "on")).toEqual([]);
    expect(check({ kind: "literal", value: "on" }, "off")).toEqual(['value: expected "on"']);
    expect(check({ kind: "literal", value: 2 }, 2)).toEqual([]);
    expect(check({ kind: "literal", value: true }, false)).toEqual(["value: expected true"]);
  });

  test("any and unsupported accept anything", () => {
    for (const value of [undefined, null, 1, {}, () => 1, new Map()]) {
      expect(check({ kind: "any" }, value)).toEqual([]);
      expect(check({ kind: "unsupported", reason: "a symbol" }, value)).toEqual([]);
    }
  });

  test("arrays, sets and maps, with the path to each element", () => {
    const strings: ApiShape = { kind: "array", element: { kind: "string" } };
    expect(check(strings, ["a", "b"])).toEqual([]);
    expect(check(strings, "a")).toEqual(["value: expected array"]);
    expect(check(strings, ["a", 1, "c", false])).toEqual(["value[1]: expected string", "value[3]: expected string"]);
    expect(check(strings, { 0: "a", length: 1 })).toEqual(["value: expected array"]);

    const set: ApiShape = { kind: "set", element: { kind: "number" } };
    expect(check(set, new Set([1, 2]))).toEqual([]);
    expect(check(set, [1, 2])).toEqual(["value: expected Set"]);
    expect(check(set, new Set([1, "2"]))).toEqual(["value[1]: expected number"]);

    const map: ApiShape = { kind: "map", key: { kind: "string" }, value: { kind: "number" } };
    expect(check(map, new Map([["a", 1]]))).toEqual([]);
    expect(check(map, { a: 1 })).toEqual(["value: expected Map"]);
    expect(check(map, new Map<unknown, unknown>([["a", 1], [2, "b"]])))
      .toEqual(["value[1][0]: expected string", "value[1][1]: expected number"]);
  });

  test("tuples: required, optional and variadic elements", () => {
    const pair: ApiShape = { kind: "tuple", elements: [{ kind: "string" }, { kind: "number" }] };
    expect(check(pair, ["a", 1])).toEqual([]);
    expect(check(pair, ["a"])).toEqual(["value: expected an array of 2"]);
    expect(check(pair, ["a", 1, 2])).toEqual(["value: expected an array of 2"]);
    expect(check(pair, [1, "a"])).toEqual(["value[0]: expected string", "value[1]: expected number"]);

    const optional: ApiShape = { kind: "tuple", elements: [{ kind: "string" }, { kind: "number" }], minLength: 1 };
    expect(check(optional, ["a"])).toEqual([]);
    expect(check(optional, ["a", undefined])).toEqual([]);
    expect(check(optional, [])).toEqual(["value: expected an array of 1 to 2"]);

    const rest: ApiShape = { kind: "tuple", elements: [{ kind: "string" }], rest: { kind: "boolean" } };
    expect(check(rest, ["a", true, false])).toEqual([]);
    expect(check(rest, ["a", true, 1])).toEqual(["value[2]: expected boolean"]);
    expect(check(rest, [])).toEqual(["value: expected an array of at least 1"]);
  });

  test("objects: declared keys, optional ones, undeclared ones and index signatures", () => {
    const options: ApiShape = { kind: "ref", name: "Options" };
    expect(check(options, { query: "a" })).toEqual([]);
    expect(check(options, { query: "a", limit: 5 })).toEqual([]);
    expect(check(options, { query: "a", limit: undefined })).toEqual([]);
    expect(check(options, { limit: "5" })).toEqual(["value.limit: expected number", "value.query: expected string"]);
    expect(check(options, { query: "a", extra: 1, "two words": 2 }))
      .toEqual(["value.extra: expected no such key", 'value["two words"]: expected no such key']);
    for (const value of [null, [], "a", new Date(), new (class Options { query = "a"; })()]) {
      expect(check(options, value)).toEqual(["value: expected object"]);
    }
    expect(check(options, Object.assign(Object.create(null), { query: "a" }))).toEqual([]);
    // An inherited key is not one the value has.
    expect(check(options, Object.assign(Object.create({ query: "a" }), {}))).toEqual(["value: expected object"]);

    const labels: ApiShape = { kind: "ref", name: "Labels" };
    expect(check(labels, { primary: "a", red: 1, blue: 2 })).toEqual([]);
    expect(check(labels, { primary: "a", red: "1" })).toEqual(["value.red: expected number"]);
  });

  test("unions: a value fits some branch, or the problem lists what they expect", () => {
    expect(check({ kind: "ref", name: "Mood" }, "calm")).toEqual([]);
    expect(check({ kind: "ref", name: "Mood" }, "angry")).toEqual(['value: expected "busy" | "calm"']);
    const nullable: ApiShape = { kind: "union", branches: [{ kind: "string" }, { kind: "null" }] };
    expect(check(nullable, null)).toEqual([]);
    expect(check(nullable, 1)).toEqual(["value: expected string | null"]);
    // `undefined` is left out of the description: a value it fit would not be described.
    expect(check(orUndefined({ kind: "ref", name: "Mood" }), 1)).toEqual(['value: expected "busy" | "calm"']);
    expect(check(orUndefined({ kind: "ref", name: "Options" }), { query: 1 })).toEqual(["value.query: expected string"]);
    // Branches that fail only inside the value: one is reported, several are summed up.
    const destination: ApiShape = { kind: "ref", name: "Destination" };
    expect(check(destination, { kind: "folder", path: "/a" })).toEqual([]);
    expect(check(destination, { kind: "inbox" })).toEqual([]);
    expect(check(destination, { kind: "folder" })).toEqual(["value: expected Destination"]);
    expect(check(destination, "inbox")).toEqual(["value: expected Destination"]);
    expect(check({ kind: "union", branches: [{ kind: "ref", name: "Options" }, { kind: "ref", name: "Labels" }] }, 1))
      .toEqual(["value: expected object"]);
  });

  test("dates, bytes, typed arrays and other built-ins", () => {
    expect(check({ kind: "date" }, new Date(0))).toEqual([]);
    expect(check({ kind: "date" }, new Date(Number.NaN))).toEqual(["value: expected a valid Date"]);
    expect(check({ kind: "date" }, "2026-01-01")).toEqual(["value: expected a valid Date"]);
    expect(check({ kind: "bytes" }, new Uint8Array(2))).toEqual([]);
    expect(check({ kind: "bytes" }, [1, 2])).toEqual(["value: expected Uint8Array"]);
    expect(check({ kind: "typedArray", name: "Float64Array" }, new Float64Array(1))).toEqual([]);
    expect(check({ kind: "typedArray", name: "Float64Array" }, new Float32Array(1))).toEqual(["value: expected Float64Array"]);
    expect(check({ kind: "url" }, new URL("https://example.com"))).toEqual([]);
    expect(check({ kind: "url" }, "https://example.com")).toEqual(["value: expected URL"]);
    expect(check({ kind: "error" }, new TypeError("x"))).toEqual([]);
    expect(check({ kind: "regexp" }, "x")).toEqual(["value: expected RegExp"]);
    // A global this runtime lacks can't be told apart, so anything passes.
    expect(check({ kind: "typedArray", name: "Float16ArrayFromTheFuture" }, 1)).toEqual([]);
  });

  test("capabilities, functions and streams are always refused", () => {
    expect(check({ kind: "stub", service: "Api" }, { dup() {} })).toEqual(["value: expected a capability, which can't be passed by value"]);
    expect(check({ kind: "stub" }, undefined)).toEqual(["value: expected a capability, which can't be passed by value"]);
    expect(check({ kind: "function", params: [], returns: { kind: "void" } }, () => {}))
      .toEqual(["value: expected a function, which can't be passed by value"]);
    expect(check({ kind: "readableStream" }, new ReadableStream()))
      .toEqual(["value: expected a stream, which can't be passed by value"]);
    expect(check({ kind: "writableStream" }, new WritableStream()))
      .toEqual(["value: expected a stream, which can't be passed by value"]);
    // Inside a value, too.
    expect(check({ kind: "array", element: { kind: "stub", service: "Api" } }, [1]))
      .toEqual(["value[0]: expected a capability, which can't be passed by value"]);
  });
});

describe("arity", () => {
  const schema = schemaOf({ kind: "void" }, [param("id", { kind: "string" }), param("limit", { kind: "number" }, true)]);
  const call = (...args: unknown[]) => checkArguments(schema, "Api", "call", args);

  test("a missing required argument, an optional one left out, and one too many", () => {
    expect(call("a")).toEqual([]);
    expect(call("a", 1)).toEqual([]);
    expect(call("a", undefined)).toEqual([]);
    expect(call()).toEqual(["id: expected string"]);
    expect(call(undefined, "1")).toEqual(["id: expected string", "limit: expected number"]);
    expect(call("a", 1, true)).toEqual(["argument 3: expected none, as Api.call takes 2"]);
    // A trailing undefined is an argument left out.
    expect(call("a", 1, undefined)).toEqual([]);
  });

  test("a required parameter whose shape takes undefined may be left out", () => {
    const optionalShape = schemaOf({ kind: "void" }, [param("note", orUndefined({ kind: "string" }))]);
    expect(checkArguments(optionalShape, "Api", "call", [])).toEqual([]);
  });
});

test("recursion stops at depth 64", () => {
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 100; i++) deep = (deep.child = {}) as Record<string, unknown>;
  const problems = check({ kind: "ref", name: "Tree" }, root);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/^value(\.child)+: nested more than 64 levels deep$/);
  // A cycle ends the same way.
  const cycle: Record<string, unknown> = {};
  cycle.child = cycle;
  expect(check({ kind: "ref", name: "Tree" }, cycle)).toEqual([expect.stringMatching(/nested more than 64 levels deep$/)]);
  // Shallow enough is checked in full.
  expect(check({ kind: "ref", name: "Tree" }, { child: { child: {} } })).toEqual([]);
});

test(`reports at most ${MAX_ARGUMENT_PROBLEMS} problems`, () => {
  const problems = check({ kind: "array", element: { kind: "string" } }, Array.from({ length: 50 }, (_, i) => i));
  expect(problems).toHaveLength(MAX_ARGUMENT_PROBLEMS);
  expect(problems[MAX_ARGUMENT_PROBLEMS - 1]).toBe(`value[${MAX_ARGUMENT_PROBLEMS - 1}]: expected string`);
});

test("throws on a service, method or shape the schema lacks", () => {
  expect(() => checkArguments(schemaOf({ kind: "void" }), "Nope", "call", [])).toThrow("no service Nope in the schema");
  expect(() => checkArguments(schemaOf({ kind: "void" }), "Api", "nope", [])).toThrow("no method nope on service Api");
  expect(() => check({ kind: "ref", name: "Gone" }, 1)).toThrow("no shape Gone in the schema");
});

test("the instance admin Gatekeeper's committed subset", () => {
  const admin = JSON.parse(readFileSync(join(import.meta.dirname, "..", "generated", "admin-api.schema.json"), "utf8")) as Schema;
  const call = (method: string, ...args: unknown[]) => checkArguments(admin, "AdminApi", method, args);
  expect(call("listUsers")).toEqual([]);
  expect(call("listUsers", { query: "ada", limit: 10 })).toEqual([]);
  expect(call("listUsers", { limit: "10", sort: "name" }))
    .toEqual(["options.limit: expected number", "options.sort: expected no such key"]);
  expect(call("setBanner", "Maintenance tonight", "info")).toEqual([]);
  expect(call("setBanner", "Maintenance tonight", "purple"))
    .toEqual(['color: expected "brand" | "danger" | "info" | "neutral" | "success" | "warning"']);
  expect(call("setSiteName")).toEqual(["name: expected string"]);
  expect(() => call("setSiteLogo")).toThrow("no method setSiteLogo on service AdminApi");
});
