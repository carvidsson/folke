import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Quality evaluation with REAL OpenAI calls on synthetic data only.
// Opt-in and billed (a few cents): npm run test:ai-eval
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/ai-eval/**/*.eval.ts"],
    environment: "node",
    testTimeout: 600_000,
    fileParallelism: false,
  },
});
