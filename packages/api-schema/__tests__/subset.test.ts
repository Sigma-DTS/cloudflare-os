// subsetSchema(), on the extractor's fixture and on this repository's own `workshop-shared/src/api.ts`
// as `scripts/generate.ts` subsets it for the instance admin Gatekeeper. Its walk is its own, not the
// declaration emitter's, so the emitter's output from the subset is held equal to its output from
// the whole schema with the same omissions.

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ADMIN_OMIT, ADMIN_ROOT, AGENT_ROOT, API_SOURCE } from "../scripts/generate.ts";
import { emitDeclarations } from "../src/emit/dts.ts";
import { extractSchema } from "../src/extract.ts";
import { type ApiShape, FORMAT, type Schema } from "../src/schema.ts";
import { subsetSchema } from "../src/subset.ts";

const PACKAGE = join(import.meta.dirname, "..");
const FIXTURE = extractSchema({
  entry: join(PACKAGE, "__tests__", "__fixtures__", "api.ts"),
  tsconfig: join(PACKAGE, "tsconfig.json"),
  entryName: "FixturePublicApi",
  constants: ["SERVICE_SALT"],
});

const methodNames = (schema: Schema, service: string) => schema.services[service]!.methods.map((m) => m.name);

/** A schema whose one method returns `returns`, which may name what the schema lacks. */
const broken = (returns: ApiShape): Schema => ({
  format: FORMAT,
  entry: "Api",
  constants: {},
  services: { Api: { doc: "", direction: "server", methods: [{ name: "m", doc: "", params: [], returns }] } },
  shapes: {},
});

/** Holds emitDeclarations of the subset equal to emitDeclarations of the whole with `omit`. */
function expectSameDeclarations(schema: Schema, root: string, omit?: string[]) {
  const subset = subsetSchema(schema, { root, omit });
  const header = "Header.";
  expect(emitDeclarations(subset, { root, header })).toEqual(emitDeclarations(schema, { root, omit, header }));
}

describe("the fixture", () => {
  test("keeps what the root reaches, through parameters, results and properties, and no more", () => {
    const subset = subsetSchema(FIXTURE, { root: "FixtureAuthedApi" });
    // Cursor only through a subscriber's parameter; the `{}` handle through Notebook's results.
    expect(Object.keys(subset.services)).toEqual(
      ["Cursor", "FixtureAdmin", "FixtureAuthedApi", "Notebook", "NotesSubscriber", "{}"]);
    expect(Object.keys(subset.shapes)).toEqual(["Destination", "Mood", "Note", "Outline"]);
    expect(subset.services.Notebook).toEqual(FIXTURE.services.Notebook);
    expect(subset.services.NotesSubscriber!.direction).toBe("client");

    // From the entry: its properties stay, and LegacyNotes is reached.
    const entry = subsetSchema(FIXTURE, { root: "FixturePublicApi" });
    expect(entry.services.FixturePublicApi).toEqual(FIXTURE.services.FixturePublicApi);
    expect(Object.keys(entry.services)).toContain("LegacyNotes");
    expect(entry.services.LegacyNotes!.deprecated).toBe(FIXTURE.services.LegacyNotes!.deprecated);
  });

  test("names the root as its entry, and keeps no constants", () => {
    expect(Object.keys(FIXTURE.constants)).toEqual(["SERVICE_SALT"]);
    const subset = subsetSchema(FIXTURE, { root: "Notebook" });
    expect(subset.format).toBe(FORMAT);
    expect(subset.entry).toBe("Notebook");
    expect(subset.constants).toEqual({});
    expect(Object.keys(subset)).toEqual(["format", "entry", "constants", "services", "shapes"]);
  });

  test("leaves out omitted methods, by name or by service, with what only they reach", () => {
    const bare = subsetSchema(FIXTURE, { root: "FixtureAuthedApi", omit: ["getAdmin", "outline"] });
    expect(Object.keys(bare.services)).not.toContain("FixtureAdmin");
    expect(Object.keys(bare.shapes)).not.toContain("Outline");
    expect(methodNames(bare, "Notebook")).not.toContain("outline");
    expect(methodNames(bare, "FixtureAuthedApi")).not.toContain("getAdmin");

    const qualified = subsetSchema(FIXTURE, { root: "FixtureAuthedApi", omit: ["Notebook.subscribe", "Other.lock"] });
    expect(methodNames(qualified, "Notebook")).not.toContain("subscribe");
    expect(methodNames(qualified, "Notebook")).toContain("lock");
    // Still reached through openNotebook's observer.
    expect(Object.keys(qualified.services)).toContain("NotesSubscriber");
  });

  test("refuses a root the client implements, and names it doesn't have", () => {
    expect(() => subsetSchema(FIXTURE, { root: "NotesSubscriber" })).toThrow(/NotesSubscriber is implemented by the client/);
    expect(() => subsetSchema(FIXTURE, { root: "Nope" })).toThrow("no service Nope in the schema");
    expect(() => subsetSchema(FIXTURE, { root: "toString" })).toThrow("no service toString in the schema");
    expect(() => subsetSchema(broken({ kind: "stub", service: "Gone" }), { root: "Api" }))
      .toThrow("no service Gone in the schema");
    expect(() => subsetSchema(broken({ kind: "array", element: { kind: "ref", name: "Gone" } }), { root: "Api" }))
      .toThrow("no shape Gone in the schema");
  });

  test("is deterministic, with sorted keys", () => {
    const subset = subsetSchema(FIXTURE, { root: "FixtureAuthedApi", omit: ["outline"] });
    expect(JSON.stringify(subsetSchema(FIXTURE, { root: "FixtureAuthedApi", omit: ["outline"] })))
      .toBe(JSON.stringify(subset));
    for (const keys of [Object.keys(subset.services), Object.keys(subset.shapes)]) expect(keys).toEqual(keys.toSorted());
  });

  test("declares what the whole schema declares with the same omissions", () => {
    expectSameDeclarations(FIXTURE, "FixturePublicApi");
    expectSameDeclarations(FIXTURE, "FixtureAuthedApi");
    expectSameDeclarations(FIXTURE, "FixtureAuthedApi", ["getAdmin", "Notebook.outline", "Notebook.subscribe"]);
    expectSameDeclarations(FIXTURE, "LegacyNotes", ["release"]);
  });
});

describe("the instance admin Gatekeeper's subset of the Workshop API", () => {
  const schema = extractSchema(API_SOURCE);
  const admin = subsetSchema(schema, { root: ADMIN_ROOT, omit: ADMIN_OMIT });
  const adminApi = schema.services[ADMIN_ROOT]!;

  test("serves AdminApi less what the Gatekeeper withholds, and the workspace view it opens", () => {
    expect(Object.keys(admin.services)).toEqual(["AdminApi", "AdminWorkspaceView"]);
    expect(admin.services.AdminApi!.methods).toHaveLength(adminApi.methods.length - ADMIN_OMIT.length);
    expect(admin.services.AdminApi!.methods).toHaveLength(38);
    expect(methodNames(admin, "AdminApi").map((name) => `AdminApi.${name}`))
      .toEqual(adminApi.methods.map((m) => `AdminApi.${m.name}`).filter((id) => !ADMIN_OMIT.includes(id)));
    expect(admin.services.AdminWorkspaceView).toEqual(schema.services.AdminWorkspaceView);
    expect(admin.entry).toBe(ADMIN_ROOT);
  });

  test("tags AdminApi's setters @mutates and its gateway tests @confirmation, and nothing else", () => {
    const tagged = (has: (m: Schema["services"][string]["methods"][number]) => boolean) =>
      Object.entries(schema.services).flatMap(([service, { methods }]) =>
        methods.filter(has).map((m) => `${service}.${m.name}`)).toSorted();
    // The setters as AdminSettingRecord.method lists them (ADMIN_SETTING_METHODS).
    const method = (schema.shapes.AdminSettingRecord as Extract<ApiShape, { kind: "object" }>).properties.method!;
    const setters = (method as Extract<ApiShape, { kind: "union" }>).branches
      .map((branch) => `AdminApi.${(branch as Extract<ApiShape, { kind: "literal" }>).value}`).toSorted();
    expect(setters).toHaveLength(29);
    expect(tagged((m) => m.mutates === true)).toEqual(setters);
    expect(tagged((m) => m.confirmation !== undefined))
      .toEqual(["AdminApi.testGatewayModel", "AdminApi.testGatewayProvider", "AdminApi.testNewGatewayModel"]);
    // Each says what the call costs.
    expect(adminApi.methods.filter((m) => m.confirmation !== undefined).every((m) => m.confirmation)).toBe(true);
  });

  test("lets a client state only how it reaches the deployment", () => {
    expect(schema.shapes.AdminApiOptions).toEqual({
      kind: "object",
      properties: { via: { kind: "union", branches: [{ kind: "ref", name: "AdminClientVia" }, { kind: "undefined" }] } },
    });
  });

  test("declares what the whole schema declares with ADMIN_OMIT", () => {
    expectSameDeclarations(schema, ADMIN_ROOT, ADMIN_OMIT);
    expectSameDeclarations(schema, ADMIN_ROOT);
    expectSameDeclarations(schema, AGENT_ROOT);
  });
});
