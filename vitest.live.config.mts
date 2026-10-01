import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Live tests against the real Supabase project. Opt-in: npm run test:live
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/live/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
