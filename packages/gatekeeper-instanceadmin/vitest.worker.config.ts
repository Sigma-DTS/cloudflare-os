import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The suite that has to run in workerd: the facet, its sessions and their stubs are RpcTargets and a
 * Durable Object, and the facet runs validated (capnwebValidate()), as it does when deployed. The
 * sibling `vitest.config.ts` keeps the pure surface in Node.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        durableObjects: {
          // Bound only so ctx.exports carries the class; the tests reach it as a facet.
          INSTANCE_ADMIN_GATEKEEPER: { className: "InstanceAdminGatekeeper", useSQLite: true },
          // A DurableObjectClass from ctx.exports is reachable only through ctx.facets, so the
          // tests drive the facet from a hook Durable Object, as the Overseer does in production.
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
