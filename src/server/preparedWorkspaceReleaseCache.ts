import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  DerivedCacheCoordinator,
  derivedCacheDatabasePath,
  scheduleDerivedCachePrune,
} from "@vibestudio/shared/derivedCache";
import { SharedBuildCoordinator } from "./buildV2/sharedBuildCoordinator.js";
import { BuildPriorityOwner } from "./buildV2/builderLifetime.js";
import { runWithOwnedCleanup, runOwnedCleanupSteps } from "../../scripts/lib/owned-cleanup.mjs";
import { forEachOwnedConcurrent } from "../../scripts/lib/owned-concurrency.mjs";
import {
  validateExistingPreparedWorkspaceRelease,
  workspaceReleaseIdentity,
  type PreparedWorkspaceReleaseInput,
} from "./preparedWorkspaceRelease.js";

/** Complete release resources are immutable derived data. A consumer owns a
 * private hardlink projection, so deleting instance state never deletes the
 * shared cache, and collecting the cache cannot invalidate a live instance. */
async function projectRelease(source: string, destination: string): Promise<void> {
  const directories = [{ from: source, to: destination }];
  const files: Array<{ from: string; to: string }> = [];
  while (directories.length) {
    const directory = directories.pop()!;
    await fs.mkdir(directory.to, { recursive: true });
    for (const entry of await fs.readdir(directory.from, { withFileTypes: true })) {
      const from = path.join(directory.from, entry.name);
      const to = path.join(directory.to, entry.name);
      if (entry.isDirectory()) directories.push({ from, to });
      else if (entry.isFile()) files.push({ from, to });
      else throw new Error(`Prepared release contains a non-immutable resource: ${from}`);
    }
  }
  // Independent files share a bounded I/O budget. Directory discovery finishes
  // first, and every admitted link/copy joins before failure or retirement.
  await forEachOwnedConcurrent(files, 32, async ({ from, to }) => {
    try {
      await fs.link(from, to);
    } catch (error) {
      if (
        !["EXDEV", "EPERM", "EACCES", "EMLINK"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      )
        throw error;
      await fs.copyFile(from, to);
    }
  });
}

export async function prepareCachedWorkspaceRelease(
  input: PreparedWorkspaceReleaseInput & {
    signal?: AbortSignal;
    onSourcesPrepared?: (root: string) => void | Promise<void>;
  },
  produce: () => Promise<void>
): Promise<void> {
  input.signal?.throwIfAborted();
  if (await validateExistingPreparedWorkspaceRelease(input)) {
    await input.onSourcesPrepared?.(input.output);
    return;
  }
  const identity = await workspaceReleaseIdentity(input.appRoot);
  const key = createHash("sha256")
    .update(
      canonicalJson({
        format: "vibestudio-workspace-runtime-release/2",
        platform: process.platform,
        arch: process.arch,
        ...identity,
        templates: input.templates,
      })
    )
    .digest("hex");
  const root = path.join(getSharedDerivedDataPath(), "workspace-releases");
  const cached = path.join(root, key);
  const cachedInput = { ...input, output: cached };
  const cacheOwner = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
  let lease: ReturnType<DerivedCacheCoordinator["acquire"]> | undefined;
  let coordinator: SharedBuildCoordinator | undefined;
  const reuse = async () => {
    await projectRelease(cached, input.output);
    console.log(`[workspace-release] Reusing verified complete release ${key.slice(0, 12)}`);
    await input.onSourcesPrepared?.(input.output);
  };
  await runWithOwnedCleanup(
    async () => {
      lease = cacheOwner.acquire(root, key);
      coordinator = new SharedBuildCoordinator(root, 1);
      const outcome = await coordinator.run(
        key,
        new BuildPriorityOwner("speculative"),
        input.signal ?? new AbortController().signal,
        async () => {
          if (await validateExistingPreparedWorkspaceRelease(cachedInput)) {
            await reuse();
            return;
          }
          await produce();
          input.signal?.throwIfAborted();
          const staging = `${cached}.tmp.${randomUUID()}`;
          await runWithOwnedCleanup(
            async () => {
              await projectRelease(input.output, staging);
              await validateExistingPreparedWorkspaceRelease({ ...cachedInput, output: staging });
              await fs.rename(staging, cached);
            },
            () => fs.rm(staging, { recursive: true, force: true }),
            "Prepared release publication and staging retirement failed"
          );
        }
      );
      if (!outcome.produced) {
        if (!(await validateExistingPreparedWorkspaceRelease(cachedInput)))
          throw new Error(`Shared workspace release ${key} has no completed publication`);
        await reuse();
      }
    },
    () =>
      runOwnedCleanupSteps(
        [() => coordinator?.close(), () => lease?.release(), () => cacheOwner.close()],
        "Prepared release cache retirement failed"
      ),
    "Prepared release cache operation and retirement failed"
  );
  await scheduleDerivedCachePrune(root);
}
