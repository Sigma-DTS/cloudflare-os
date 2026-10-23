import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    // Declaration compilation needs headroom when the full graph shares one cloud CPU.
    testTimeout: 15_000,
  },
});
