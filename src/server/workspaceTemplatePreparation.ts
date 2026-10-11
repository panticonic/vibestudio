import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readExactGitSnapshot, discoverTrackedGitSnapshot } from "@vibestudio/git";
import { getUserDataPath, setUserDataPath } from "@vibestudio/env-paths";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { readDefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";
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
import { withBuilderWorkers } from "./buildV2/builder.js";
import { prepareWorkspaceRuntimeBuilds } from "./workspaceTemplateBuilds.js";
import { startNativeWorkspaceRuntime } from "./nativeWorkspaceRuntime.js";
import { getExistingAppNodeModulesRoots } from "@vibestudio/shared/runtimePaths";
import { exportReleaseBuild } from "../../scripts/prebuild-release-userland.mjs";
import { drainBuildStorePublications } from "./buildV2/buildStore.js";
import { blobCasPath, linkReconstructableBlobFile } from "./storage/blobCas.js";
import { createHostBootstrapGitReadClient } from "./services/hostGitHttpClient.js";

/** Prepare the same immutable release for a source supervisor or a packager.
 * Source publication and compilation are phases of the same owned producer.
 * The output contains source and artifacts, never producer state or grants. */
export async function prepareWorkspaceTemplates(input: {
  appRoot: string;
  output: string;
  scratch: string;
  signal?: AbortSignal;
  onSourcesPrepared?: () => void | Promise<void>;
}): Promise<void> {
  const pins = readDefaultWorkspaceTemplates(input.appRoot);
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
  const previousUserData = getUserDataPath();
  process.env["VIBESTUDIO_INSTANCE_ROOT"] = input.scratch;
  let retirementFailed = false;
  const releaseBuilds: Array<{
    workspace: string;
    source: string;
    buildKey: string;
    builtAt: string;
  }> = [];
  const prepared: Array<{
    role: string;
    workspaceId: string;
    statePath: string;
    stateHash: string;
    sourcePath: string;
    blobsDir: string;
    directory: string;
    record: import("./preparedWorkspaceTemplate.js").PreparedWorkspaceTemplate;
  }> = [];
  const publishManifest = () => {
    const manifest = path.join(input.output, "userland-builds/release.json");
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(
      `${manifest}.publishing`,
      JSON.stringify({
        version: 1,
        platform: process.platform,
        arch: process.arch,
        templates: pins,
        builds: releaseBuilds,
      })
    );
    fs.renameSync(`${manifest}.publishing`, manifest);
  };
  try {
    for (const [role, pin] of Object.entries(pins)) {
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
      setUserDataPath(statePath);
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
    publishManifest();
    input.signal?.throwIfAborted();
    await input.onSourcesPrepared?.();
    // Exhaustive compilation is batch work. Its compiler and native children
    // inherit this priority so interactive hosts get CPU first under contention.
    os.setPriority(Math.max(os.getPriority(), os.constants.priority.PRIORITY_BELOW_NORMAL));
    for (const {
      role,
      statePath,
      workspaceId,
      stateHash,
      sourcePath,
      blobsDir,
      directory,
      record,
    } of prepared) {
      input.signal?.throwIfAborted();
      setUserDataPath(statePath);
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
        const outcomes = await Promise.allSettled([
          builds?.shutdown(),
          retireNative().then((stopped) => {
            if (!stopped.launcherExited)
              throw Object.assign(new Error("Template preparation still owns a native executor"), {
                code: "EOWNERSHIP",
              });
          }),
        ]);
        outcomes.push(...(await Promise.allSettled([drainBuildStorePublications()])));
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            retirementFailed = true;
            throw Object.assign(
              outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)),
              { code: "EOWNERSHIP" }
            );
          }
        }
      };
      try {
        builds = await initBuildSystemV2(
          sourcePath,
          vcs,
          getExistingAppNodeModulesRoots(input.appRoot),
          {
            appRoot: input.appRoot,
            signal: input.signal,
            dependencyWorkspaceRoot: sourcePath,
            runNativeJob: (job) => native.runJob(job),
            admitNativeDependencies: (deps) => native.admitDependencies(deps),
          }
        );
        const preparedAt = performance.now();
        console.log(`[workspace-release] Preparing runtimes for ${role}`);
        const owner = builds;
        const runtimeBuilds = await withBuilderWorkers(() =>
          prepareWorkspaceRuntimeBuilds(
            owner.getGraph().allNodes(),
            (source) => owner.getBuild(source, stateHash),
            (binding) =>
              exportReleaseBuild(
                path.join(statePath, "builds", binding.buildKey),
                path.join(input.output, "userland-builds", binding.buildKey),
                binding.buildKey
              ),
            input.signal
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
      } finally {
        try {
          await retireResources();
        } finally {
          input.signal?.removeEventListener("abort", cancelled);
        }
      }
      record.builds = preparedBuilds;
      const recordPath = path.join(directory, "template.json");
      fs.writeFileSync(`${recordPath}.publishing`, JSON.stringify(record));
      fs.renameSync(`${recordPath}.publishing`, recordPath);
      publishManifest();
    }
    input.signal?.throwIfAborted();
  } finally {
    setUserDataPath(previousUserData);
    if (previousInstance === undefined) delete process.env["VIBESTUDIO_INSTANCE_ROOT"];
    else process.env["VIBESTUDIO_INSTANCE_ROOT"] = previousInstance;
    if (!retirementFailed) fs.rmSync(input.scratch, { recursive: true, force: true });
  }
}
