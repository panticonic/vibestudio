import { defineConfig } from "vitest/config";

// Runs without the host application or Base checkout. These are real native
// denial checks: a missing/unsupported launcher is a failure, never a skip.
export default defineConfig({
  test: {
    include: ["packages/process-adapter/src/isolation/**/*.test.ts"],
    fileParallelism: false,
  },
});
