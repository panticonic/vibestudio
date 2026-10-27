import * as fs from "node:fs";
import * as path from "node:path";
import { closeDerivedCacheCoordinators } from "@vibestudio/shared/derivedCache";
import {
  readExactGitSnapshotIndex,
  discoverTrackedGitCheckout,
  materializeExactGitSnapshot,
  type ExactGitSnapshotIndex,
} from "@vibestudio/git";
import { getCentralDataPath, getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { readDefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";
import { readWorkspaceSources } from "@vibestudio/workspace/workspaceSources";
import { workspaceReleaseResourceRoot } from "./preparedWorkspaceTemplate.js";
import {
  sameWorkspaceTemplatePin,
  type WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import {
  templateGitTransportUrl,
  normalizeTemplateGitUrl,
} from "@vibestudio/workspace/templateCoordinates";
import {
  WorkspaceRootTemplateBootstrap,
  resolveDeclaredTemplateLayerPlan,
  readTemplateLayerMetadata,
  type ResolvedTemplateLayerPlan,
  type TemplateLayerMetadata,
} from "./workspaceRootTemplateBootstrap.js";
import {
  preparedWorkspaceTemplatePath,
  preparedWorkspaceTemplateSchema,
  installPreparedWorkspaceTemplate,
  readPreparedWorkspaceTemplate,
  type PreparedWorkspaceTemplate,
} from "./preparedWorkspaceTemplate.js";
import {
  putBootstrapBytes,
  collectTreeReachableDigests,
  blobPath,
} from "./services/blobstoreService.js";
import { acquireRootTemplateSnapshotIndex } from "./acquireRootTemplateSnapshot.js";
import { WorkspaceVcs } from "./vcsHost/workspaceVcs.js";
import { createProtectedRefStore } from "./services/protectedRefStore.js";
import { initBuildSystemV2 } from "./buildV2/index.js";
import { createBuildProcessOwner } from "./buildV2/builder.js";
import {
  composeWorkspaceDependencyFingerprint,
  captureRootDependencyFingerprint,
} from "./buildV2/effectiveVersion.js";
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
import { runWithOwnedCleanup, runOwnedCleanupSteps } from "../../scripts/lib/owned-cleanup.mjs";
import { forEachOwnedConcurrent } from "../../scripts/lib/owned-concurrency.mjs";
import {
  publishPreparedWorkspaceRelease,
  validateExistingPreparedWorkspaceRelease,
  workspaceReleaseIdentity,
  type WorkspaceReleaseOperation,
  type WorkspaceReleaseIdentity,
  type PreparedWorkspaceReleaseBuild,
  type PreparedWorkspaceReleaseInput,
} from "./preparedWorkspaceRelease.js";
import {
  consumeCachedWorkspaceRelease,
  prepareCachedWorkspaceRelease,
} from "./preparedWorkspaceReleaseCache.js";
import { acquirePreparedWorkspaceSources } from "./preparedWorkspaceSourceCache.js";
import { readHostPreparationRecipe } from "../../scripts/host-build-generations.mjs";
import { resolveRequiredHostArtifactRoot } from "./appRoot.js";

/** Source supervisors publish sources; builders seal runtimes; product launchers consume existing releases. */
export type WorkspacePreparationScope = "sources" | "release" | "existing";

/** Facts emitted only after the corresponding owned work completes. */
export type WorkspacePreparationProgress =
  | { phase: "sources"; done: number; total: number; item: string }
  | { phase: "runtimes"; done: number; total: number | null; item: string };

const roles = ["base", "personal", "system"] as const;
type WorkspaceRole = (typeof roles)[number];
interface PreparedRole {
  role: WorkspaceRole;
  workspaceId: string;
  statePath: string;
  stateHash: string;
  sourcePath: string;
  blobsDir: string;
  record: PreparedWorkspaceTemplate;
}
interface PreparationInput {
  appRoot: string;
  output: string;
  sourceOutput?: string;
  scratch: string;
  /** Defaults to the complete release; source supervisors request sources explicitly. */
  scope?: WorkspacePreparationScope;
  signal?: AbortSignal;
  onProgress?: (progress: WorkspacePreparationProgress) => void;
  onSourcesPrepared?: (root: string) => void | Promise<void>;
}

/** Prepare the same immutable release for a source supervisor or a packager.
 * Source publication and compilation are phases of the same owned producer.
 * The output contains source and artifacts, never producer state or grants. */
export async function prepareWorkspaceTemplates(input: PreparationInput): Promise<void> {
  input.signal?.throwIfAborted();
  const pins = readDefaultWorkspaceTemplates(input.appRoot);
  const sources = readWorkspaceSources();
  const bootstrapGit = createHostBootstrapGitReadClient({ signal: input.signal });
  const git = bootstrapGit.git;
  const indexes = new Map<string, Promise<ExactGitSnapshotIndex>>();
  const indexOwners: Array<{ close(): void | Promise<void> }> = [];
  const key = (pin: WorkspaceTemplatePin) =>
    JSON.stringify([normalizeTemplateGitUrl(pin.url), pin.commit]);
  const acquireIndex = (pin: WorkspaceTemplatePin): Promise<ExactGitSnapshotIndex> => {
    const coordinate = key(pin);
    let pending = indexes.get(coordinate);
    if (!pending) {
      const local = sources.find((source) => sameWorkspaceTemplatePin(source.pin, pin));
      pending = local
        ? readExactGitSnapshotIndex({
            git,
            dir: local.checkout,
            commit: pin.commit,
            label: `prepare ${pin.url}`,
            reservedPaths: "exclude",
          })
        : (async () => {
            bootstrapGit.admitRemote(templateGitTransportUrl(pin.url));
            const owner = await acquireRootTemplateSnapshotIndex({
              pin,
              git,
              signal: input.signal,
            });
            indexOwners.push(owner);
            return owner.index;
          })();
      indexes.set(coordinate, pending);
    }
    return pending;
  };
  const metadata = async (pin: WorkspaceTemplatePin): Promise<TemplateLayerMetadata> => {
    const local = sources.find((source) => sameWorkspaceTemplatePin(source.pin, pin));
    if (local?.review?.manifestText !== undefined)
      return {
        commit: pin.commit,
        manifestText: local.review.manifestText,
        repositories: local.review.repositories,
      };
    return readTemplateLayerMetadata(await acquireIndex(pin));
  };
  let trackSequence = 0;
  const tracks = new Map<string, Promise<{ ref: string; commit: string }>>();
  const discoverTrack = async (address: { url: string; track: string; credential?: string }) => {
    const local = sources.find(
      (source) => normalizeTemplateGitUrl(source.pin.url) === normalizeTemplateGitUrl(address.url)
    );
    if (local) return { ref: local.pin.ref, commit: local.pin.commit };
    bootstrapGit.admitRemote(templateGitTransportUrl(address.url));
    const dir = path.join(input.scratch, "tracks", String(trackSequence++));
    fs.mkdirSync(dir, { recursive: true });
    const coordinate = await discoverTrackedGitCheckout({
      git,
      dir,
      url: templateGitTransportUrl(address.url),
      track: address.track,
      label: "template release dependency",
    });
    const pin = { url: address.url, ref: coordinate.ref, commit: coordinate.commit };
    if (!indexes.has(key(pin)))
      indexes.set(
        key(pin),
        readExactGitSnapshotIndex({
          git,
          dir,
          commit: pin.commit,
          label: "template release dependency",
          reservedPaths: "exclude",
        })
      );
    return coordinate;
  };
  const resolveTrack = (address: { url: string; track: string; credential?: string }) => {
    const coordinate = JSON.stringify([normalizeTemplateGitUrl(address.url), address.track]);
    let pending = tracks.get(coordinate);
    if (!pending) {
      pending = discoverTrack(address);
      tracks.set(coordinate, pending);
    }
    return pending;
  };
  const plans = {} as Record<WorkspaceRole, ResolvedTemplateLayerPlan>;
  let sourceHandle: Awaited<ReturnType<typeof acquirePreparedWorkspaceSources>> | undefined;
  let preparedRoles: Promise<PreparedRole[]> | undefined;
  let ownsUnretiredWork = false;
  await runWithOwnedCleanup(
    async () => {
      try {
        fs.mkdirSync(input.scratch, { recursive: true });
        // Host identity and dependency metadata are independent exact inputs. Join
        // both before lookup, retaining all failures and their owned index leases.
        const outcomes = await Promise.allSettled([
          workspaceReleaseIdentity(input.appRoot),
          forEachOwnedConcurrent(roles, 3, async (role) => {
            plans[role] = await resolveDeclaredTemplateLayerPlan({
              pin: pins[role],
              root: await metadata(pins[role]),
              expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
              releaseTemplates: Object.values(pins),
              acquire: metadata,
              resolveTrack,
            });
          }),
        ]);
        const failures = outcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason] : []
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, "Workspace preparation input capture failed", {
            cause: failures[0],
          });
        const operationOutcome = outcomes[0];
        if (!operationOutcome || operationOutcome.status !== "fulfilled")
          throw new Error("Workspace release identity capture produced no result");
        const operation = operationOutcome.value;
        const layers = Object.fromEntries(
          roles.map((role) => [role, plans[role].layers.map(({ pin }) => pin)])
        ) as Record<WorkspaceRole, WorkspaceTemplatePin[]>;
        if (input.scope === "existing") {
          await consumeCachedWorkspaceRelease({
            appRoot: input.appRoot,
            output: input.output,
            templates: pins,
            layers,
            operation,
            signal: input.signal,
            onSourcesPrepared: input.onSourcesPrepared,
          });
          return;
        }
        const snapshots = new Map<
          string,
          { pending: ReturnType<typeof materializeExactGitSnapshot>; blobsDir: string }
        >();
        const acquireFor = (blobsDir: string) => (pin: WorkspaceTemplatePin) => {
          const coordinate = key(pin);
          let captured = snapshots.get(coordinate);
          if (!captured) {
            captured = {
              pending: acquireIndex(pin).then((index) =>
                materializeExactGitSnapshot(index, {
                  label: `prepare ${pin.url}`,
                  sink: { put: (bytes) => putBootstrapBytes(blobsDir, Buffer.from(bytes)) },
                })
              ),
              blobsDir,
            };
            snapshots.set(coordinate, captured);
          }
          const owned = captured;
          return owned.pending.then(async (snapshot) => {
            if (owned.blobsDir !== blobsDir)
              await forEachOwnedConcurrent(snapshot.files, 16, async (file) => {
                await linkReconstructableBlobFile(
                  blobsDir,
                  file.contentHash,
                  blobCasPath(owned.blobsDir, file.contentHash),
                  file.size
                );
              });
            return snapshot;
          });
        };
        const prepareSources = async () => {
          const recipe = readHostPreparationRecipe(
            resolveRequiredHostArtifactRoot(),
            process.versions.electron
              ? "prepare-workspace-templates.cjs"
              : "prepare-workspace-templates.mjs"
          );
          sourceHandle = await acquirePreparedWorkspaceSources(
            {
              identity: {
                recipe,
                appDependencyFingerprint: operation.identity.appDependencyFingerprint,
                systemEpoch: WORKSPACE_SYSTEM_EPOCH,
                templates: pins,
                layers,
              },
              signal: input.signal,
            },
            async (stagingRoot) => {
              // The cold source producer retains these private role states for the
              // runtime continuation. Only immutable source records enter the cache.
              preparedRoles = materializeTemplateSources({
                input,
                pins,
                plans,
                acquireFor,
                output: stagingRoot,
              });
              await preparedRoles;
            }
          );
          // Source readiness consumes the sealed immutable descriptors, not a
          // private runtime checkout. Warm hydration belongs to the background
          // producer only if this operation wins complete-build admission.
          const preparedCacheRoot = sourceHandle.root;
          const prepared = roles.map((role) => {
            const directory = preparedWorkspaceTemplatePath(preparedCacheRoot, pins[role], "use");
            return {
              role,
              record: readPreparedWorkspaceTemplate(directory, pins[role], "use"),
              blobsDir: path.join(directory, "blobs"),
            };
          });
          const sourceRoot =
            input.scope === "sources"
              ? input.output
              : (input.sourceOutput ?? path.join(input.scratch, "source-ready-root"));
          if (input.scope !== "sources" && path.resolve(sourceRoot) === path.resolve(input.output))
            throw new Error("Source-ready resources must be separate from runtime publication");
          let completedSources = 0;
          await projectPreparedRoleRecords(prepared, sourceRoot, operation, (role) => {
            input.onProgress?.({
              phase: "sources",
              done: ++completedSources,
              total: roles.length,
              item: role,
            });
          });
          input.signal?.throwIfAborted();
          await input.onSourcesPrepared?.(sourceRoot);
        };
        // Both scopes consume the same immutable source phase. Only complete
        // publication admits the exhaustive runtime continuation and its cache.
        if (input.scope === "sources") {
          if (
            await validateExistingPreparedWorkspaceRelease(
              {
                appRoot: input.appRoot,
                output: input.output,
                templates: pins,
                layers,
              },
              operation.identity
            )
          ) {
            input.signal?.throwIfAborted();
            await input.onSourcesPrepared?.(input.output);
            return;
          }
          await prepareSources();
          return;
        }
        await prepareCachedWorkspaceRelease(
          {
            appRoot: input.appRoot,
            output: input.output,
            templates: pins,
            operation,
            layers,
            signal: input.signal,
            onSourcesPrepared: input.onSourcesPrepared,
            prepareSources,
          },
          async (captured) => {
            if (!sourceHandle)
              throw new Error("Runtime preparation has no owned source preparation");
            preparedRoles ??= materializeTemplateSources({
              input,
              pins,
              plans,
              acquireFor,
              preparedRoot: sourceHandle.root,
            });
            await produceWorkspaceTemplates(
              input,
              captured.identity,
              captured,
              await preparedRoles
            );
          }
        );
      } catch (error) {
        ownsUnretiredWork ||= hasOwnershipFailure(error);
        throw error;
      }
    },
    async () => {
      await runOwnedCleanupSteps(
        [
          async () => {
            await sourceHandle?.close();
          },
          ...indexOwners.map((owner) => async () => {
            await owner.close();
          }),
          () => closeDerivedCacheCoordinators(),
          () => {
            if (!ownsUnretiredWork) fs.rmSync(input.scratch, { recursive: true, force: true });
          },
        ].map((cleanup: () => void | Promise<void>) => async () => {
          try {
            await cleanup();
          } catch (error) {
            ownsUnretiredWork ||= hasOwnershipFailure(error);
            throw error;
          }
        }),
        "Workspace source preparation retirement failed"
      );
    },
    "Workspace preparation and source retirement failed"
  );
}

async function projectPreparedRoleRecords(
  prepared: readonly Pick<PreparedRole, "role" | "record" | "blobsDir">[],
  output: string,
  operation?: WorkspaceReleaseOperation,
  onProjected?: (role: WorkspaceRole) => void
): Promise<void> {
  const fingerprint = operation
    ? captureRootDependencyFingerprint(operation.rootFingerprint)
    : undefined;
  await forEachOwnedConcurrent(prepared, 3, async ({ role, record, blobsDir }) => {
    const directory = preparedWorkspaceTemplatePath(output, record.pin, "use");
    await forEachOwnedConcurrent(record.blobs, 16, async (blob) => {
      await linkReconstructableBlobFile(
        path.join(directory, "blobs"),
        blob.digest,
        blobPath(blobsDir, blob.digest),
        blob.size
      );
    });
    fs.mkdirSync(directory, { recursive: true });
    const published = preparedWorkspaceTemplateSchema.parse({
      ...record,
      builds: [],
      ...(operation
        ? {
            compilationInput: {
              hostBuild: operation.identity.hostBuild,
              compilerProtocol: operation.identity.compilerProtocol,
              fingerprint,
            },
          }
        : {}),
    });
    const recordPath = path.join(directory, "template.json");
    fs.writeFileSync(`${recordPath}.publishing`, JSON.stringify(published));
    fs.renameSync(`${recordPath}.publishing`, recordPath);
    onProjected?.(role);
  });
}

/** Source production and source-cache consumption share the same bootstrap
 * boundary. A hit links immutable input, never producer databases or grants. */
async function materializeTemplateSources(input: {
  input: PreparationInput;
  pins: Record<WorkspaceRole, WorkspaceTemplatePin>;
  plans: Record<WorkspaceRole, ResolvedTemplateLayerPlan>;
  acquireFor(
    blobsDir: string
  ): (pin: WorkspaceTemplatePin) => ReturnType<typeof materializeExactGitSnapshot>;
  preparedRoot?: string;
  output?: string;
}): Promise<PreparedRole[]> {
  const prepared: PreparedRole[] = [];
  await forEachOwnedConcurrent(roles, 3, async (role) => {
    input.input.signal?.throwIfAborted();
    const pin = input.pins[role];
    const workspaceId = `prepare-${role}`;
    const workspacePath = path.join(input.input.scratch, "workspaces", workspaceId);
    const statePath = path.join(workspacePath, "state");
    const sourcePath = path.join(workspacePath, "source");
    const blobsDir = path.join(statePath, "blobs");
    let installedRecord: PreparedWorkspaceTemplate | undefined;
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(path.join(statePath, "workspace-creation"), { recursive: true });
    fs.writeFileSync(
      path.join(statePath, "workspace-creation/v1.json"),
      JSON.stringify({ version: 1, workspaceId, rootTemplate: pin })
    );
    const preparedRoot = input.preparedRoot;
    const bootstrap = new WorkspaceRootTemplateBootstrap({
      workspaceId,
      statePath,
      sourcePath,
      sink: { put: (bytes) => putBootstrapBytes(blobsDir, Buffer.from(bytes)) },
      acquire: input.acquireFor(blobsDir),
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      layerPlan: input.plans[role],
      ...(preparedRoot
        ? {
            preparedTemplate: async () => {
              const record = await installPreparedWorkspaceTemplate(
                preparedWorkspaceTemplatePath(preparedRoot, pin, "use"),
                blobsDir,
                pin,
                "use"
              );
              installedRecord = record;
              return {
                record,
                readFile: (filePath: string) => {
                  const file = record.files.find((file) => file.path === filePath);
                  return file ? fs.readFileSync(blobPath(blobsDir, file.contentHash)) : null;
                },
              };
            },
          }
        : {}),
    });
    await bootstrap.prepareSource();
    const stateHash = await bootstrap.prepareBootstrapState();
    const initialization = await bootstrap.prepareInitialization();
    const closure = new Set<string>();
    if (!installedRecord) {
      for (const contentRoot of [
        stateHash,
        ...initialization.repositories.map((repository) => repository.contentRoot),
      ]) {
        const digests = await collectTreeReachableDigests(blobsDir, contentRoot);
        if (!digests)
          throw new Error(`Prepared template has an incomplete source closure: ${contentRoot}`);
        for (const digest of [...digests.treeDigests, ...digests.contentDigests])
          closure.add(digest);
      }
    }
    const blobs =
      installedRecord?.blobs ??
      [...closure]
        .sort()
        .map((digest) => ({ digest, size: fs.statSync(blobPath(blobsDir, digest)).size }));
    prepared.push({
      role,
      workspaceId,
      statePath,
      stateHash,
      sourcePath,
      blobsDir,
      record: bootstrap.preparedRecord(blobs, []),
    });
  });
  prepared.sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role));
  if (input.output) await projectPreparedRoleRecords(prepared, input.output);
  return prepared;
}

async function produceWorkspaceTemplates(
  input: PreparationInput,
  releaseIdentity: WorkspaceReleaseIdentity,
  operation: WorkspaceReleaseOperation,
  sourceRoles: readonly PreparedRole[]
): Promise<void> {
  const pins = Object.fromEntries(
    sourceRoles.map(({ role, record }) => [role, record.pin])
  ) as Record<WorkspaceRole, WorkspaceTemplatePin>;
  const releaseInput: PreparedWorkspaceReleaseInput = {
    appRoot: input.appRoot,
    output: input.output,
    templates: pins,
    layers: Object.fromEntries(
      sourceRoles.map(({ role, record }) => [role, record.layers])
    ) as Record<WorkspaceRole, WorkspaceTemplatePin[]>,
  };
  const hostDependencyCapture = captureRootDependencyFingerprint(operation.rootFingerprint);
  await projectPreparedRoleRecords(sourceRoles, input.output, operation);
  const prepared = await Promise.all(
    sourceRoles.map(async (role) => ({
      ...role,
      directory: preparedWorkspaceTemplatePath(input.output, role.record.pin, "use"),
      record: preparedWorkspaceTemplateSchema.parse({
        ...role.record,
        compilationInput: {
          hostBuild: releaseIdentity.hostBuild,
          compilerProtocol: releaseIdentity.compilerProtocol,
          fingerprint: hostDependencyCapture,
        },
      }),
      dependencyFingerprint: await composeWorkspaceDependencyFingerprint(
        hostDependencyCapture,
        input.appRoot,
        role.sourcePath
      ),
    }))
  );
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
  const releaseBuilds: PreparedWorkspaceReleaseBuild[] = [];
  let plannedRoles = 0;
  let plannedRuntimes = 0;
  let completedRuntimes = 0;
  const roleRetirements: Array<() => Promise<void>> = [];
  let operationFailure: unknown;
  let operationFailed = false;
  try {
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
          dependencyFingerprint,
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
          const retireExecutor = async () => {
            const stopped = await retireNative();
            if (!stopped.launcherExited) {
              throw Object.assign(new Error("Template preparation still owns a native executor"), {
                code: "EOWNERSHIP",
              });
            }
          };
          // Cancellation belongs to the requests. The process-owned shared
          // flight may retain this role's store, workers, and native executor
          // after its last role borrower has withdrawn.
          roleRetirements.push(() =>
            runOwnedCleanupSteps(
              [() => builds?.shutdown(), retireExecutor],
              "Template preparation resource retirement failed"
            )
          );
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
              dependencyFingerprint,
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
                  if (event.type === "planned") {
                    plannedRoles += 1;
                    plannedRuntimes += event.count;
                  } else if (event.type === "started") {
                    console.log(`[workspace-release] Runtime ${role}/${event.source}: queued`);
                  } else if (event.type === "completed") {
                    console.log(
                      `[workspace-release] Runtime ${role}/${event.source}: completed in ${Math.round(event.durationMs)}ms`
                    );
                    input.onProgress?.({
                      phase: "runtimes",
                      done: ++completedRuntimes,
                      total: plannedRoles === roles.length ? plannedRuntimes : null,
                      item: `${role}/${event.source}`,
                    });
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
  // A role can withdraw from a shared flight before that process-owned flight
  // settles. All role borrowers are now joined; retain every role resource
  // until the process owner has joined the compiler flights themselves.
  for (const retirement of [
    // Withdrawn role borrowers can leave shared compiler work in flight. Its
    // owner must join using the producer's original cancellation, not replace
    // it with an unrelated shutdown failure while retiring the same work.
    () => processOwner.shutdown(input.signal?.aborted ? input.signal.reason : undefined),
    async () => {
      // The three role lifetimes are independent once their shared owner joins.
      // Admit all cleanup, and retain every failure rather than short-circuiting.
      const outcomes = await Promise.allSettled(roleRetirements.map((retire) => retire()));
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Template role retirement failed", {
          cause: failures[0],
        });
    },
    () => drainExternalDependencyPruning(),
    () => drainDependencyContentMaintenance(),
  ]) {
    try {
      await retirement();
    } catch (error) {
      retirementFailures.push(error);
    }
  }
  if (previousInstance === undefined) delete process.env["VIBESTUDIO_INSTANCE_ROOT"];
  else process.env["VIBESTUDIO_INSTANCE_ROOT"] = previousInstance;
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
