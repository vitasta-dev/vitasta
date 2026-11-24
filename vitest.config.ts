import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only our own tests. Never pick up test files from scanned repos or fixtures.
    include: ["test/**/*.test.ts"],
    // timing tests run on their own: vitest.timing.config.ts (npm run test:timing)
    exclude: ["**/node_modules/**", "**/.vitasta-cache/**", "test/fixtures/**", "test/**/*.timing.test.ts"],
  },
});
