// The surface the agent is given: the methods the session defines, the declarations it reads, and
// the load-time checks that keep the session's design true of whatever schema it is built with.

import type { Schema } from "@gadgets/api-schema/schema";
import GENERATED_DECLARATIONS from "@gadgets/api-schema/generated/admin-api.agent.d.ts?raw";
import WORKSHOP_SCHEMA_JSON from "@gadgets/api-schema/generated/workshop-api.schema.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import {
  ADMIN_METHODS, ADMIN_SCHEMA, PREAMBLE, adminDeclarations, approvalMessage, assertAdminSchema,
} from "../src/surface.js";

const WORKSHOP_SCHEMA = WORKSHOP_SCHEMA_JSON as unknown as Schema;
const WITHHELD = ["setAdminAuditRetentionDays", "setAdminWorkspaceAccess", "setSiteLogo"];

/** Declarations below their header comment, which ends at the first blank line. */
const body = (text: string) => text.slice(text.indexOf("\n\n") + 2);

/** A copy of the bundled schema with `change` made to it. */
function doctored(change: (schema: Schema) => void): Schema {
  const schema = structuredClone(ADMIN_SCHEMA);
  change(schema);
  return schema;
}

const listUsers = (schema: Schema) =>
  schema.services.AdminApi!.methods.find((method) => method.name === "listUsers")!;

const approval = (reason: "activate" | "confirm" | "inspect", existing: boolean) =>
  approvalMessage("testGatewayModel", { outcome: "needsApproval", actionId: 42, existing, reason });

describe("the bundled schema", () => {
  it("serves every AdminApi method but the three withheld", () => {
    const all = WORKSHOP_SCHEMA.services.AdminApi!.methods.map((method) => method.name);
    expect(WITHHELD.every((name) => all.includes(name))).toBe(true);
    expect(ADMIN_METHODS).toEqual(all.filter((name) => !WITHHELD.includes(name)).toSorted());
  });

  it("declares what admin-api.agent.d.ts declares, below its own header", () => {
    const declarations = adminDeclarations();

    expect(body(declarations)).toBe(body(GENERATED_DECLARATIONS));
    expect(declarations).toContain("export interface AdminApi ");
    expect(declarations).toContain("export interface AdminWorkspaceView ");
    expect(declarations.startsWith("// The binding these declarations describe")).toBe(true);
  });

  it("tells the agent what is withheld without offering to call it", () => {
    expect(PREAMBLE).not.toContain("setAdminWorkspaceAccess(");
    expect(PREAMBLE).toContain("setAdminWorkspaceAccess");
    // A chat that had the capsule before it was dropped and re-added binds INSTANCE_ADMIN_2.
    expect(PREAMBLE).toContain("(env.INSTANCE_ADMIN in most chats)");
    expect(PREAMBLE).toContain("within 15 minutes");
    expect(PREAMBLE).toContain("first 10 minutes");
  });
});

describe("assertAdminSchema", () => {
  it("accepts the bundled schema", () => {
    expect(() => assertAdminSchema(structuredClone(ADMIN_SCHEMA))).not.toThrow();
  });

  it("refuses a service the caller implements", () => {
    expect(() => assertAdminSchema(doctored((schema) => {
      schema.services.AdminWorkspaceView!.direction = "client";
    }))).toThrow(/AdminWorkspaceView is implemented by the caller/);
  });

  it("refuses a property", () => {
    expect(() => assertAdminSchema(doctored((schema) => {
      schema.services.AdminApi!.properties = [
        { name: "config", doc: "", type: { kind: "string" }, optional: false },
      ];
    }))).toThrow(/AdminApi has properties/);
  });

  it("refuses a stub inside a parameter's value", () => {
    expect(() => assertAdminSchema(doctored((schema) => {
      listUsers(schema).params.push({
        name: "options", doc: "", optional: true,
        type: { kind: "object", properties: { callback: { kind: "stub", service: "AdminApi" } } },
      });
    }))).toThrow(/a parameter of AdminApi.listUsers takes a capability/);
  });

  it("refuses a second method returning a capability", () => {
    expect(() => assertAdminSchema(doctored((schema) => {
      listUsers(schema).returns = { kind: "array", element: { kind: "stub", service: "AdminWorkspaceView" } };
    }))).toThrow(/AdminApi.listUsers returns a capability/);
  });

  it("refuses a method named then", () => {
    expect(() => assertAdminSchema(doctored((schema) => {
      listUsers(schema).name = "then";
    }))).toThrow(/AdminApi.then has a reserved name/);
  });

  it("refuses a method named after an Object.prototype member", () => {
    expect(() => assertAdminSchema(doctored((schema) => {
      listUsers(schema).name = "toString";
    }))).toThrow(/AdminApi.toString has a reserved name/);
  });

  it("refuses a service not reachable from AdminApi", () => {
    expect(() => assertAdminSchema(doctored((schema) => {
      schema.services.Stray = { doc: "", direction: "server", methods: [] };
    }))).toThrow(/Stray isn't reachable/);
  });
});

describe("approvalMessage", () => {
  it("asks to turn access on", () => {
    expect(approval("activate", false)).toBe("Deployment admin access is off in this workspace, so " +
      "nothing ran. Your user has been asked to turn it on (action 42); your turn ends after this " +
      "executeCode call. Once they approve, you are resumed: make the call again.");
    expect(approval("activate", true)).toBe("Deployment admin access is off in this workspace, so " +
      "nothing ran. This turn already asked your user to turn it on (action 42); your turn ends " +
      "after this executeCode call. Once they approve, you are resumed: make the call again.");
  });

  it("asks to approve a paid call", () => {
    expect(approval("confirm", false)).toBe("AdminApi.testGatewayModel sends requests the " +
      "deployment pays for, so it runs only once your user approves this one call (action 42); " +
      "your turn ends after this executeCode call. Once you are resumed, make the identical call " +
      "again within 15 minutes; it runs once.");
  });

  it("asks to approve a full inspection", () => {
    expect(approval("inspect", false)).toBe("Opening a workspace with full access runs only once " +
      "your user approves this one call (action 42); your turn ends after this executeCode call. " +
      "Once you are resumed, make the identical call again within 15 minutes; the view works " +
      "until that executeCode call ends.");
  });

  it("points at the request this turn already made", () => {
    const existing = "An identical call already waits for your user's approval in this turn " +
      "(action 42); your turn ends after this executeCode call. Once you are resumed, make it " +
      "again within 15 minutes; it runs once.";
    expect(approval("confirm", true)).toBe(existing);
    expect(approval("inspect", true)).toBe(existing);
  });
});
