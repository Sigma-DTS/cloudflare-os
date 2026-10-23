// ADMIN_AGENT_ACCESS against what it classifies: AdminApiImpl's methods, ADMIN_SETTING_METHODS, the
// api-schema's tags, the instance admin Gatekeeper's generated surface, and the shapes AdminApi's
// results and parameters can carry. The Workshop dispatches an agent's Admin API calls from the
// table and wraps only inspectWorkspace()'s view, so each of these holding is what keeps a method
// from reaching an agent unclassified, or a capability from reaching it unwrapped.

import { describe, expect, it } from "vitest";
import {
  ADMIN_AGENT_ACCESS, ADMIN_SETTING_METHODS, adminAgentAccess, type AdminAgentAccess,
} from "@gadgets/workshop-shared/api";
import type { ApiShape, Schema } from "../../api-schema/src/schema.ts";
// By relative path, so the test task's input tracking follows the generated files.
import workshopSchemaJson from "../../api-schema/generated/workshop-api.schema.json";
import adminSchemaJson from "../../api-schema/generated/admin-api.schema.json";
import { AdminApiImpl } from "../src/admin-settings.js";

const workshopSchema = workshopSchemaJson as unknown as Schema;
const adminSchema = adminSchemaJson as unknown as Schema;

const KINDS = ADMIN_AGENT_ACCESS as Record<string, AdminAgentAccess>;

function methodsOf(kind: AdminAgentAccess): string[] {
  return Object.keys(KINDS).filter(method => KINDS[method] === kind).toSorted();
}

function service(schema: Schema, name: string) {
  let found = schema.services[name];
  if (!found) throw new Error(`The schema has no service ${name}.`);
  return found;
}

describe("ADMIN_AGENT_ACCESS", () => {
  it("classifies exactly AdminApiImpl's methods", () => {
    let implemented = Object.getOwnPropertyNames(AdminApiImpl.prototype)
        .filter(name => name !== "constructor");
    expect(Object.keys(KINDS).toSorted()).toEqual(implemented.toSorted());
  });

  it("classifies the setters as changes or withheld, and nothing else as either", () => {
    let setters = [...ADMIN_SETTING_METHODS].toSorted();
    expect([...methodsOf("change"), ...methodsOf("withheld")].toSorted()).toEqual(setters);
    expect(methodsOf("confirm"))
        .toEqual(["testGatewayModel", "testGatewayProvider", "testNewGatewayModel"]);
    expect(methodsOf("inspect")).toEqual(["inspectWorkspace"]);
  });

  it("matches the api-schema's @mutates and @confirmation tags", () => {
    let methods = service(workshopSchema, "AdminApi").methods;
    expect(methods.map(method => method.name).toSorted()).toEqual(Object.keys(KINDS).toSorted());
    let setters = new Set<string>(ADMIN_SETTING_METHODS);
    for (let method of methods) {
      expect(method.mutates === true, `${method.name} @mutates`).toBe(setters.has(method.name));
      expect(method.confirmation !== undefined, `${method.name} @confirmation`)
          .toBe(KINDS[method.name] === "confirm");
    }
  });

  it("is what the instance admin Gatekeeper's surface serves: every method but the withheld", () => {
    expect(adminSchema.entry).toBe("AdminApi");
    let served = service(adminSchema, "AdminApi").methods.map(method => method.name).toSorted();
    expect(served).toEqual(Object.keys(KINDS).filter(m => KINDS[m] !== "withheld").toSorted());
  });

  it("knows no inherited property as a method", () => {
    for (let name of ["constructor", "__proto__", "toString", "hasOwnProperty", "then"]) {
      expect(adminAgentAccess(name), name).toBeUndefined();
    }
    expect(adminAgentAccess("getSettings")).toBe("read");
    expect(adminAgentAccess("setSiteLogo")).toBe("withheld");
  });
});

// The kinds of shape that carry or stand for a capability, or that the schema could not pin down.
const CAPABILITY_KINDS = new Set(["stub", "function", "readableStream", "writableStream"]);
const OPEN_KINDS = new Set(["any", "unsupported"]);

/** The kinds of every shape `shape` reaches, through refs (each walked once), containers, objects,
 * index signatures, unions, functions' signatures and streams' elements. */
function kindsReached(schema: Schema, shape: ApiShape): Set<string> {
  let kinds = new Set<string>();
  let visited = new Set<string>();
  let walk = (s: ApiShape): void => {
    kinds.add(s.kind);
    switch (s.kind) {
      case "ref": {
        if (visited.has(s.name)) return;
        visited.add(s.name);
        let named = schema.shapes[s.name];
        if (!named) throw new Error(`The schema has no shape ${s.name}.`);
        walk(named);
        return;
      }
      case "array": case "set":
        walk(s.element);
        return;
      case "map":
        walk(s.key);
        walk(s.value);
        return;
      case "tuple":
        s.elements.forEach(walk);
        if (s.rest) walk(s.rest);
        return;
      case "object":
        Object.values(s.properties).forEach(walk);
        if (s.index) walk(s.index);
        return;
      case "union":
        s.branches.forEach(walk);
        return;
      case "function":
        s.params.forEach(param => walk(param.type));
        walk(s.returns);
        return;
      case "readableStream": case "writableStream":
        if (s.element) walk(s.element);
        return;
    }
  };
  walk(shape);
  return kinds;
}

function capabilitiesIn(kinds: Set<string>, open: boolean): string[] {
  return [...kinds].filter(kind => CAPABILITY_KINDS.has(kind) || (open && OPEN_KINDS.has(kind)));
}

describe("what AdminApi hands out and takes", () => {
  it("returns a capability only from inspectWorkspace(), and that one an AdminWorkspaceView", () => {
    for (let method of service(workshopSchema, "AdminApi").methods) {
      if (method.name === "inspectWorkspace") {
        expect(method.returns).toEqual({ kind: "stub", service: "AdminWorkspaceView" });
        continue;
      }
      expect(capabilitiesIn(kindsReached(workshopSchema, method.returns), true), method.name)
          .toEqual([]);
    }
  });

  it("returns only plain data from every AdminWorkspaceView method", () => {
    let view = service(workshopSchema, "AdminWorkspaceView");
    expect(view.methods.length).toBeGreaterThan(0);
    for (let method of view.methods) {
      expect(capabilitiesIn(kindsReached(workshopSchema, method.returns), true), method.name)
          .toEqual([]);
    }
  });

  it("takes no capability in any AdminApi parameter", () => {
    for (let method of service(workshopSchema, "AdminApi").methods) {
      for (let param of method.params) {
        expect(capabilitiesIn(kindsReached(workshopSchema, param.type), false),
            `${method.name}(${param.name})`).toEqual([]);
      }
    }
  });
});
