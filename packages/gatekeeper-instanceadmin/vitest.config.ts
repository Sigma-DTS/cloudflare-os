import { defineConfig } from "vitest/config";

/** The pure surface (`src/surface.ts`) in Node. The facet and its sessions run in workerd, in
 * `vitest.worker.config.ts`. */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
