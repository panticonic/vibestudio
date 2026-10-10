import * as fs from "node:fs";
import * as path from "node:path";
import { GitClient, readExactGitSnapshot, discoverTrackedGitSnapshot } from "@vibestudio/git";
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
import { BootstrapWorkspaceSource } from "./buildV2/bootstrapWorkspaceSource.js";
import { createProtectedRefStore } from "./services/protectedRefStore.js";
import { initBuildSystemV2 } from "./buildV2/index.js";
import { startNativeWorkspaceRuntime } from "./nativeWorkspaceRuntime.js";
import { getExistingAppNodeModulesRoots } from "@vibestudio/shared/runtimePaths";
import { exportReleaseBuild } from "../../scripts/prebuild-release-userland.mjs";
import { blobCasPath, linkReconstructableBlobFile } from "./storage/blobCas.js";

/** Prepare the same immutable release for a source supervisor or a packager.
 * All Git acquisition and compilation is owned here, before workspace launch.
 * The output contains source and artifacts, never producer state or grants. */
export async function prepareWorkspaceTemplates(input: {
  appRoot: string;
  output: string;
  scratch: string;
  signal?: AbortSignal;
}): Promise<void> {
  const pins = readDefaultWorkspaceTemplates(input.appRoot);
  const sources = JSON.parse(process.env["VIBESTUDIO_WORKSPACE_SOURCES"] ?? "[]") as Array<{
    pin: WorkspaceTemplatePin;
    checkout: string;
  }>;
  const git = new GitClient();
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
  try {
    for (const [role, pin] of Object.entries(pins)) {
      input.signal?.throwIfAborted();
      const workspaceId = `prepare-${role}`;
      const statePath = path.join(input.scratch, role);
      const sourcePath = path.join(statePath, "source");
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
            : acquireRootTemplateSnapshot({ pin: requested, git, sink });
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
      const preparedBuilds: import("./preparedWorkspaceTemplate.js").PreparedWorkspaceTemplate["builds"] =
        [];
      const vcs = new WorkspaceVcs({
        workspaceId,
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
      const source = new BootstrapWorkspaceSource(workspaceId, vcs, stateHash, {
        kind: "bootstrap-snapshot",
        snapshotHash: stateHash,
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
              throw new Error("Template preparation still owns a native executor");
          }),
        ]);
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            retirementFailed = true;
            throw outcome.reason;
          }
        }
      };
      try {
        builds = await initBuildSystemV2(
          sourcePath,
          source,
          getExistingAppNodeModulesRoots(input.appRoot),
          {
            appRoot: input.appRoot,
            signal: input.signal,
            dependencyWorkspaceRoot: sourcePath,
            runNativeJob: (job) => native.runJob(job),
            admitNativeDependencies: (deps) => native.admitDependencies(deps),
          }
        );
        for (const node of builds.getGraph().allNodes()) {
          if (
            node.kind === "package" ||
            node.kind === "template" ||
            (node.kind === "app" && node.manifest.app?.target === "react-native")
          )
            continue;
          input.signal?.throwIfAborted();
          console.log(`[workspace-release] Preparing ${role}: ${node.relativePath}`);
          const binding = await builds.getBuild(node.relativePath, stateHash);
          const key = binding.buildKey;
          releaseBuilds.push({
            workspace: role,
            source: node.relativePath,
            buildKey: key,
            builtAt: binding.metadata.builtAt,
          });
          preparedBuilds.push({
            source: node.relativePath,
            buildKey: key,
            effectiveVersion: binding.metadata.ev,
          });
          await exportReleaseBuild(
            path.join(statePath, "builds", key),
            path.join(input.output, "userland-builds", key),
            key
          );
        }
      } finally {
        try {
          await retireResources();
        } finally {
          input.signal?.removeEventListener("abort", cancelled);
        }
      }
      const record = preparedWorkspaceTemplateSchema.parse(
        bootstrap.preparedRecord(blobs, preparedBuilds)
      );
      fs.writeFileSync(path.join(directory, "template.json"), JSON.stringify(record));
      console.log(
        `[workspace-release] Prepared ${role}: ${record.files.length} files, ${record.builds.length} artifacts`
      );
    }
    input.signal?.throwIfAborted();
    fs.mkdirSync(path.join(input.output, "userland-builds"), { recursive: true });
    fs.writeFileSync(
      path.join(input.output, "userland-builds/release.json"),
      JSON.stringify({
        version: 1,
        platform: process.platform,
        arch: process.arch,
        templates: pins,
        builds: releaseBuilds,
      })
    );
  } finally {
    setUserDataPath(previousUserData);
    if (previousInstance === undefined) delete process.env["VIBESTUDIO_INSTANCE_ROOT"];
    else process.env["VIBESTUDIO_INSTANCE_ROOT"] = previousInstance;
    if (!retirementFailed) fs.rmSync(input.scratch, { recursive: true, force: true });
  }
}
