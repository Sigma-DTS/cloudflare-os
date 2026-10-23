/// <reference types="@cloudflare/vitest-plugin/types" />

// Types for the test suites. A script, not a module, so its declarations are global: the workerd
// pool types `env` as `Cloudflare.Env`, so the test-only bindings are declared by augmenting that,
// which lets the tests read `env` without a cast.

declare namespace Cloudflare {
  interface Env {
    // Declared in `vitest.worker.config.ts` rather than `wrangler.jsonc`, so they are absent from
    // the generated `worker-configuration.d.ts`.
    INSTANCE_ADMIN_GATEKEEPER: DurableObjectNamespace<import("./worker.js").InstanceAdminGatekeeper>;
    TEST_HOOKS: DurableObjectNamespace<import("./worker.js").TestHooks>;
  }
}

// Vite's `?raw` suffix, with which the Node suite reads the generated declarations as a string.
declare module "*?raw" {
  const content: string;
  export default content;
}
