import path from "node:path";
import { defineConfig } from "vitest/config";

// Requires the production host build, but no Base checkout or provider credentials.
// Missing/unsupported launchers and broken networking fail acceptance; never skip.
export default defineConfig({
  test: {
    include: [
      "tests/packageManagerInvocation.test.ts",
      "packages/process-adapter/src/isolation/**/*.test.ts",
      "packages/extension-host/src/childRuntime.integration.test.ts",
      "packages/extension-host/src/atomicStorage.test.ts",
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
      "src/server/buildV2/builder.dependencyEnvironment.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 30_000,
    // These tests launch the real host the way a production install does, and a
    // host now refuses to start without being told which build generation it is
    // running from. Every other launcher supplies it; this suite spawned hosts
    // with nothing set and they refused to start at all.
    env: {
      VIBESTUDIO_HOST_ARTIFACT_ROOT: path.resolve(__dirname, "..", "..", "dist"),
    },
  },
});
