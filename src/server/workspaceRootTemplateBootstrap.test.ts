import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSnapshotDigest, sha256Hex } from "@vibestudio/content-addressing";
import type { ExactGitSnapshot } from "@vibestudio/git";
import {
  hostBuildUnitInventoryPath,
  isHostBuildUnitSource,
  readHostBuildUnitInventory,
} from "@vibestudio/shared/hostBuildUnits";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { canonicalTemplateYaml } from "@vibestudio/workspace/templateManifest";
import {
  WorkspaceRootTemplateBootstrap,
  enumerateRootTemplateRepositories,
} from "./workspaceRootTemplateBootstrap.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function snapshot(
  entries: Array<{ path: string; text: string; mode?: 0o644 | 0o755 }>,
  commit = "a".repeat(40)
): ExactGitSnapshot {
  const bytesByPath = new Map(
    entries.map((entry) => [entry.path, new TextEncoder().encode(entry.text)])
  );
  const files = [...new Map(entries.map((entry) => [entry.path, entry])).values()].map((entry) => {
    const bytes = bytesByPath.get(entry.path)!;
    return {
      path: entry.path,
      contentHash: sha256Hex(bytes),
      size: bytes.byteLength,
      mode: entry.mode ?? (0o644 as const),
    };
  });
  return {
    commit,
    snapshot: canonicalSnapshotDigest(
      files.map((file) => ({
        ...file,
        mode: file.mode === 0o755 ? 0o100755 : 0o100644,
      }))
    ),
    files,
    readFile: (filePath) => bytesByPath.get(filePath) ?? null,
  };
}

function fixture(
  rootSnapshot: ExactGitSnapshot,
  options: {
    designation?: (pin: { url: string }) => { vouchesWholeTree: boolean } | null;
    layers?: Record<string, ExactGitSnapshot>;
    resolveTrack?: (address: { url: string; track: string }) => Promise<{
      ref: string;
      commit: string;
    }>;
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-template-bootstrap-"));
  roots.push(root);
  const statePath = path.join(root, "state");
  const sourcePath = path.join(root, "source");
  fs.mkdirSync(path.join(statePath, "workspace-creation"), { recursive: true });
  fs.mkdirSync(sourcePath);
  const pin = {
    url: "git+https://example.test/base.git",
    ref: "refs/tags/v1",
    commit: rootSnapshot.commit,
  };
  fs.writeFileSync(
    path.join(statePath, "workspace-creation/v1.json"),
    JSON.stringify({ version: 1, workspaceId: "ws-1", rootTemplate: pin })
  );
  const acquire = vi.fn(async (requested: { commit: string }) =>
    requested.commit === rootSnapshot.commit
      ? rootSnapshot
      : (options.layers?.[requested.commit] ??
        (() => {
          throw new Error(`no snapshot for ${requested.commit}`);
        })())
  );
  return {
    pin,
    acquire,
    statePath,
    sourcePath,
    bootstrap: new WorkspaceRootTemplateBootstrap({
      workspaceId: "ws-1",
      statePath,
      sourcePath,
      acquire,
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      sink: {
        put: async (bytes) => ({ digest: sha256Hex(bytes), size: bytes.byteLength }),
      },
      ...(options.designation ? { designation: options.designation } : {}),
      ...(options.resolveTrack ? { resolveTrack: options.resolveTrack } : {}),
    }),
  };
}

describe("WorkspaceRootTemplateBootstrap", () => {
  const seededSnapshot = () =>
    snapshot([
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          template: {
            name: "Base",
            repositories: ["extensions/templates"],
            files: ["README.md"],
          },
          extensions: [{ source: "extensions/templates" }],
        }),
      },
      { path: "extensions/templates/package.json", text: "{}" },
      { path: "extensions/templates/index.ts", text: "export {};" },
      { path: "README.md", text: "repository tooling" },
    ]);

  it("records what a designated template shipped, so units need no signature", async () => {
    const fx = fixture(seededSnapshot(), { designation: () => ({ vouchesWholeTree: false }) });

    await fx.bootstrap.prepareSource();

    const inventory = readHostBuildUnitInventory(hostBuildUnitInventoryPath(fx.statePath));
    expect(inventory).toMatchObject({ templateUrl: fx.pin.url, commit: fx.pin.commit });
    expect(Object.keys(inventory!.units)).toContain("extensions/templates");
    expect(
      isHostBuildUnitSource({
        inventory,
        repoPath: "extensions/templates",
        unitDir: path.join(fx.sourcePath, "extensions/templates"),
      })
    ).toBe(true);
  });

  it("records nothing for a template the host does not designate", async () => {
    // A third-party template must not be able to claim any of its units ship
    // with Vibestudio, however its files are arranged.
    const fx = fixture(seededSnapshot(), { designation: () => null });

    await fx.bootstrap.prepareSource();

    expect(readHostBuildUnitInventory(hostBuildUnitInventoryPath(fx.statePath))).toBeNull();
  });

  it("rejects a descriptorless workspace before userland startup", async () => {
    const rootSnapshot = snapshot([]);
    const fx = fixture(rootSnapshot);
    fs.rmSync(path.join(fx.statePath, "workspace-creation/v1.json"));

    await expect(fx.bootstrap.prepareSource()).rejects.toThrow(
      /missing its current creation descriptor/
    );
    expect(fx.acquire).not.toHaveBeenCalled();
  });

  it("acquires, validates, and imports the exact root source without installed layers", async () => {
    const runtime = canonicalTemplateYaml({
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      extensions: [{ source: "extensions/templates" }],
    });
    const rootSnapshot = snapshot([
      {
        path: "meta/vibestudio.yml",
        text: runtime,
      },
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          template: {
            name: "Base",
            repositories: ["extensions/templates"],
            files: ["README.md"],
          },
          extensions: [{ source: "extensions/templates" }],
        }),
      },
      { path: "extensions/templates/package.json", text: "{}" },
      { path: "extensions/templates/index.ts", text: "export {};" },
      { path: "README.md", text: "repository tooling" },
    ]);
    const fx = fixture(rootSnapshot);

    await expect(fx.bootstrap.prepareInitialization()).resolves.toEqual({
      pin: fx.pin,
      repositories: enumerateRootTemplateRepositories(rootSnapshot),
    });
    expect(fx.acquire).toHaveBeenCalledExactlyOnceWith(fx.pin);
    expect(fs.existsSync(path.join(fx.sourcePath, "meta/templates.state.yml"))).toBe(false);
    expect(fs.existsSync(path.join(fx.sourcePath, "meta/templates/workspace.yml"))).toBe(false);
    expect(fs.readFileSync(path.join(fx.sourcePath, "meta/vibestudio.yml"), "utf8")).toBe(
      new TextDecoder().decode(rootSnapshot.readFile("meta/vibestudio.yml")!)
    );
  });

  it("rejects container-root files instead of inventing an owner", () => {
    const rootSnapshot = snapshot([
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({ systemEpoch: WORKSPACE_SYSTEM_EPOCH }),
      },
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          template: { repositories: [], files: [] },
        }),
      },
      { path: "packages/tsconfig.json", text: "{}" },
    ]);
    expect(() => enumerateRootTemplateRepositories(rootSnapshot)).toThrow(
      /root of container section packages/
    );
  });

  it("fails closed when the acquired snapshot differs from the exact descriptor", async () => {
    const rootSnapshot = snapshot([
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({ systemEpoch: WORKSPACE_SYSTEM_EPOCH }),
      },
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          template: { repositories: [], files: [] },
        }),
      },
    ]);
    const fx = fixture(rootSnapshot);
    fx.acquire.mockResolvedValue({ ...rootSnapshot, commit: "b".repeat(40) });

    await expect(fx.bootstrap.prepareInitialization()).rejects.toThrow(
      /coordinates different from the creation descriptor/
    );
  });

  it("restarts from the local materialization receipt without reacquiring the remote root", async () => {
    const rootSnapshot = snapshot([
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({ systemEpoch: WORKSPACE_SYSTEM_EPOCH }),
      },
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          template: { repositories: [], files: [] },
        }),
      },
    ]);
    const fx = fixture(rootSnapshot);
    await fx.bootstrap.prepareSource();

    const unavailableAcquire = vi.fn(async (): Promise<ExactGitSnapshot> => {
      throw new Error("template registry unavailable");
    });
    const restarted = new WorkspaceRootTemplateBootstrap({
      workspaceId: "ws-1",
      statePath: fx.statePath,
      sourcePath: fx.sourcePath,
      acquire: unavailableAcquire,
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      sink: {
        put: async (bytes) => ({ digest: sha256Hex(bytes), size: bytes.byteLength }),
      },
    });

    await expect(restarted.prepareSource()).resolves.toEqual(fx.pin);
    expect(unavailableAcquire).not.toHaveBeenCalled();
  });

  it("accepts template authoring metadata in the runtime manifest", async () => {
    const rootSnapshot = snapshot([
      {
        path: "meta/vibestudio.yml",
        text:
          `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n` +
          `template:\n  repositories: []\n  files: []\n`,
      },
    ]);
    const fx = fixture(rootSnapshot);

    await expect(fx.bootstrap.prepareInitialization()).resolves.toEqual({
      pin: fx.pin,
      repositories: enumerateRootTemplateRepositories(rootSnapshot),
    });
  });

  it("lays a declared dependency underneath and runs on one merged manifest", async () => {
    const baseCommit = "b".repeat(40);
    const baseSnapshot = snapshot(
      [
        {
          path: "meta/vibestudio.yml",
          text: canonicalTemplateYaml({
            systemEpoch: WORKSPACE_SYSTEM_EPOCH,
            defaultRepo: "projects/default",
            extensions: [{ source: "extensions/templates" }],
            template: {
              name: "Base",
              repositories: ["extensions/templates"],
              files: [],
            },
          }),
        },
        { path: "extensions/templates/package.json", text: "{}" },
        { path: "extensions/templates/index.ts", text: "export {};" },
      ],
      baseCommit
    );
    // Personal declares only what it adds, and names no version: the dependency
    // follows Base's releases.
    const rootSnapshot = snapshot([
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          template: {
            name: "Personal",
            dependencies: [{ url: "git+https://example.test/foundation.git" }],
            repositories: ["panels/news"],
            files: [],
          },
        }),
      },
      { path: "panels/news/package.json", text: "{}" },
      { path: "panels/news/index.ts", text: "export {};" },
    ]);
    const resolveTrack = vi.fn(async () => ({
      ref: "refs/tags/v1.2.0",
      commit: baseCommit,
    }));
    const fx = fixture(rootSnapshot, {
      layers: { [baseCommit]: baseSnapshot },
      resolveTrack,
    });

    const prepared = await fx.bootstrap.prepareInitialization();

    expect(resolveTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "git+https://example.test/foundation.git",
        track: "refs/tags/v*",
      })
    );
    // Both layers' repositories are present and declared, so nothing is unowned.
    expect(prepared.repositories.map((repository) => repository.repoPath).sort()).toEqual([
      "extensions/templates",
      "meta",
      "panels/news",
    ]);
    const composedManifest = fs.readFileSync(
      path.join(fx.sourcePath, "meta/vibestudio.yml"),
      "utf8"
    );
    expect(composedManifest).toContain("panels/news");
    expect(composedManifest).toContain("extensions/templates");
    // Personal never restated defaultRepo, so it keeps the one Base supplied.
    expect(composedManifest).toContain("projects/default");
    expect(composedManifest).toContain("Personal");
    // The receipt says what the workspace is made of, dependency first.
    const receipt = JSON.parse(
      fs.readFileSync(path.join(fx.statePath, "workspace-creation/materialization-v1.json"), "utf8")
    ) as { layers: Array<{ url: string; commit: string }> };
    expect(receipt.layers).toEqual([
      {
        url: "git+https://example.test/foundation.git",
        ref: "refs/tags/v1.2.0",
        commit: baseCommit,
      },
      { url: fx.pin.url, ref: fx.pin.ref, commit: fx.pin.commit },
    ]);
  });

  it("refuses a declared dependency when it cannot resolve the track", async () => {
    const rootSnapshot = snapshot([
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          template: {
            dependencies: [{ url: "git+https://example.test/foundation.git" }],
            repositories: [],
            files: [],
          },
        }),
      },
    ]);
    const fx = fixture(rootSnapshot);

    await expect(fx.bootstrap.prepareInitialization()).rejects.toThrow(
      /cannot resolve their tracks/u
    );
  });
});
