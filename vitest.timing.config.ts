import { defineConfig } from "vitest/config";

// Timing tests only, serially (no parallel files or workers), so other tests' load can't trip their limits
export default defineConfig({
  test: {
    include: ["test/**/*.timing.test.ts"],
    exclude: ["**/node_modules/**", "**/.vitasta-cache/**", "test/fixtures/**"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
