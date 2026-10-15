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
import { WorkspaceRootTemplateBootstrap } from "./workspaceRootTemplateBootstrap.js";

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
  existingRelease: vi.fn(),
  processShutdown: vi.fn(),
  buildShutdown: vi.fn(),
  runtimeBuilds: vi.fn(),
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
  validateExistingPreparedWorkspaceRelease: stage.existingRelease,
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
    shutdown: stage.processShutdown,
    withWorkers: async (work: () => Promise<unknown>) => work(),
  }),
}));
vi.mock("./nativeWorkspaceRuntime.js", () => ({ startNativeWorkspaceRuntime: stage.native }));
vi.mock("./buildV2/index.js", () => ({
  initBuildSystemV2: async () => ({
    shutdown: stage.buildShutdown,
    getGraph: () => ({ allNodes: () => [] }),
  }),
}));
vi.mock("./workspaceTemplateBuilds.js", () => ({
  prepareWorkspaceRuntimeBuilds: stage.runtimeBuilds,
}));
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
  stage.existingRelease.mockResolvedValue(false);
  stage.processShutdown.mockResolvedValue(undefined);
  stage.buildShutdown.mockResolvedValue(undefined);
  stage.runtimeBuilds.mockResolvedValue([]);
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

function launch(
  name: string,
  onSourcesPrepared?: (root: string) => Promise<void>,
  signal?: AbortSignal
) {
  return prepareWorkspaceTemplates({
    appRoot: root,
    output: path.join(root, name, "runtime"),
    sourceOutput: path.join(root, name, "ready"),
    scratch: path.join(root, name, "scratch"),
    onSourcesPrepared,
    signal,
  });
}

describe("workspace source preparation ownership", () => {
  it("completes explicit source-only publication without admitting any runtime resources", async () => {
    const output = path.join(root, "sources-only", "output");
    const sourceOutput = path.join(root, "sources-only", "early");
    const scratch = path.join(root, "sources-only", "scratch");
    const progress = vi.fn();
    const ready = vi.fn(async (published: string) => {
      expect(published).toBe(output);
      for (const role of roles) {
        const record = readPreparedWorkspaceTemplate(
          preparedWorkspaceTemplatePath(published, pins[role], "use"),
          pins[role],
          "use"
        );
        expect(record.compilationInput).toBeDefined();
        expect(record.builds).toEqual([]);
      }
    });
    await prepareWorkspaceTemplates({
      appRoot: root,
      output,
      sourceOutput,
      scratch,
      scope: "sources",
      onProgress: progress,
      onSourcesPrepared: ready,
    });
    expect(ready).toHaveBeenCalledOnce();
    expect(progress.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining(
        roles.map((item) => expect.objectContaining({ phase: "sources", total: 3, item }))
      )
    );
    expect(progress.mock.calls.map(([event]) => event.done)).toEqual([1, 2, 3]);
    expect(stage.fullCache).not.toHaveBeenCalled();
    expect(stage.native).not.toHaveBeenCalled();
    expect(stage.runtimeBuilds).not.toHaveBeenCalled();
    expect(stage.processShutdown).not.toHaveBeenCalled();
    expect(stage.buildShutdown).not.toHaveBeenCalled();
    expect(stage.publish).not.toHaveBeenCalled();
    expect(stage.sourceClose).toHaveBeenCalledOnce();
    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.existsSync(sourceOutput)).toBe(false);
    expect(fs.existsSync(path.join(output, "userland-builds", "release.json"))).toBe(false);
  });

  it("projects warm source-only cache records without private runtime hydration or Git reads", async () => {
    const prepare = (name: string) =>
      prepareWorkspaceTemplates({
        appRoot: root,
        output: path.join(root, name, "output"),
        scratch: path.join(root, name, "scratch"),
        scope: "sources",
      });
    await prepare("sources-cold");
    stage.materialize.mockClear();
    stage.indexes.mockClear();
    const hydrate = vi.spyOn(WorkspaceRootTemplateBootstrap.prototype, "prepareSource");
    try {
      await prepare("sources-warm");
      expect(hydrate).not.toHaveBeenCalled();
      expect(stage.materialize).not.toHaveBeenCalled();
      expect(stage.indexes).not.toHaveBeenCalled();
      expect(stage.fullCache).not.toHaveBeenCalled();
      expect(stage.native).not.toHaveBeenCalled();
      expect(stage.runtimeBuilds).not.toHaveBeenCalled();
      expect(stage.sourceClose).toHaveBeenCalledTimes(2);
      for (const role of roles) {
        expect(
          readPreparedWorkspaceTemplate(
            preparedWorkspaceTemplatePath(
              path.join(root, "sources-warm", "output"),
              pins[role],
              "use"
            ),
            pins[role],
            "use"
          ).builds
        ).toEqual([]);
      }
    } finally {
      hydrate.mockRestore();
    }
  });

  it("borrows an already verified complete release without replacing it with source-only records", async () => {
    const output = path.join(root, "borrowed-release");
    const scratch = path.join(root, "borrowed-scratch");
    const marker = path.join(output, "userland-builds", "release.json");
    const template = path.join(output, "workspace-templates", "retained-template.json");
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.mkdirSync(path.dirname(template), { recursive: true });
    fs.writeFileSync(marker, "existing verified release inventory");
    fs.writeFileSync(template, "existing source and runtime bindings");
    // Inventory validity is the canonical validator's responsibility. This
    // boundary test proves that a positive receipt never admits new production.
    stage.existingRelease.mockResolvedValueOnce(true);
    const ready = vi.fn(async () => {});
    await prepareWorkspaceTemplates({
      appRoot: root,
      output,
      scratch,
      scope: "sources",
      onSourcesPrepared: ready,
    });
    expect(stage.existingRelease).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot: root, output, templates: pins }),
      expect.objectContaining({ compilerProtocol: buildCompilerProtocolIdentity() })
    );
    expect(ready).toHaveBeenCalledExactlyOnceWith(output);
    expect(fs.readFileSync(marker, "utf8")).toBe("existing verified release inventory");
    expect(fs.readFileSync(template, "utf8")).toBe("existing source and runtime bindings");
    expect(stage.sources).not.toHaveBeenCalled();
    expect(stage.fullCache).not.toHaveBeenCalled();
    expect(stage.materialize).not.toHaveBeenCalled();
    expect(stage.indexes).not.toHaveBeenCalled();
    expect(stage.native).not.toHaveBeenCalled();
    expect(stage.runtimeBuilds).not.toHaveBeenCalled();
    expect(stage.publish).not.toHaveBeenCalled();
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it("retains every role resource until withdrawn process-owned compiler jobs join", async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("producer cancelled"), { code: "ECANCELLED" });
    let entered!: () => void;
    const rolesEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let joinStarted!: () => void;
    const joining = new Promise<void>((resolve) => {
      joinStarted = resolve;
    });
    let finishJobs!: () => void;
    const jobs = new Promise<void>((resolve) => {
      finishJobs = resolve;
    });
    let admitted = 0;
    stage.runtimeBuilds.mockImplementation(async () => {
      admitted++;
      if (admitted === 3) entered();
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      });
      return [];
    });
    stage.processShutdown.mockImplementation(async () => {
      joinStarted();
      await jobs;
    });
    const stop = vi.fn(async () => ({ launcherExited: true }));
    stage.native.mockResolvedValue({ stop, runJob: vi.fn(), admitDependencies: vi.fn() });
    const work = launch("cancel-shared", undefined, controller.signal);
    const outcome = work.catch((error: unknown) => error);
    await rolesEntered;
    controller.abort(reason);
    await joining;
    expect(stage.processShutdown).toHaveBeenCalledWith(reason);
    expect(stop).not.toHaveBeenCalled();
    expect(stage.buildShutdown).not.toHaveBeenCalled();
    finishJobs();
    const failure = (await outcome) as AggregateError;
    expect(failure.errors).toEqual([reason, reason, reason]);
    expect(stage.buildShutdown).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(stage.sourceClose).toHaveBeenCalledOnce();
  });

  it("retains independent retirement failures and attempts every role after compiler join fails", async () => {
    const compilerFailure = new Error("compiler join failed");
    const buildFailure = new Error("role shutdown failed");
    stage.processShutdown.mockRejectedValueOnce(compilerFailure);
    stage.buildShutdown.mockRejectedValueOnce(buildFailure);
    const stop = vi.fn(async () => ({ launcherExited: false }));
    stage.native.mockResolvedValue({ stop, runJob: vi.fn(), admitDependencies: vi.fn() });
    const failure = (await launch("retirement-failures").catch(
      (error: unknown) => error
    )) as AggregateError;
    expect(failure.errors[0]).toBe(compilerFailure);
    expect(stage.buildShutdown).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(failure, ["errors", "cause", "message", "code"])).toContain("EOWNERSHIP");
    expect(JSON.stringify(failure, ["errors", "cause", "message", "code"])).toContain(
      buildFailure.message
    );
  });
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

  it("publishes warm source readiness before admitting private runtime hydration", async () => {
    await launch("cold");
    stage.native.mockClear();
    let readyObserved!: () => void;
    let readySettles!: () => void;
    let hydrationObserved!: () => void;
    let hydrate!: () => void;
    const readyStarted = new Promise<void>((resolve) => {
      readyObserved = resolve;
    });
    const readyGate = new Promise<void>((resolve) => {
      readySettles = resolve;
    });
    const hydrationStarted = new Promise<void>((resolve) => {
      hydrationObserved = resolve;
    });
    const hydrationGate = new Promise<void>((resolve) => {
      hydrate = resolve;
    });
    const original = WorkspaceRootTemplateBootstrap.prototype.prepareSource;
    const preparation = vi
      .spyOn(WorkspaceRootTemplateBootstrap.prototype, "prepareSource")
      .mockImplementation(async function (this: WorkspaceRootTemplateBootstrap) {
        hydrationObserved();
        await hydrationGate;
        return original.call(this);
      });
    const ready = vi.fn(async (sourceRoot: string) => {
      expect(preparation).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, "warm", "scratch", "workspaces"))).toBe(false);
      expect(
        readPreparedWorkspaceTemplate(
          preparedWorkspaceTemplatePath(sourceRoot, pins.base, "use"),
          pins.base,
          "use"
        ).compilationInput
      ).toBeDefined();
      readyObserved();
      await readyGate;
    });
    const pending = launch("warm", ready);
    try {
      await Promise.race([
        readyStarted,
        hydrationStarted.then(() => {
          throw new Error("Runtime hydration started before source-ready publication");
        }),
        pending.then(() => {
          throw new Error("Preparation completed without source readiness");
        }),
      ]);
      expect(preparation).not.toHaveBeenCalled();
      readySettles();
      await hydrationStarted;
      expect(ready).toHaveBeenCalledOnce();
      expect(stage.native).not.toHaveBeenCalled();
      expect(stage.sourceClose).toHaveBeenCalledTimes(1);
      hydrate();
      await pending;
      expect(stage.sourceClose).toHaveBeenCalledTimes(2);
    } finally {
      readySettles();
      hydrate();
      await Promise.allSettled([pending]);
      preparation.mockRestore();
    }
  });

  it("does not hydrate warm runtime inputs if a concurrent producer supplies completion", async () => {
    await launch("cold");
    stage.native.mockClear();
    const preparation = vi.spyOn(WorkspaceRootTemplateBootstrap.prototype, "prepareSource");
    stage.fullCache.mockImplementationOnce(async (input: { prepareSources(): Promise<void> }) => {
      await input.prepareSources();
    });
    try {
      const ready = vi.fn(async () => {});
      await launch("late-full-hit", ready);
      expect(ready).toHaveBeenCalledOnce();
      expect(preparation).not.toHaveBeenCalled();
      expect(stage.native).not.toHaveBeenCalled();
      expect(stage.sourceClose).toHaveBeenCalledTimes(2);
    } finally {
      preparation.mockRestore();
    }
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
