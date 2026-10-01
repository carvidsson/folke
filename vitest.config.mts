import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Live tests hit the real Supabase project: npm run test:live
    exclude: ["tests/live/**", "node_modules/**"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
