import fs from "node:fs/promises";
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
  publishPreparedWorkspaceRelease,
  preparedWorkspaceReleaseManifestSchema,
  workspaceReleaseManifestPath,
  workspaceReleaseIdentity,
  type PreparedWorkspaceReleaseInput,
  type WorkspaceReleaseOperation,
} from "./preparedWorkspaceRelease.js";

/** Complete release resources are immutable derived data. A consumer owns a
 * private hardlink projection, so deleting instance state never deletes the
 * shared cache, and collecting the cache cannot invalidate a live instance. */
async function projectRelease(source: string, destination: string): Promise<void> {
  // A packager's resource root also contains its ASAR, native tools and other
  // host-owned resources. This operation owns only the two release subtrees;
  // neither cache publication nor consumer projection may capture the host.
  const directories = ["workspace-templates", "userland-builds"].map((name) => ({
    from: path.join(source, name),
    to: path.join(destination, name),
  }));
  const files: Array<{ from: string; to: string }> = [];
  while (directories.length) {
    const directory = directories.pop()!;
    await fs.mkdir(directory.to, { recursive: true });
    for (const entry of await fs.readdir(directory.from, { withFileTypes: true })) {
      const from = path.join(directory.from, entry.name);
      const to = path.join(directory.to, entry.name);
      if (entry.isDirectory()) directories.push({ from, to });
      else if (entry.isFile()) {
        // The completion marker is never part of concurrent payload copying.
        if (from !== workspaceReleaseManifestPath(source)) files.push({ from, to });
      } else throw new Error(`Prepared release contains a non-immutable resource: ${from}`);
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
    operation?: WorkspaceReleaseOperation;
    prepareSources?: (operation: WorkspaceReleaseOperation) => Promise<void>;
  },
  produce: (operation: WorkspaceReleaseOperation) => Promise<void>
): Promise<void> {
  input.signal?.throwIfAborted();
  // The exact host/dependency inputs belong to this operation, not to each
  // validation or publication boundary. Never retain this capture globally.
  const operation = input.operation ?? (await workspaceReleaseIdentity(input.appRoot));
  const identity = operation.identity;
  if (await validateExistingPreparedWorkspaceRelease(input, identity)) {
    await input.onSourcesPrepared?.(input.output);
    return;
  }
  const key = createHash("sha256")
    .update(
      canonicalJson({
        format: "vibestudio-workspace-runtime-release/3",
        platform: process.platform,
        arch: process.arch,
        ...identity,
        templates: input.templates,
        layers: input.layers,
      })
    )
    .digest("hex");
  const root = path.join(getSharedDerivedDataPath(), "workspace-releases");
  const cached = path.join(root, key);
  const cachedInput = { ...input, output: cached };
  const cacheOwner = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
  let lease: ReturnType<DerivedCacheCoordinator["acquire"]> | undefined;
  let coordinator: SharedBuildCoordinator | undefined;
  let sourcesPrepared = false;
  const reuse = async () => {
    await projectRelease(cached, input.output);
    // Reconstruction inherits the already-proved immutable inventory only
    // after every payload link/copy joins. It is not a new compiler publication.
    const marker = workspaceReleaseManifestPath(input.output);
    const temporary = `${marker}.publishing`;
    let ownsTemporary = false;
    await runWithOwnedCleanup(
      async () => {
        await fs.copyFile(
          workspaceReleaseManifestPath(cached),
          temporary,
          fs.constants.COPYFILE_EXCL
        );
        ownsTemporary = true;
        await fs.rename(temporary, marker);
      },
      async () => {
        if (ownsTemporary) await fs.rm(temporary, { force: true });
      },
      "Release projection completion and retirement failed"
    );
    console.log(`[workspace-release] Reusing verified complete release ${key.slice(0, 12)}`);
    if (!sourcesPrepared) {
      sourcesPrepared = true;
      await input.onSourcesPrepared?.(input.output);
    }
  };
  await runWithOwnedCleanup(
    async () => {
      lease = cacheOwner.acquire(root, key);
      // A waiter for the complete background batch must not wait for that batch
      // to obtain its independently published immutable source phase.
      if (await validateExistingPreparedWorkspaceRelease(cachedInput, identity)) {
        await reuse();
        return;
      }
      if (input.prepareSources) {
        await input.prepareSources(operation);
        sourcesPrepared = true;
      }
      coordinator = new SharedBuildCoordinator(root, 1);
      const outcome = await coordinator.run(
        key,
        new BuildPriorityOwner("speculative"),
        input.signal ?? new AbortController().signal,
        async () => {
          if (await validateExistingPreparedWorkspaceRelease(cachedInput, identity)) {
            await reuse();
            return;
          }
          await produce(operation);
          input.signal?.throwIfAborted();
          if (!(await validateExistingPreparedWorkspaceRelease(input, identity)))
            throw new Error("Workspace release producer returned without a completed publication");
          const producedManifest = preparedWorkspaceReleaseManifestSchema.parse(
            JSON.parse(await fs.readFile(workspaceReleaseManifestPath(input.output), "utf8"))
          );
          const staging = `${cached}.tmp.${randomUUID()}`;
          await runWithOwnedCleanup(
            async () => {
              await projectRelease(input.output, staging);
              await publishPreparedWorkspaceRelease(
                { ...cachedInput, output: staging },
                producedManifest.builds,
                identity
              );
              await fs.rename(staging, cached);
            },
            () => fs.rm(staging, { recursive: true, force: true }),
            "Prepared release publication and staging retirement failed"
          );
        }
      );
      if (!outcome.produced) {
        if (!(await validateExistingPreparedWorkspaceRelease(cachedInput, identity)))
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
