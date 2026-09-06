import { defineConfig } from "vitest/config";

// Requires the production host build, but no Base checkout or provider credentials.
// Missing/unsupported launchers and broken networking fail acceptance; never skip.
export default defineConfig({
  test: {
    include: [
      "tests/packageManagerInvocation.test.ts",
      "packages/process-adapter/src/isolation/**/*.test.ts",
      "packages/extension-host/src/childRuntime.integration.test.ts",
      "packages/shared/src/claudeNativeLaunch.test.ts",
      "packages/shared/src/claudeCredentialExtraction.integration.test.ts",
      "packages/shared/src/npmInstaller.integration.test.ts",
      "src/server/nativeWorkspaceCleanup.integration.test.ts",
      "src/server/claudeProfileRetirement.integration.test.ts",
      "src/server/nativeNetwork.integration.test.ts",
      "src/server/workerdNative.integration.test.ts",
      "src/server/nativeWorkspaceRuntime.integration.test.ts",
      "src/server/storage/blobCas.test.ts",
      "src/server/buildV2/dependencyContentStore.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
