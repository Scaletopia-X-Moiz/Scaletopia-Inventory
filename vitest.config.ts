import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // companies.test.ts pages through the full ~87k-row table several times
    testTimeout: 60000,
  },
  resolve: {
    alias: {
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.ts"),
      "@": path.resolve(__dirname, "."),
    },
  },
});
