import { parse } from "yaml";
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
  composeDeclaredTemplateLayers,
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
    preparedTemplate?: import("./workspaceRootTemplateBootstrap.js").WorkspaceRootTemplateBootstrapDeps["preparedTemplate"];
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
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
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
        put: async (bytes) => {
          const digest = sha256Hex(bytes);
          blobs.set(digest, bytes);
          return { digest, size: bytes.byteLength };
        },
      },
      ...(options.preparedTemplate ? { preparedTemplate: options.preparedTemplate } : {}),
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
          },
          extensions: [{ source: "extensions/templates" }],
        }),
      },
      { path: "extensions/templates/package.json", text: "{}" },
      { path: "extensions/templates/index.ts", text: "export {};" },
      { path: "extensions/templates/README.md", text: "unit documentation" },
    ]);

  it("publishes the acquired template content independently of mutable projection bytes", async () => {
    const fx = fixture(seededSnapshot());
    await fx.bootstrap.prepareSource();
    const first = await fx.bootstrap.prepareBootstrapState();
    const acquisitions = fx.acquire.mock.calls.length;
    fs.writeFileSync(
      path.join(fx.sourcePath, "extensions/templates/index.ts"),
      "changed projection"
    );
    expect(await fx.bootstrap.prepareBootstrapState()).toBe(first);
    expect(fx.acquire).toHaveBeenCalledTimes(acquisitions);
    const nodeBytes = fx.blobs.get(first.slice("state:".length));
    expect(nodeBytes).toBeDefined();
    expect(sha256Hex(nodeBytes!)).toBe(first.slice("state:".length));
    const sourceDigest = sha256Hex(new TextEncoder().encode("export {};"));
    expect(
      [...fx.blobs.values()].some((bytes) => new TextDecoder().decode(bytes).includes(sourceDigest))
    ).toBe(true);
  });

  it("installs a prepared source and its publication without Git acquisition or tree reconstruction", async () => {
    const source = seededSnapshot();
    const producer = fixture(source);
    await producer.bootstrap.prepareSource();
    const expectedState = await producer.bootstrap.prepareBootstrapState();
    const build = {
      source: "extensions/templates",
      buildKey: "a".repeat(64),
      effectiveVersion: "b".repeat(64),
    };
    const record = producer.bootstrap.preparedRecord([], [build]);
    const bytes = new Map(
      record.files.map((file) => [
        file.path,
        fs.readFileSync(path.join(producer.sourcePath, file.path)),
      ])
    );
    const preparedTemplate = vi.fn(async () => ({
      record,
      readFile: (filePath: string) => bytes.get(filePath) ?? null,
    }));
    const consumer = fixture(source, { preparedTemplate });
    await consumer.bootstrap.prepareSource();
    expect(await consumer.bootstrap.prepareBootstrapState()).toBe(expectedState);
    expect(await consumer.bootstrap.prepareInitialization()).toEqual(
      await producer.bootstrap.prepareInitialization()
    );
    expect(consumer.acquire).not.toHaveBeenCalled();
    expect(consumer.blobs.size).toBe(0);
    expect(
      fs.readFileSync(path.join(consumer.sourcePath, "extensions/templates/index.ts"), "utf8")
    ).toBe("export {};");
    expect(preparedTemplate).toHaveBeenCalledOnce();
    expect(
      consumer.bootstrap.preparedBuildForContent(expectedState, "extensions/templates")
    ).toEqual(build);
    expect(
      consumer.bootstrap.preparedBuildForContent(`state:${"c".repeat(64)}`, "extensions/templates")
    ).toBeNull();
    expect(consumer.bootstrap.preparedBuildForContent(expectedState, "workers/missing")).toBeNull();
  });

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
          },
          extensions: [{ source: "extensions/templates" }],
        }),
      },
      { path: "extensions/templates/package.json", text: "{}" },
      { path: "extensions/templates/index.ts", text: "export {};" },
      { path: "extensions/templates/README.md", text: "unit documentation" },
    ]);
    const fx = fixture(rootSnapshot);

    const prepared = await fx.bootstrap.prepareInitialization();
    expect(prepared.pin).toEqual(fx.pin);
    expect(prepared.repositories.filter((repo) => repo.repoPath !== "meta")).toEqual(
      enumerateRootTemplateRepositories(rootSnapshot).filter((repo) => repo.repoPath !== "meta")
    );
    const installedManifest = parse(
      fs.readFileSync(path.join(fx.sourcePath, "meta/vibestudio.yml"), "utf8")
    );
    expect(prepared.installation.sources.map((source: { pin: unknown }) => source.pin)).toEqual([
      fx.pin,
    ]);
    expect(installedManifest.template.dependencies).toEqual([{ url: fx.pin.url }]);
    expect(prepared.installation.upstream).toBeUndefined();
    expect(fx.acquire).toHaveBeenCalledExactlyOnceWith(fx.pin);
    expect(fs.existsSync(path.join(fx.sourcePath, "meta/templates.state.yml"))).toBe(false);
    expect(fs.existsSync(path.join(fx.sourcePath, "meta/templates/workspace.yml"))).toBe(false);
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
          template: {},
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
          template: {},
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
          template: {},
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
        put: async (bytes) => {
          const digest = sha256Hex(bytes);
          fx.blobs.set(digest, bytes);
          return { digest, size: bytes.byteLength };
        },
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
          `template: {}
`,
      },
    ]);
    const fx = fixture(rootSnapshot);

    const prepared = await fx.bootstrap.prepareInitialization();
    expect(prepared.pin).toEqual(fx.pin);
    expect(prepared.repositories.filter((repo) => repo.repoPath !== "meta")).toEqual(
      enumerateRootTemplateRepositories(rootSnapshot).filter((repo) => repo.repoPath !== "meta")
    );
    const installedManifest = parse(
      fs.readFileSync(path.join(fx.sourcePath, "meta/vibestudio.yml"), "utf8")
    );
    expect(prepared.installation.sources.map((source: { pin: unknown }) => source.pin)).toEqual([
      fx.pin,
    ]);
    expect(installedManifest.template.dependencies).toEqual([{ url: fx.pin.url }]);
    expect(prepared.installation.upstream).toBeUndefined();
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
    // Both layers' repositories are discovered from the composed source.
    expect(prepared.repositories.map((repository) => repository.repoPath).sort()).toEqual([
      "extensions/templates",
      "meta",
      "panels/news",
    ]);
    const composedManifest = fs.readFileSync(
      path.join(fx.sourcePath, "meta/vibestudio.yml"),
      "utf8"
    );
    expect(parse(composedManifest).template).not.toHaveProperty("repositories");
    expect(composedManifest).toContain("extensions/templates");
    // Personal never restated defaultRepo, so it keeps the one Base supplied.
    expect(composedManifest).toContain("projects/default");
    expect(prepared.installation.sources.at(-1)?.manifest).toContain("Personal");
    expect(
      new TextDecoder().decode(fx.blobs.get(sha256Hex(new TextEncoder().encode(composedManifest))))
    ).toBe(composedManifest);
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

describe("composeDeclaredTemplateLayers", () => {
  const baseCommit = "b".repeat(40);
  const dependencyUrl = "git+https://example.test/foundation.git";

  function baseLayer(): ExactGitSnapshot {
    return snapshot(
      [
        {
          path: "meta/vibestudio.yml",
          text: canonicalTemplateYaml({
            systemEpoch: WORKSPACE_SYSTEM_EPOCH,
            defaultRepo: "projects/default",
            template: { name: "Base" },
          }),
        },
        { path: "packages/runtime/package.json", text: '{"name":"@workspace/runtime"}' },
        { path: "packages/runtime/index.ts", text: "export {};" },
      ],
      baseCommit
    );
  }

  function dependentRoot(): ExactGitSnapshot {
    return snapshot([
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          template: {
            name: "System",
            dependencies: [{ url: dependencyUrl }],
          },
        }),
      },
      {
        path: "workers/system-test-runner/package.json",
        text: '{"dependencies":{"@workspace/runtime":"workspace:*"}}',
      },
    ]);
  }

  it("composes a default release from its exact source pins without resolving floating dependencies", async () => {
    const pin = {
      url: "git+https://example.test/system.git",
      ref: "refs/tags/v1.0.0",
      commit: "a".repeat(40),
    };
    const base = { url: dependencyUrl, ref: "refs/tags/v1.0.0", commit: baseCommit };
    const resolveTrack = vi.fn(async () => ({ ref: "refs/tags/v2.0.0", commit: baseCommit }));
    const acquire = vi.fn(async () => baseLayer());
    const input = {
      pin,
      root: dependentRoot(),
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      releaseTemplates: [pin, base],
      acquire,
      resolveTrack,
    };
    const composed = await composeDeclaredTemplateLayers(input);
    expect(resolveTrack).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledWith(base);
    expect(composed.layers[0]).toMatchObject(base);
    await composeDeclaredTemplateLayers({ ...input, purpose: "author" });
    expect(resolveTrack).toHaveBeenCalledOnce();
    resolveTrack.mockClear();
    await composeDeclaredTemplateLayers({ ...input, pin: { ...pin, commit: "c".repeat(40) } });
    expect(resolveTrack).toHaveBeenCalledOnce();
  });

  it.each([undefined, "use", "author"] as const)(
    "composes dependency ownership with purpose %s",
    async (purpose) => {
      const root = dependentRoot();

      const composed = await composeDeclaredTemplateLayers({
        purpose,
        pin: {
          url: "git+https://example.test/system.git",
          ref: "refs/heads/main",
          commit: "a".repeat(40),
        },
        root,
        expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
        acquire: async () => baseLayer(),
        resolveTrack: async () => ({ ref: "refs/tags/v1.0.0", commit: baseCommit }),
      });

      const paths = composed.snapshot.files.map((file) => file.path);
      expect(paths).toContain("workers/system-test-runner/package.json");
      // The dependency this unit resolves against must be in the same tree, or a
      // version derived from it names a closure no workspace ever runs.
      expect(paths).toContain("packages/runtime/package.json");
      expect(paths).toContain("packages/runtime/index.ts");
      // Dependency first, with the template being installed last.
      expect(composed.layers.map((layer) => layer.commit)).toEqual([baseCommit, "a".repeat(40)]);
      const manifest = new TextDecoder().decode(composed.snapshot.readFile("meta/vibestudio.yml")!);
      expect(parse(manifest).template).not.toHaveProperty("repositories");
      expect(manifest).toContain("projects/default");
      const { template } = parse(manifest);
      expect(template.dependencies).toEqual([
        { url: purpose === "author" ? dependencyUrl : "git+https://example.test/system.git" },
      ]);
      expect(composed.installation.upstream?.url).toBe(
        purpose === "author" ? "git+https://example.test/system.git" : undefined
      );
    }
  );

  it("records exact provenance for a template without dependencies", async () => {
    const root = baseLayer();
    const acquire = vi.fn(async () => baseLayer());

    const composed = await composeDeclaredTemplateLayers({
      pin: {
        url: "git+https://example.test/foundation.git",
        ref: "refs/heads/main",
        commit: baseCommit,
      },
      root,
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      acquire,
    });

    expect(acquire).not.toHaveBeenCalled();
    expect(composed.snapshot.readFile("packages/runtime/index.ts")).toEqual(
      root.readFile("packages/runtime/index.ts")
    );
    expect(composed.installation.sources[0]?.pin.commit).toBe(baseCommit);
    expect(
      parse(new TextDecoder().decode(composed.snapshot.readFile("meta/vibestudio.yml")!)).template
    ).not.toHaveProperty("installation");
    expect(composed.layers).toEqual([
      {
        url: "git+https://example.test/foundation.git",
        ref: "refs/heads/main",
        commit: baseCommit,
      },
    ]);
  });

  it("refuses to compose when it cannot resolve a declared dependency's track", async () => {
    await expect(
      composeDeclaredTemplateLayers({
        pin: {
          url: "git+https://example.test/system.git",
          ref: "refs/heads/main",
          commit: "a".repeat(40),
        },
        root: dependentRoot(),
        expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
        acquire: async () => baseLayer(),
      })
    ).rejects.toThrow("cannot resolve their tracks");
  });
});

it("keeps authored configuration and dependency ownership distinct for use and authoring", async () => {
  const pin = {
    url: "git+https://example.test/base.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
  };
  const root = snapshot([
    {
      path: "meta/vibestudio.yml",
      text: canonicalTemplateYaml({
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        defaultRepo: "projects/example",
        template: {},
      }),
    },
    { path: "projects/example/readme.txt", text: "inherited" },
  ]);
  const input = {
    pin,
    root,
    expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
    acquire: async () => root,
  };
  const used = await composeDeclaredTemplateLayers({ ...input, purpose: "use" });
  const defaulted = await composeDeclaredTemplateLayers(input);
  const authored = await composeDeclaredTemplateLayers({ ...input, purpose: "author" });
  const read = (value: typeof used) =>
    parse(Buffer.from(value.snapshot.readFile("meta/vibestudio.yml")!).toString());
  expect(read(defaulted)).toEqual(read(used));
  expect(read(used)).toMatchObject({
    template: { dependencies: [{ url: pin.url }] },
  });
  expect(read(used).defaultRepo).toBe("projects/example");
  expect(used.installation.upstream).toBeUndefined();
  expect(read(used).template).not.toHaveProperty("installation");
  expect(read(authored)).toMatchObject({
    defaultRepo: "projects/example",
    template: {},
  });
  expect(authored.installation.upstream).toEqual(pin);
  const { parseWorkspaceConfigContentWithId } = await import("@vibestudio/workspace/configParser");
  expect(
    parseWorkspaceConfigContentWithId(
      Buffer.from(used.snapshot.readFile("meta/vibestudio.yml")!).toString(),
      "workspace"
    ).defaultRepo
  ).toBe("projects/example");
});

it("round-trips an explicit whole-unit override without resurrecting inherited files", async () => {
  const source = "git+https://example.test/base.git";
  const base = snapshot(
    [
      {
        path: "meta/vibestudio.yml",
        text: canonicalTemplateYaml({
          systemEpoch: WORKSPACE_SYSTEM_EPOCH,
          extensions: [{ source: "extensions/example" }],
          template: {},
        }),
      },
      { path: "extensions/example/index.ts", text: "base" },
      { path: "extensions/example/removed.ts", text: "must not reappear" },
    ],
    "b".repeat(40)
  );
  const derivative = snapshot([
    {
      path: "meta/vibestudio.yml",
      text: canonicalTemplateYaml({
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        template: {
          dependencies: [{ url: source }],
          overrides: [{ repoPath: "extensions/example", source }],
        },
      }),
    },
    { path: "extensions/example/index.ts", text: "override" },
  ]);
  const result = await composeDeclaredTemplateLayers({
    pin: {
      url: "git+https://example.test/derived.git",
      ref: "refs/heads/main",
      commit: "a".repeat(40),
    },
    root: derivative,
    purpose: "use",
    expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
    acquire: async () => base,
    resolveTrack: async () => ({ ref: "refs/heads/main", commit: base.commit }),
  });
  expect(Buffer.from(result.snapshot.readFile("extensions/example/index.ts")!).toString()).toBe(
    "override"
  );
  expect(result.snapshot.readFile("extensions/example/removed.ts")).toBeNull();
  const { parseWorkspaceConfigContentWithId } = await import("@vibestudio/workspace/configParser");
  expect(
    parseWorkspaceConfigContentWithId(
      Buffer.from(result.snapshot.readFile("meta/vibestudio.yml")!).toString(),
      "workspace"
    ).extensions
  ).toEqual([{ source: "extensions/example" }]);
});

it("rejects whole-repository collisions even when the layers contain disjoint files", async () => {
  const base = {
    url: "https://example.test/base.git",
    ref: "refs/heads/main",
    commit: "b".repeat(40),
  };
  const root = {
    url: "https://example.test/root.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
  };
  const manifest = (dependencies: unknown[] = []) =>
    canonicalTemplateYaml({
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      template: { dependencies },
    });
  const baseTree = snapshot(
    [
      { path: "meta/vibestudio.yml", text: manifest() },
      { path: "projects/shared/old.txt", text: "dependency" },
    ],
    base.commit
  );
  const rootTree = snapshot(
    [
      { path: "meta/vibestudio.yml", text: manifest([{ url: base.url }]) },
      { path: "projects/shared/new.txt", text: "root" },
    ],
    root.commit
  );
  await expect(
    composeDeclaredTemplateLayers({
      pin: root,
      root: rootTree,
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      acquire: async () => baseTree,
      resolveTrack: async () => ({ ref: base.ref, commit: base.commit }),
    })
  ).rejects.toThrow(/both declare repository projects\/shared/);
});
