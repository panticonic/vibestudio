import { defineConfig } from "vitest/config";

// Requires the production host build, but no Base checkout or provider credentials.
// Missing/unsupported launchers and broken networking fail acceptance; never skip.
export default defineConfig({
  test: {
    include: [
      "packages/process-adapter/src/isolation/**/*.test.ts",
      "packages/shared/src/claudeCredentialExtraction.integration.test.ts",
      "src/server/nativeWorkspaceCleanup.integration.test.ts",
      "src/server/claudeProfileRetirement.integration.test.ts",
      "src/server/nativeNetwork.integration.test.ts",
      "src/server/nativeWorkspaceRuntime.integration.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
