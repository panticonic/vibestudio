import * as fs from "node:fs";
import * as path from "node:path";
import { closeDerivedCacheCoordinators } from "@vibestudio/shared/derivedCache";
import { readExactGitSnapshot, discoverTrackedGitSnapshot } from "@vibestudio/git";
import { getCentralDataPath, getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { readDefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";
import { workspaceReleaseResourceRoot } from "./preparedWorkspaceTemplate.js";
import {
  sameWorkspaceTemplatePin,
  type WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import {
  templateGitTransportUrl,
  normalizeTemplateGitUrl,
} from "@vibestudio/workspace/templateCoordinates";
import { WorkspaceRootTemplateBootstrap } from "./workspaceRootTemplateBootstrap.js";
import {
  preparedWorkspaceTemplatePath,
  preparedWorkspaceTemplateSchema,
} from "./preparedWorkspaceTemplate.js";
import {
  putBootstrapBytes,
  collectTreeReachableDigests,
  blobPath,
} from "./services/blobstoreService.js";
import { acquireRootTemplateSnapshot } from "./acquireRootTemplateSnapshot.js";
import { WorkspaceVcs } from "./vcsHost/workspaceVcs.js";
import { createProtectedRefStore } from "./services/protectedRefStore.js";
import { initBuildSystemV2 } from "./buildV2/index.js";
import { createBuildProcessOwner } from "./buildV2/builder.js";
import { resolveBuildStoreRoots } from "./buildV2/buildStore.js";
import { prepareWorkspaceRuntimeBuilds } from "./workspaceTemplateBuilds.js";
import { startNativeWorkspaceRuntime } from "./nativeWorkspaceRuntime.js";
import { getExistingAppNodeModulesRoots } from "@vibestudio/shared/runtimePaths";
import { exportReleaseBuild } from "../../scripts/prebuild-release-userland.mjs";
import { drainDependencyContentMaintenance } from "./buildV2/dependencyContentMaintenance.js";
import { drainExternalDependencyPruning } from "./buildV2/externalDeps.js";
import { blobCasPath, linkReconstructableBlobFile } from "./storage/blobCas.js";
import { createHostBootstrapGitReadClient } from "./services/hostGitHttpClient.js";
import { hasOwnershipFailure } from "../../scripts/lib/owned-cleanup.mjs";
import {
  publishPreparedWorkspaceRelease,
  validateExistingPreparedWorkspaceRelease,
  workspaceReleaseIdentity,
  type PreparedWorkspaceReleaseBuild,
  type PreparedWorkspaceReleaseInput,
} from "./preparedWorkspaceRelease.js";
import { prepareCachedWorkspaceRelease } from "./preparedWorkspaceReleaseCache.js";

/** Prepare the same immutable release for a source supervisor or a packager.
 * Source publication and compilation are phases of the same owned producer.
 * The output contains source and artifacts, never producer state or grants. */
export async function prepareWorkspaceTemplates(input: {
  appRoot: string;
  output: string;
  sourceOutput?: string;
  scratch: string;
  signal?: AbortSignal;
  onSourcesPrepared?: (root: string) => void | Promise<void>;
}): Promise<void> {
  await prepareCachedWorkspaceRelease(
    {
      appRoot: input.appRoot,
      output: input.output,
      templates: readDefaultWorkspaceTemplates(input.appRoot),
      signal: input.signal,
      onSourcesPrepared: input.onSourcesPrepared,
    },
    () => produceWorkspaceTemplates(input)
  );
}

async function produceWorkspaceTemplates(input: {
  appRoot: string;
  output: string;
  sourceOutput?: string;
  scratch: string;
  signal?: AbortSignal;
  onSourcesPrepared?: (root: string) => void | Promise<void>;
}): Promise<void> {
  const pins = readDefaultWorkspaceTemplates(input.appRoot);
  const releaseInput: PreparedWorkspaceReleaseInput = {
    appRoot: input.appRoot,
    output: input.output,
    templates: pins,
  };
  input.signal?.throwIfAborted();
  if (await validateExistingPreparedWorkspaceRelease(releaseInput)) {
    input.signal?.throwIfAborted();
    await input.onSourcesPrepared?.(input.output);
    return;
  }
  const releaseIdentity = await workspaceReleaseIdentity(input.appRoot);
  const sources = JSON.parse(process.env["VIBESTUDIO_WORKSPACE_SOURCES"] ?? "[]") as Array<{
    pin: WorkspaceTemplatePin;
    checkout: string;
  }>;
  const bootstrapGit = createHostBootstrapGitReadClient({ signal: input.signal });
  const git = bootstrapGit.git;
  const snapshots = new Map<string, ReturnType<typeof readExactGitSnapshot>>();
  const snapshotBlobs = new Map<string, string>();
  fs.mkdirSync(input.scratch, { recursive: true });
  const previousInstance = process.env["VIBESTUDIO_INSTANCE_ROOT"];
  process.env["VIBESTUDIO_INSTANCE_ROOT"] = input.scratch;
  const centralDataRoot = getCentralDataPath();
  const sharedDerivedRoot = getSharedDerivedDataPath();
  // Each role uses the canonical shared derived cache. BuildStore validates
  // exact build identity and hydrates into that role's private state before
  // reusing cached artifacts.
  const processOwner = createBuildProcessOwner({
    appRoot: input.appRoot,
    appNodeModules: getExistingAppNodeModulesRoots(input.appRoot),
  });
  let retirementFailed = false;
  const releaseBuilds: PreparedWorkspaceReleaseBuild[] = [];
  const prepared: Array<{
    role: "base" | "personal" | "system";
    workspaceId: string;
    statePath: string;
    stateHash: string;
    sourcePath: string;
    blobsDir: string;
    directory: string;
    record: import("./preparedWorkspaceTemplate.js").PreparedWorkspaceTemplate;
  }> = [];
  let operationFailure: unknown;
  let operationFailed = false;
  try {
    for (const role of ["base", "personal", "system"] as const) {
      const pin = pins[role];
      input.signal?.throwIfAborted();
      const workspaceId = `prepare-${role}`;
      const workspacePath = path.join(input.scratch, "workspaces", workspaceId);
      const statePath = path.join(workspacePath, "state");
      const sourcePath = path.join(workspacePath, "source");
      const blobsDir = path.join(statePath, "blobs");
      fs.mkdirSync(sourcePath, { recursive: true });
      fs.mkdirSync(path.join(statePath, "workspace-creation"), { recursive: true });
      fs.writeFileSync(
        path.join(statePath, "workspace-creation/v1.json"),
        JSON.stringify({ version: 1, workspaceId, rootTemplate: pin })
      );
      const sink = { put: (bytes: Uint8Array) => putBootstrapBytes(blobsDir, Buffer.from(bytes)) };
      const acquire = (requested: WorkspaceTemplatePin) => {
        const key = JSON.stringify(requested);
        let pending = snapshots.get(key);
        if (!pending) {
          const local = sources.find((source) => sameWorkspaceTemplatePin(source.pin, requested));
          pending = local
            ? readExactGitSnapshot({
                git,
                dir: local.checkout,
                commit: requested.commit,
                label: `prepare ${requested.url}`,
                sink,
                reservedPaths: "exclude",
              })
            : (() => {
                bootstrapGit.admitRemote(templateGitTransportUrl(requested.url));
                return acquireRootTemplateSnapshot({ pin: requested, git, sink });
              })();
          snapshots.set(key, pending);
          snapshotBlobs.set(key, blobsDir);
        }
        return pending.then(async (snapshot) => {
          for (const file of snapshot.files) {
            await linkReconstructableBlobFile(
              blobsDir,
              file.contentHash,
              blobCasPath(snapshotBlobs.get(key)!, file.contentHash),
              file.size
            );
          }
          return snapshot;
        });
      };
      const bootstrap = new WorkspaceRootTemplateBootstrap({
        workspaceId,
        statePath,
        sourcePath,
        sink,
        acquire,
        expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
        releaseTemplates: Object.values(pins),
        resolveTrack: async (address) => {
          const local = sources.find(
            (source) =>
              normalizeTemplateGitUrl(source.pin.url) === normalizeTemplateGitUrl(address.url)
          );
          if (local) return { ref: local.pin.ref, commit: local.pin.commit };
          bootstrapGit.admitRemote(templateGitTransportUrl(address.url));
          const dir = path.join(statePath, "tracks", String(snapshots.size));
          fs.mkdirSync(dir, { recursive: true });
          const snapshot = await discoverTrackedGitSnapshot({
            git,
            dir,
            url: templateGitTransportUrl(address.url),
            track: address.track,
            label: "template release dependency",
            sink,
            reservedPaths: "exclude",
          });
          return { ref: snapshot.ref, commit: snapshot.commit };
        },
      });
      await bootstrap.prepareSource();
      const stateHash = await bootstrap.prepareBootstrapState();
      const plan = await bootstrap.prepareInitialization();
      const closure = new Set<string>();
      for (const contentRoot of [
        stateHash,
        ...plan.repositories.map((repository) => repository.contentRoot),
      ]) {
        const digests = await collectTreeReachableDigests(blobsDir, contentRoot);
        if (!digests)
          throw new Error(`Prepared template has an incomplete source closure: ${contentRoot}`);
        for (const digest of [...digests.treeDigests, ...digests.contentDigests])
          closure.add(digest);
      }
      const directory = preparedWorkspaceTemplatePath(input.output, pin, "use");
      fs.mkdirSync(directory, { recursive: true });
      const blobs = [...closure]
        .sort()
        .map((digest) => ({ digest, size: fs.statSync(blobPath(blobsDir, digest)).size }));
      for (const blob of blobs) {
        const destination = blobPath(path.join(directory, "blobs"), blob.digest);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(blobPath(blobsDir, blob.digest), destination);
      }
      const record = preparedWorkspaceTemplateSchema.parse(bootstrap.preparedRecord(blobs, []));
      fs.writeFileSync(path.join(directory, "template.json"), JSON.stringify(record));
      prepared.push({
        role,
        statePath,
        workspaceId,
        stateHash,
        sourcePath,
        blobsDir,
        directory,
        record,
      });
    }
    input.signal?.throwIfAborted();
    if (input.sourceOutput) {
      for (const { record, blobsDir } of prepared) {
        const directory = preparedWorkspaceTemplatePath(input.sourceOutput, record.pin, "use");
        for (const blob of record.blobs) {
          await linkReconstructableBlobFile(
            path.join(directory, "blobs"),
            blob.digest,
            blobPath(blobsDir, blob.digest),
            blob.size
          );
        }
        fs.mkdirSync(directory, { recursive: true });
        const recordPath = path.join(directory, "template.json");
        fs.writeFileSync(`${recordPath}.publishing`, JSON.stringify(record));
        fs.renameSync(`${recordPath}.publishing`, recordPath);
      }
    }
    await input.onSourcesPrepared?.(input.sourceOutput ?? input.output);
    input.signal?.throwIfAborted();
    const roleOutcomes = await Promise.allSettled(
      prepared.map(
        async ({
          role,
          statePath,
          workspaceId,
          stateHash,
          sourcePath,
          blobsDir,
          directory,
          record,
        }) => {
          input.signal?.throwIfAborted();
          const preparedBuilds: import("./preparedWorkspaceTemplate.js").PreparedWorkspaceTemplate["builds"] =
            [];
          const vcs = new WorkspaceVcs({
            workspaceId,
            initialContentState: stateHash,
            workspaceRoot: sourcePath,
            blobsDir,
            contextProjectionsRoot: path.join(statePath, "contexts"),
            buildSourcesRoot: path.join(statePath, "build-sources"),
            refs: createProtectedRefStore({
              statePath: path.join(statePath, "refs"),
              gate: async () => {
                throw new Error("A release producer cannot publish semantic state");
              },
            }),
          });
          const native = await startNativeWorkspaceRuntime({
            workspaceId,
            statePath,
            sourceRoot: path.join(statePath, "build-sources"),
            scratchRoot: path.join(statePath, "scratch"),
            buildsRoot: path.join(statePath, "builds"),
            appRoot: input.appRoot,
          });
          let builds: Awaited<ReturnType<typeof initBuildSystemV2>> | undefined;
          let retirement: ReturnType<typeof native.stop> | undefined;
          const retireNative = () => (retirement ??= native.stop());
          const cancelled = () => {
            void retireNative().catch(() => {});
          };
          input.signal?.addEventListener("abort", cancelled, { once: true });
          if (input.signal?.aborted) cancelled();
          const retireResources = async () => {
            const failures: unknown[] = [];
            const buildOutcome = await Promise.allSettled([builds?.shutdown()]);
            failures.push(
              ...buildOutcome.flatMap((outcome) =>
                outcome.status === "rejected" ? [outcome.reason] : []
              )
            );
            const nativeOutcome = await Promise.allSettled([
              retireNative().then((stopped) => {
                if (!stopped.launcherExited) {
                  retirementFailed = true;
                  throw Object.assign(
                    new Error("Template preparation still owns a native executor"),
                    {
                      code: "EOWNERSHIP",
                    }
                  );
                }
              }),
            ]);
            failures.push(
              ...nativeOutcome.flatMap((outcome) =>
                outcome.status === "rejected" ? [outcome.reason] : []
              )
            );
            if (failures.length > 0) {
              retirementFailed = failures.some((failure) => hasOwnershipFailure(failure));
              if (failures.length === 1) throw failures[0];
              throw new AggregateError(
                failures,
                "Template preparation resource retirement failed",
                {
                  cause: failures[0],
                }
              );
            }
          };
          let operationFailure: unknown;
          let operationFailed = false;
          try {
            builds = await initBuildSystemV2(sourcePath, vcs, {
              processOwner,
              stateRoot: statePath,
              storeRoots: resolveBuildStoreRoots({
                stateRoot: statePath,
                centralDataRoot,
                sharedDerivedRoot,
              }),
              releaseBuildRoot: path.join(
                workspaceReleaseResourceRoot(input.appRoot),
                "userland-builds"
              ),
              signal: input.signal,
              dependencyWorkspaceRoot: sourcePath,
              runNativeJob: (job) => native.runJob(job),
              admitNativeDependencies: (deps) => native.admitDependencies(deps),
            });
            const preparedAt = performance.now();
            console.log(`[workspace-release] Preparing runtimes for ${role}`);
            const owner = builds;
            const runtimeBuilds = await processOwner.withWorkers(() =>
              prepareWorkspaceRuntimeBuilds(
                owner.getGraph().allNodes(),
                (source) => owner.getStoredBuild(source, stateHash, { priority: "speculative" }),
                (binding) =>
                  exportReleaseBuild(
                    path.join(statePath, "builds", binding.buildKey),
                    path.join(input.output, "userland-builds", binding.buildKey),
                    binding.buildKey
                  ),
                input.signal,
                (event) => {
                  if (event.type === "started") {
                    console.log(`[workspace-release] Runtime ${role}/${event.source}: queued`);
                  } else if (event.type === "completed") {
                    console.log(
                      `[workspace-release] Runtime ${role}/${event.source}: completed in ${Math.round(event.durationMs)}ms`
                    );
                  } else {
                    const detail =
                      event.error instanceof Error ? event.error.message : String(event.error);
                    console.error(
                      `[workspace-release] Runtime ${role}/${event.source}: failed during ${event.phase}: ${detail}`
                    );
                  }
                }
              )
            );
            for (const { source, binding } of runtimeBuilds) {
              releaseBuilds.push({
                workspace: role,
                source,
                buildKey: binding.buildKey,
                builtAt: binding.metadata.builtAt,
              });
              preparedBuilds.push({
                source,
                buildKey: binding.buildKey,
                effectiveVersion: binding.metadata.ev,
              });
            }
            console.log(
              `[workspace-release] Prepared ${role}: ${runtimeBuilds.length} runtimes in ${Math.round(performance.now() - preparedAt)}ms`
            );
          } catch (error) {
            operationFailure = error;
            operationFailed = true;
          }
          try {
            await retireResources();
          } catch (retirementFailure) {
            if (operationFailed) {
              throw new AggregateError(
                [operationFailure, retirementFailure],
                "Template preparation and resource retirement failed",
                { cause: operationFailure }
              );
            }
            throw retirementFailure;
          } finally {
            input.signal?.removeEventListener("abort", cancelled);
          }
          if (operationFailed) throw operationFailure;
          record.builds = preparedBuilds;
          const recordPath = path.join(directory, "template.json");
          fs.writeFileSync(`${recordPath}.publishing`, JSON.stringify(record));
          fs.renameSync(`${recordPath}.publishing`, recordPath);
        }
      )
    );
    const roleFailures = roleOutcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : []
    );
    if (roleFailures.length === 1) throw roleFailures[0];
    if (roleFailures.length > 1) {
      throw new AggregateError(roleFailures, "Workspace runtime preparation failed", {
        cause: roleFailures[0],
      });
    }
    releaseBuilds.sort(
      (a, b) => a.workspace.localeCompare(b.workspace) || a.source.localeCompare(b.source)
    );
    input.signal?.throwIfAborted();
  } catch (error) {
    operationFailure = error;
    operationFailed = true;
  }
  const retirementFailures: unknown[] = [];
  for (const retirement of [
    () => drainExternalDependencyPruning(),
    () => drainDependencyContentMaintenance(),
    () => processOwner.shutdown(),
    () => closeDerivedCacheCoordinators(),
  ]) {
    try {
      await retirement();
    } catch (error) {
      retirementFailures.push(error);
    }
  }
  retirementFailed ||= retirementFailures.some((failure) => hasOwnershipFailure(failure));
  if (previousInstance === undefined) delete process.env["VIBESTUDIO_INSTANCE_ROOT"];
  else process.env["VIBESTUDIO_INSTANCE_ROOT"] = previousInstance;
  if (!retirementFailed) fs.rmSync(input.scratch, { recursive: true, force: true });
  const failures = [...(operationFailed ? [operationFailure] : []), ...retirementFailures];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Workspace template preparation and retirement failed", {
      cause: failures[0],
    });
  }
  input.signal?.throwIfAborted();
  await publishPreparedWorkspaceRelease(releaseInput, releaseBuilds, releaseIdentity);
}
