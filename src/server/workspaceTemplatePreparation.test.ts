import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSnapshotDigest, sha256Hex } from "@vibestudio/content-addressing";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { canonicalTemplateYaml } from "@vibestudio/workspace/templateManifest";
import {
  preparedWorkspaceTemplatePath,
  readPreparedWorkspaceTemplate,
} from "./preparedWorkspaceTemplate.js";
import {
  computeRootDependencyFingerprint,
  buildCompilerProtocolIdentity,
} from "./buildV2/effectiveVersion.js";
import { readHostBuildFingerprint, resolveRequiredHostArtifactRoot } from "./appRoot.js";
import { prepareWorkspaceTemplates } from "./workspaceTemplatePreparation.js";

const stage = vi.hoisted(() => ({
  identity: vi.fn(),
  fullCache: vi.fn(),
  sources: vi.fn(),
  indexes: vi.fn(),
  materialize: vi.fn(),
  recipe: vi.fn(),
  sourceClose: vi.fn(),
  native: vi.fn(),
  publish: vi.fn(),
  fullHit: false,
  root: "",
  sourceRoot: "",
  sourcePublished: false,
  snapshots: new Map<
    string,
    {
      commit: string;
      snapshot: string;
      files: Array<{ path: string; contentHash: string; size: number; mode: 0o644 }>;
      readFile(path: string): Uint8Array | null;
    }
  >(),
}));
vi.mock("./preparedWorkspaceRelease.js", async (original) => ({
  ...(await original<typeof import("./preparedWorkspaceRelease.js")>()),
  workspaceReleaseIdentity: stage.identity,
  publishPreparedWorkspaceRelease: stage.publish,
}));
vi.mock("./preparedWorkspaceReleaseCache.js", () => ({
  prepareCachedWorkspaceRelease: stage.fullCache,
}));
vi.mock("./preparedWorkspaceSourceCache.js", () => ({
  acquirePreparedWorkspaceSources: stage.sources,
}));
vi.mock("../../scripts/host-build-generations.mjs", async (original) => ({
  ...(await original<typeof import("../../scripts/host-build-generations.mjs")>()),
  readHostPreparationRecipe: stage.recipe,
}));
vi.mock("@vibestudio/git", async (original) => ({
  ...(await original<typeof import("@vibestudio/git")>()),
  readExactGitSnapshotIndex: stage.indexes,
  materializeExactGitSnapshot: stage.materialize,
}));
vi.mock("./services/hostGitHttpClient.js", () => ({
  createHostBootstrapGitReadClient: () => ({ git: {}, admitRemote() {} }),
}));
vi.mock("./buildV2/builder.js", () => ({
  createBuildProcessOwner: () => ({
    shutdown: async () => {},
    withWorkers: async (work: () => Promise<unknown>) => work(),
  }),
}));
vi.mock("./nativeWorkspaceRuntime.js", () => ({ startNativeWorkspaceRuntime: stage.native }));
vi.mock("./buildV2/index.js", () => ({
  initBuildSystemV2: async () => ({
    shutdown: async () => {},
    getGraph: () => ({ allNodes: () => [] }),
  }),
}));
vi.mock("./workspaceTemplateBuilds.js", () => ({ prepareWorkspaceRuntimeBuilds: async () => [] }));
vi.mock("./vcsHost/workspaceVcs.js", () => ({ WorkspaceVcs: class {} }));
vi.mock("./services/protectedRefStore.js", () => ({ createProtectedRefStore: () => ({}) }));

let root: string;
const roles = ["base", "personal", "system"] as const;
const pins = Object.fromEntries(
  roles.map((role, index) => [
    role,
    {
      url: `git+https://example.test/${role}.git`,
      ref: "refs/tags/v1",
      commit: String(index + 1).repeat(40),
    },
  ])
) as Record<(typeof roles)[number], { url: string; ref: string; commit: string }>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-preparation-test-"));
  stage.root = root;
  stage.sourceRoot = path.join(root, "source-cache");
  stage.sourcePublished = false;
  stage.fullHit = false;
  stage.snapshots.clear();
  for (const role of roles) {
    const manifest = canonicalTemplateYaml({
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      template: { name: role },
      extensions: [{ source: "extensions/templates" }],
    });
    const bytes = new Map([
      ["meta/vibestudio.yml", new TextEncoder().encode(manifest)],
      ["extensions/templates/package.json", new TextEncoder().encode("{}")],
      ["extensions/templates/index.ts", new TextEncoder().encode("export {};")],
    ]);
    const files = [...bytes].map(([path, bytes]) => ({
      path,
      contentHash: sha256Hex(bytes),
      size: bytes.byteLength,
      mode: 0o644 as const,
    }));
    stage.snapshots.set(pins[role].commit, {
      commit: pins[role].commit,
      files,
      snapshot: canonicalSnapshotDigest(files.map((file) => ({ ...file, mode: 0o100644 }))),
      readFile: (file) => bytes.get(file) ?? null,
    });
  }
  vi.stubEnv("VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES", JSON.stringify(pins));
  vi.stubEnv(
    "VIBESTUDIO_WORKSPACE_SOURCES",
    JSON.stringify(
      roles.map((role) => ({
        pin: pins[role],
        checkout: path.join(root, role),
        review: {
          manifestText: new TextDecoder().decode(
            stage.snapshots.get(pins[role].commit)!.readFile("meta/vibestudio.yml")!
          ),
          repositories: ["extensions/templates", "meta"],
          dependencies: [],
        },
      }))
    )
  );
  const rootFingerprint = await computeRootDependencyFingerprint(root);
  stage.identity.mockResolvedValue({
    rootFingerprint,
    identity: {
      appDependencyFingerprint: rootFingerprint.value,
      hostBuild: readHostBuildFingerprint(resolveRequiredHostArtifactRoot()),
      compilerProtocol: buildCompilerProtocolIdentity(),
    },
  });
  stage.recipe.mockReturnValue("a".repeat(64));
  stage.indexes.mockImplementation(async ({ commit }: { commit: string }) =>
    stage.snapshots.get(commit)
  );
  stage.materialize.mockImplementation(
    async (
      snapshot: typeof stage.snapshots extends Map<string, infer T> ? T : never,
      { sink }: { sink: { put(bytes: Uint8Array): Promise<unknown> } }
    ) => {
      for (const file of snapshot.files) await sink.put(snapshot.readFile(file.path)!);
      return snapshot;
    }
  );
  stage.sourceClose.mockResolvedValue(undefined);
  stage.sources.mockImplementation(
    async (_input: unknown, produce: (root: string) => Promise<void>) => {
      if (!stage.sourcePublished) {
        await produce(stage.sourceRoot);
        stage.sourcePublished = true;
      }
      return { root: stage.sourceRoot, close: stage.sourceClose };
    }
  );
  stage.fullCache.mockImplementation(
    async (
      input: {
        output: string;
        operation: unknown;
        onSourcesPrepared?(root: string): Promise<void>;
        prepareSources(): Promise<void>;
      },
      produce: (operation: unknown) => Promise<void>
    ) => {
      if (stage.fullHit) await input.onSourcesPrepared?.(input.output);
      else {
        await input.prepareSources();
        await produce(input.operation);
      }
    }
  );
  stage.native.mockResolvedValue({
    stop: async () => ({ launcherExited: true }),
    runJob: vi.fn(),
    admitDependencies: vi.fn(),
  });
  stage.publish.mockResolvedValue(undefined);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function launch(name: string, onSourcesPrepared?: (root: string) => Promise<void>) {
  return prepareWorkspaceTemplates({
    appRoot: root,
    output: path.join(root, name, "runtime"),
    sourceOutput: path.join(root, name, "ready"),
    scratch: path.join(root, name, "scratch"),
    onSourcesPrepared,
  });
}

describe("workspace source preparation ownership", () => {
  it("captures once, publishes pure cached sources, and retains cold role states for runtime continuation", async () => {
    const ready = vi.fn(async (sourceRoot: string) => {
      expect(stage.native).not.toHaveBeenCalled();
      for (const role of roles) {
        const record = readPreparedWorkspaceTemplate(
          preparedWorkspaceTemplatePath(sourceRoot, pins[role], "use"),
          pins[role],
          "use"
        );
        expect(record.compilationInput).toBeDefined();
        expect(record.builds).toEqual([]);
      }
    });
    await launch("cold", ready);
    expect(ready).toHaveBeenCalledOnce();
    expect(stage.identity).toHaveBeenCalledOnce();
    expect(stage.materialize).toHaveBeenCalledTimes(3);
    expect(stage.native).toHaveBeenCalledTimes(3);
    expect(stage.sourceClose).toHaveBeenCalledOnce();
    for (const role of roles) {
      const record = readPreparedWorkspaceTemplate(
        preparedWorkspaceTemplatePath(stage.sourceRoot, pins[role], "use"),
        pins[role],
        "use"
      );
      expect(record.compilationInput).toBeUndefined();
      expect(record.builds).toEqual([]);
      expect(record.blobs.length).toBeGreaterThan(3);
    }
    expect(fs.existsSync(path.join(root, "cold", "scratch"))).toBe(false);
  });

  it("hydrates cached source through the same bootstrap hook without Git reads or recomposition", async () => {
    await launch("cold");
    stage.materialize.mockClear();
    stage.indexes.mockClear();
    stage.identity.mockClear();
    stage.native.mockClear();
    const ready = vi.fn(async () => {});
    await launch("warm", ready);
    expect(stage.materialize).not.toHaveBeenCalled();
    expect(stage.indexes).not.toHaveBeenCalled();
    expect(stage.identity).toHaveBeenCalledOnce();
    expect(stage.native).toHaveBeenCalledTimes(3);
    expect(ready).toHaveBeenCalledOnce();
    expect(stage.sourceClose).toHaveBeenCalledTimes(2);
  });

  it("does no source hydration on a completed full release hit", async () => {
    stage.fullHit = true;
    const ready = vi.fn(async () => {});
    await launch("full-hit", ready);
    expect(ready).toHaveBeenCalledOnce();
    expect(stage.sources).not.toHaveBeenCalled();
    expect(stage.indexes).not.toHaveBeenCalled();
    expect(stage.materialize).not.toHaveBeenCalled();
    expect(stage.native).not.toHaveBeenCalled();
  });

  it("closes source ownership and removes private state after an original runtime failure", async () => {
    const failure = new Error("native startup failed");
    stage.native.mockRejectedValue(failure);
    await expect(launch("failed")).rejects.toMatchObject({ errors: [failure, failure, failure] });
    expect(stage.sourceClose).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(root, "failed", "scratch"))).toBe(false);
  });

  it("retains source-ready and retirement failures while preventing runtime admission", async () => {
    const readyFailure = new Error("source consumer rejected publication");
    const closeFailure = new Error("source lease retirement failed");
    stage.sourceClose.mockRejectedValueOnce(closeFailure);
    await expect(
      launch("ready-failed", async () => {
        throw readyFailure;
      })
    ).rejects.toMatchObject({ errors: [readyFailure, closeFailure] });
    expect(stage.native).not.toHaveBeenCalled();
    expect(stage.sourceClose).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(root, "ready-failed", "scratch"))).toBe(false);
  });
});
