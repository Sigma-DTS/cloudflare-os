import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

/**
 * No bindings: the Worker holds no credential and makes no request of its own. The Workshop lends
 * it deployment admin power one session at a time (README.md).
 */
export default defineGadgetsWorker({
  name: "gatekeeper-instanceadmin",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  entrypoint: ".wrangler/validate/src/worker.ts",
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
} satisfies WranglerExtras;

/** The workspace facet is reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["InstanceAdminGatekeeper"] },
];
