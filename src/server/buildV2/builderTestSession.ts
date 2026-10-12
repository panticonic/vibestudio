import * as path from "node:path";
import { createBuildProcessOwner, createBuilderSession, type BuilderSession } from "./builder.js";
import type { RunNativeWorkspaceJob } from "../nativeWorkspaceJob.js";
import { workingTreeSourceProvider } from "./buildSource.js";
import type { BuildSourceProvider } from "./buildSource.js";
import { createBuildStore } from "./buildStore.js";
import { prepareBuildRootConfig } from "./effectiveVersion.js";

/** Explicit role/session fixture for tests that exercise the real build pipeline. */
export async function createBuilderTestSession(input: {
  appRoot: string;
  workspaceRoot: string;
  stateRoot: string;
  appNodeModules?: string | readonly string[];
  runNativeJob: RunNativeWorkspaceJob;
  workspaceId?: string;
  ensureBuildProvider?: (target: "react-native") => Promise<void>;
  source?: BuildSourceProvider;
}): Promise<{
  processOwner: ReturnType<typeof createBuildProcessOwner>;
  session: BuilderSession;
  close(): Promise<void>;
}> {
  const appRoot = path.resolve(input.appRoot);
  const stateRoot = path.resolve(input.stateRoot);
  const processOwner = createBuildProcessOwner({
    appRoot,
    appNodeModules: input.appNodeModules ?? path.join(appRoot, "node_modules"),
  });
  try {
    const rootFingerprint = await prepareBuildRootConfig({
      appRoot,
      workspaceRoot: input.workspaceRoot,
    });
    const store = createBuildStore(
      {
        stateRoot,
        sharedArtifactPoolRoot: null,
        sharedBuildResultCacheRoot: null,
        releaseBuildRoot: null,
        executionIdentity: {
          workspaceId: input.workspaceId ?? "workspace:test",
          executionStateForContent: (stateHash) => ({
            kind: "event",
            eventId: `event:${stateHash}`,
          }),
          serviceAuthorityForSource: async () =>
            "b7e01c5f5a5351d9b1e459b5fc9e3c36920637eac75afd9ad271b3a0d8736e06",
        },
      },
      processOwner.buildStoreProcessOwner
    );
    const session = createBuilderSession({
      processOwner,
      runNativeJob: input.runNativeJob,
      ensureBuildProvider: input.ensureBuildProvider,
      source: {
        ...(input.source ?? workingTreeSourceProvider()),
        workspaceId: input.workspaceId ?? "workspace:test",
      },
      store,
      sharedBuildResultCacheRoot: null,
      rootFingerprint,
    });
    return {
      processOwner,
      session,
      async close() {
        const errors: unknown[] = [];
        try {
          await session.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await processOwner.shutdown();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, "Builder test session cleanup failed");
      },
    };
  } catch (error) {
    try {
      await processOwner.shutdown();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Builder test session setup and cleanup failed"
      );
    }
    throw error;
  }
}
