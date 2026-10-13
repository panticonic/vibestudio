import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBuildStore,
  createBuildStoreProcessOwner,
  resolveBuildStoreRoots,
  type BuildStore,
  type BuildStoreConfig,
  type BuildResult,
} from "./buildStore.js";
import { ExecutionPublicationJournal } from "../executionPublicationJournal.js";
import { executionArtifactRefFromBuild } from "../executionRootProviders.js";
import { RuntimeImageStore } from "../runtimeImageStore.js";

let owner: ReturnType<typeof createBuildStoreProcessOwner>;
let store: BuildStore;
let currentStateRoot: string;
let testRoot: string;
let releaseRoot: string | null;
let executionIdentity: BuildStoreConfig["executionIdentity"];

function makeStore(stateRoot = currentStateRoot): BuildStore {
  const sharedDerivedRoot = process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"]
    ? path.resolve(process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"])
    : null;
  const config: BuildStoreConfig = {
    stateRoot,
    sharedArtifactPoolRoot: process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"]
      ? path.resolve(process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"])
      : sharedDerivedRoot
        ? path.join(sharedDerivedRoot, "build-artifacts")
        : null,
    sharedBuildResultCacheRoot: process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"]
      ? path.resolve(process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"])
      : sharedDerivedRoot
        ? path.join(sharedDerivedRoot, "build-results")
        : null,
    releaseBuildRoot: releaseRoot,
    executionIdentity,
  };
  return createBuildStore(config, owner);
}

function setStateRoot(stateRoot: string): void {
  currentStateRoot = stateRoot;
  store = makeStore(stateRoot);
}

function setExecutionIdentity(context: NonNullable<BuildStoreConfig["executionIdentity"]>): void {
  executionIdentity = context;
  store = makeStore();
}

function setReleaseBuildRoot(root: string | null): void {
  releaseRoot = root;
  store = makeStore();
}

async function cleanupRoot(root: string): Promise<void> {
  try {
    await owner.drain();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-test-"));
  owner = createBuildStoreProcessOwner();
  currentStateRoot = path.join(testRoot, "state");
  releaseRoot = path.join(testRoot, "installed", "userland-builds");
  executionIdentity = {
    serviceAuthorityForSource: async () =>
      "b7e01c5f5a5351d9b1e459b5fc9e3c36920637eac75afd9ad271b3a0d8736e06",
    workspaceId: "workspace:test",
    executionStateForContent: (stateHash) => ({
      kind: "event",
      eventId: `event:${stateHash}`,
    }),
  };
  store = makeStore();
});

afterEach(async () => {
  await owner.drain();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function build(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    dir: "/tmp/build",
    buildKey: "build-key",
    sourceStateHash: null,
    metadata: {
      kind: "worker",
      name: "workers/a",
      buildKey: "build-key",
      sourcePath: null,
      ev: "ev-worker",
      sourceStateHash: null,
      sourcemap: false,
      authority: { requests: [], provides: [] },
      details: { kind: "generic" },
      builtAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [
      {
        path: "worker.js",
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: "export default {};",
      },
    ],
    ...overrides,
  };
}

function expectedArtifactSetIntegrity(
  entries: Array<{
    path: string;
    role: string;
    contentType: string;
    encoding: string;
    platform?: string;
    integrity?: string | null;
  }>
): string {
  const canonical = entries
    .map((entry) => ({
      path: entry.path,
      role: entry.role,
      contentType: entry.contentType,
      encoding: entry.encoding,
      platform: entry.platform ?? null,
      integrity: entry.integrity ?? null,
    }))
    .sort((a, b) =>
      `${a.path}\0${a.platform ?? ""}`.localeCompare(`${b.path}\0${b.platform ?? ""}`)
    );
  return `sha256-${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

describe("build artifact helpers", () => {
  it("publishes prepared resources only with the complete immutable build", async () => {
    const buildKey = "f".repeat(64);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const publication = store.putStored(
      buildKey,
      { entries: build().artifacts },
      { ...build().metadata, buildKey },
      async (temporaryDirectory) => {
        const dependency = path.join(temporaryDirectory, "node_modules", "fixture");
        await fs.promises.mkdir(dependency, { recursive: true });
        await fs.promises.writeFile(path.join(dependency, "index.js"), "complete");
        ready();
        await gate;
      }
    );
    try {
      await started;
      expect(await store.get(buildKey)).toBeNull();
      complete();
      const published = await publication;
      await expect(
        fs.promises.readFile(
          path.join(published.dir, "node_modules", "fixture", "index.js"),
          "utf8"
        )
      ).resolves.toBe("complete");
    } finally {
      complete();
      await publication;
    }
  });

  it("does not publish or retain a failed resource preparation", async () => {
    const buildKey = "e".repeat(64);
    const failure = new Error("dependency projection failed");
    await expect(
      store.putStored(
        buildKey,
        { entries: build().artifacts },
        { ...build().metadata, buildKey },
        async (temporaryDirectory) => {
          await fs.promises.writeFile(
            path.join(temporaryDirectory, "partial-dependency"),
            "partial"
          );
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    expect(await store.get(buildKey)).toBeNull();
  });

  it("resolves shared roots from explicit managed-workspace inputs and overrides", () => {
    expect(
      resolveBuildStoreRoots({
        stateRoot: "/data/workspaces/personal/state",
        centralDataRoot: "/data",
        sharedDerivedRoot: "/profile/derived",
      })
    ).toEqual({
      sharedArtifactPoolRoot: "/profile/derived/build-artifacts",
      sharedBuildResultCacheRoot: "/profile/derived/build-results",
    });
    expect(
      resolveBuildStoreRoots({
        stateRoot: "/tmp/project/state",
        centralDataRoot: "/data",
        sharedDerivedRoot: "/profile/derived",
        artifactPoolOverride: "/custom/pool",
      })
    ).toEqual({
      sharedArtifactPoolRoot: "/custom/pool",
      sharedBuildResultCacheRoot: null,
    });
  });

  it("admits a newly verified build before synchronous runtime-image publication", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-publication-"));
    const buildKey = "d".repeat(64);
    let journal: ExecutionPublicationJournal | undefined;
    try {
      setStateRoot(root);
      const sourceStateHash = `state:${"8".repeat(64)}`;
      const stored = await store.putStored(
        buildKey,
        { entries: build().artifacts },
        {
          ...build().metadata,
          buildKey,
          sourcePath: "workers/a",
          ev: "e".repeat(64),
          sourceStateHash,
        }
      );
      const artifact = executionArtifactRefFromBuild("workspace:test", stored);
      journal = new ExecutionPublicationJournal(root, (requestedBuildKey, executionDigest) => {
        const verified = store.peekLocal(requestedBuildKey);
        if (!verified) return null;
        const resolved = executionArtifactRefFromBuild("workspace:test", verified);
        return resolved.executionDigest === executionDigest ? resolved : null;
      });

      expect(store.peekLocal(buildKey)).toBe(stored);
      expect(() =>
        new RuntimeImageStore(root, journal).upsert({
          id: "do-service:workers/a:ExampleDO",
          source: "workers/a",
          unitName: "workers/a",
          artifact,
          authority: stored.metadata.authority!,
        })
      ).not.toThrow();
    } finally {
      await owner.drain();
      journal?.close();
      await cleanupRoot(root);
    }
  });

  it("keeps role state local while sharing only explicitly supplied cache roots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-explicit-build-roots-"));
    const sharedCache = path.join(root, "shared", "build-results");
    const artifactPool = path.join(root, "shared", "build-artifacts");
    const first = createBuildStore(
      {
        stateRoot: path.join(root, "workspace-a", "state"),
        sharedArtifactPoolRoot: artifactPool,
        sharedBuildResultCacheRoot: sharedCache,
        releaseBuildRoot: null,
        executionIdentity: null,
      },
      owner
    );
    const second = createBuildStore(
      {
        stateRoot: path.join(root, "workspace-b", "state"),
        sharedArtifactPoolRoot: artifactPool,
        sharedBuildResultCacheRoot: sharedCache,
        releaseBuildRoot: null,
        executionIdentity: null,
      },
      owner
    );
    const key = "a".repeat(64);
    try {
      const stored = await first.put(
        key,
        { entries: build().artifacts },
        { ...build().metadata, buildKey: key }
      );
      const hydrated = await second.getOrHydrate(key);
      expect(stored.dir).toBe(path.join(root, "workspace-a", "state", "builds", key));
      expect(hydrated?.dir).toBe(path.join(root, "workspace-b", "state", "builds", key));
      expect(fs.statSync(path.join(stored.dir, "worker.js")).ino).toBe(
        fs.statSync(path.join(hydrated!.dir, "worker.js")).ino
      );
    } finally {
      await owner.drain();
      await cleanupRoot(root);
    }
  });

  it("verifies a published shared build once, not on every read of the build", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-shared-verify-once-"));
    const sharedCache = path.join(root, "shared", "build-results");
    const store = createBuildStore(
      {
        stateRoot: path.join(root, "workspace", "state"),
        sharedArtifactPoolRoot: path.join(root, "shared", "build-artifacts"),
        sharedBuildResultCacheRoot: sharedCache,
        releaseBuildRoot: null,
        executionIdentity: null,
      },
      owner
    );
    const key = "b".repeat(64);
    const sharedArtifactReads = () =>
      readSpy.mock.calls.filter(([file]) => String(file).startsWith(sharedCache)).length;
    const readSpy = vi.spyOn(fs.promises, "readFile");
    try {
      await store.put(key, { entries: build().artifacts }, { ...build().metadata, buildKey: key });
      await store.get(key);
      const afterVerification = sharedArtifactReads();
      for (let read = 0; read < 5; read += 1) await store.get(key);
      expect(sharedArtifactReads()).toBe(afterVerification);
    } finally {
      readSpy.mockRestore();
      await owner.drain();
      await cleanupRoot(root);
    }
  });

  it("shares extension compiler artifacts without exporting host-specific runtime dependencies", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-shared-build-"));
    const sharedRoot = path.join(root, "shared");
    const makeRoleStore = (role: string) =>
      createBuildStore(
        {
          stateRoot: path.join(root, role, "state"),
          sharedArtifactPoolRoot: null,
          sharedBuildResultCacheRoot: sharedRoot,
          releaseBuildRoot: null,
          executionIdentity: null,
        },
        owner
      );
    const producer = makeRoleStore("producer");
    const consumer = makeRoleStore("consumer");
    const key = "9".repeat(64);
    const metadata = {
      ...build().metadata,
      kind: "extension" as const,
      name: "@workspace-extensions/fixture",
      buildKey: key,
      details: {
        kind: "extension" as const,
        runtimeDepsKey: "fixture-runtime",
        runtimeAbi: null,
        providerContracts: {},
        methodAuthority: {},
        externalDeps: { fixture: "1.0.0" },
      },
    };
    try {
      const stored = await producer.putStored(
        key,
        { entries: build().artifacts },
        metadata,
        async (temporaryDirectory) => {
          const dependency = path.join(temporaryDirectory, "node_modules", "fixture");
          await fs.promises.mkdir(dependency, { recursive: true });
          await fs.promises.writeFile(path.join(dependency, "package.json"), '{"main":"index.js"}');
          await fs.promises.writeFile(path.join(dependency, "index.js"), "module.exports = true;");
          await fs.promises.writeFile(
            path.join(temporaryDirectory, "node_modules", ".vibestudio-runtime-projection.json"),
            JSON.stringify({ version: 1, runtimeDepsKey: "fixture-runtime" })
          );
        }
      );
      const hydrated = await consumer.getOrHydrate(key);
      expect(hydrated).not.toBeNull();
      expect(fs.existsSync(path.join(stored.dir, "node_modules", "fixture", "index.js"))).toBe(
        true
      );
      expect(fs.existsSync(path.join(sharedRoot, key, "node_modules"))).toBe(false);
      expect(fs.existsSync(path.join(hydrated!.dir, "node_modules"))).toBe(false);
      // A pre-fix or interrupted local projection is still a valid compiler
      // cache source. Runtime repair belongs to the BuildSystem reader.
      fs.rmSync(path.join(stored.dir, "node_modules"), { recursive: true });
      fs.rmSync(path.join(sharedRoot, key), { recursive: true });
      expect(await producer.get(key)).not.toBeNull();
      expect(fs.existsSync(path.join(sharedRoot, key, "worker.js"))).toBe(true);
      const third = makeRoleStore("third");
      expect(await third.getOrHydrate(key)).not.toBeNull();
    } finally {
      await owner.drain();
      await cleanupRoot(root);
    }
  });

  it("keeps execution identity isolated across overlapping role stores", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-role-identities-"));
    const sharedRoot = path.join(root, "shared");
    const makeRoleStore = (role: string, authority: string) =>
      createBuildStore(
        {
          stateRoot: path.join(root, role, "state"),
          sharedArtifactPoolRoot: path.join(sharedRoot, "build-artifacts"),
          sharedBuildResultCacheRoot: path.join(sharedRoot, "build-results"),
          releaseBuildRoot: null,
          executionIdentity: {
            workspaceId: `workspace:${role}`,
            executionStateForContent: (stateHash) => ({
              kind: "event",
              eventId: `${role}:${stateHash}`,
            }),
            serviceAuthorityForSource: async () => authority,
          },
        },
        owner
      );
    const first = makeRoleStore("personal", "1".repeat(64));
    const second = makeRoleStore("system", "2".repeat(64));
    const firstKey = "c".repeat(64);
    const secondKey = "d".repeat(64);
    try {
      const [personal, system] = await Promise.all([
        first.put(
          firstKey,
          { entries: build().artifacts },
          {
            ...build().metadata,
            buildKey: firstKey,
            sourcePath: "workers/personal",
            ev: "3".repeat(64),
            sourceStateHash: `state:${"4".repeat(64)}`,
          }
        ),
        second.put(
          secondKey,
          { entries: build().artifacts },
          {
            ...build().metadata,
            buildKey: secondKey,
            sourcePath: "workers/system",
            ev: "5".repeat(64),
            sourceStateHash: `state:${"6".repeat(64)}`,
          }
        ),
      ]);
      expect(personal.metadata.execution?.sourceState.workspaceId).toBe("workspace:personal");
      expect(system.metadata.execution?.sourceState.workspaceId).toBe("workspace:system");
      expect(personal.metadata.serviceAuthorityDigest).toBe("1".repeat(64));
      expect(system.metadata.serviceAuthorityDigest).toBe("2".repeat(64));
      expect(personal.dir).toContain(path.join("personal", "state", "builds"));
      expect(system.dir).toContain(path.join("system", "state", "builds"));
    } finally {
      await owner.drain();
      await cleanupRoot(root);
    }
  });

  it("joins a role's shared publication before that role's state root can retire", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-role-publication-"));
    const sharedCache = path.join(root, "shared", "build-results");
    const role = createBuildStore(
      {
        stateRoot: path.join(root, "role", "state"),
        sharedArtifactPoolRoot: null,
        sharedBuildResultCacheRoot: sharedCache,
        releaseBuildRoot: null,
        executionIdentity: null,
      },
      owner
    );
    const key = "e".repeat(64);
    try {
      const stored = await role.put(
        key,
        { entries: build().artifacts },
        { ...build().metadata, buildKey: key }
      );
      await role.get(key);
      await role.drainPublications();
      expect(fs.existsSync(path.join(stored.dir, "metadata.json"))).toBe(true);
      expect(fs.existsSync(path.join(sharedCache, key, "metadata.json"))).toBe(true);
    } finally {
      await owner.drain();
      await cleanupRoot(root);
    }
  });

  it("joins hydration and shared-cache prune failures without replacing the hydration cause", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-shared-hydration-cleanup-"));
    const sharedCache = path.join(root, "shared-cache");
    const key = "f".repeat(64);
    const previousSharedCache = process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
    process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = sharedCache;
    setStateRoot(path.join(root, "producer"));
    const sourceStateHash = `state:${"e".repeat(64)}`;
    const keyMetadata = {
      ...build().metadata,
      buildKey: key,
      ev: "a".repeat(64),
      sourcePath: "workers/source",
      sourceStateHash,
    };
    const identityFailure = new Error("role source state is unavailable");
    const pruneError = new Error("cache pruning failed");
    const derivedCache = await import("@vibestudio/shared/derivedCache");
    let pruneSpy:
      | import("vitest").MockInstance<typeof derivedCache.scheduleDerivedCachePrune>
      | undefined;
    try {
      await store.put(key, { entries: build().artifacts }, keyMetadata);

      setStateRoot(path.join(root, "consumer"));
      setExecutionIdentity({
        workspaceId: "workspace:consumer",
        serviceAuthorityForSource: async () =>
          "b7e01c5f5a5351d9b1e459b5fc9e3c36920637eac75afd9ad271b3a0d8736e06",
        executionStateForContent: () => {
          throw identityFailure;
        },
      });
      pruneSpy = vi.spyOn(derivedCache, "scheduleDerivedCachePrune").mockRejectedValue(pruneError);
      let failure: unknown;
      try {
        await store.getOrHydrate(key, sourceStateHash);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw failure;
      expect(failure.errors).toEqual([identityFailure, pruneError]);
      expect(failure.cause).toBe(identityFailure);
      await expect(owner.drain()).resolves.toBeUndefined();
    } finally {
      pruneSpy?.mockRestore();
      if (previousSharedCache === undefined)
        delete process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
      else process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = previousSharedCache;
      await cleanupRoot(root);
    }
  });

  it("hydrates installed release bytes into a workspace-owned record without mutating the release", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-release-build-"));
    const key = "e".repeat(64);
    const producerState = `state:${"a".repeat(64)}`;
    const consumerState = `state:${"b".repeat(64)}`;
    try {
      setStateRoot(path.join(root, "producer"));
      const produced = await store.put(
        key,
        { entries: build().artifacts },
        {
          ...build().metadata,
          buildKey: key,
          ev: "c".repeat(64),
          sourcePath: "workers/a",
          sourceStateHash: producerState,
        }
      );
      const installed = path.join(root, "installation", "userland-builds", key);
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.cpSync(produced.dir, installed, { recursive: true });
      const metadataBefore = fs.readFileSync(path.join(installed, "metadata.json"), "utf8");
      setStateRoot(path.join(root, "consumer"));
      setReleaseBuildRoot(path.join(root, "installation", "userland-builds"));
      const hydrated = await store.getOrHydrate(key, consumerState);
      expect(hydrated?.metadata.sourceStateHash).toBe(consumerState);
      expect(hydrated?.dir).toBe(path.join(root, "consumer", "builds", key));
      expect(await store.readStoredArtifactContent(hydrated!, hydrated!.artifacts[0]!)).toBe(
        "export default {};"
      );
      expect(fs.readFileSync(path.join(installed, "metadata.json"), "utf8")).toBe(metadataBefore);
      await expect(store.getOrHydrate("f".repeat(64), consumerState)).resolves.toBeNull();
      fs.writeFileSync(path.join(installed, "worker.js"), "truncated");
      setStateRoot(path.join(root, "second-consumer"));
      await expect(store.getOrHydrate(key, consumerState)).resolves.toBeNull();
    } finally {
      setReleaseBuildRoot(path.join(testRoot, "installed", "userland-builds"));
      await cleanupRoot(root);
    }
  });

  it("reports stored bytes without removing an unreferenced build", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-retention-"));
    try {
      setStateRoot(root);
      const buildDir = path.join(root, "builds", "unreferenced");
      fs.mkdirSync(path.join(buildDir, "nested"), { recursive: true });
      fs.writeFileSync(path.join(buildDir, "metadata.json"), "meta");
      fs.writeFileSync(path.join(buildDir, "nested", "bundle.js"), "bundle");

      await expect(store.scanRetention()).resolves.toEqual({
        builds: [{ key: "unreferenced", bytes: 10 }],
        failures: [],
      });
      expect(fs.readFileSync(path.join(buildDir, "nested", "bundle.js"), "utf8")).toBe("bundle");
    } finally {
      await cleanupRoot(root);
    }
  });

  it("returns the manifest primary artifact content", async () => {
    const result = build();

    expect(store.primaryArtifact(result)).toMatchObject({ path: "worker.js" });
    await expect(store.primaryTextArtifactContent(result)).resolves.toBe("export default {};");
    expect(store.primaryArtifactFilePath(result)).toBe("/tmp/build/worker.js");
  });

  it("fails closed when a text primary artifact is unavailable", async () => {
    await expect(store.primaryTextArtifactContent(build({ artifacts: [] }))).rejects.toThrow(
      /no primary artifact/
    );
    await expect(
      store.primaryTextArtifactContent(
        build({
          artifacts: [
            {
              path: "worker.wasm",
              role: "primary",
              contentType: "application/wasm",
              encoding: "base64",
              content: "AAAA",
            },
          ],
        })
      )
    ).rejects.toThrow(/not UTF-8 text/);
  });

  it("rejects unsafe artifact paths when deriving file paths", () => {
    expect(() => store.artifactFilePath(build(), { path: "../worker.js" })).toThrow(
      /Invalid build artifact path/
    );
    expect(() => store.artifactFilePath(build(), { path: "/tmp/worker.js" })).toThrow(
      /Invalid build artifact path/
    );
  });

  it("computes artifact integrity from stored bytes instead of trusting caller input", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    try {
      setStateRoot(root);
      const metadata = build().metadata;
      const result = await store.put(
        "build-key",
        {
          entries: [
            {
              path: "worker.js",
              role: "primary",
              contentType: "text/javascript; charset=utf-8",
              encoding: "utf8",
              integrity: "sha256-provider-supplied",
              content: "hello",
            },
          ],
        },
        metadata
      );
      const expected = `sha256-${createHash("sha256").update("hello").digest("hex")}`;

      expect(result.artifacts[0]).toMatchObject({ integrity: expected });
      expect(result.buildKey).toBe("build-key");
      expect(result.metadata.buildKey).toBe(result.buildKey);
      expect(Object.isFrozen(result.metadata.authority)).toBe(true);
      expect((await store.get("build-key"))?.artifacts[0]).toMatchObject({ integrity: expected });
    } finally {
      await cleanupRoot(root);
    }
  });

  it("yields the server event loop while persisting artifact bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-async-"));
    try {
      setStateRoot(root);
      let nextTurnRan = false;
      const nextTurn = new Promise<void>((resolve) => {
        setImmediate(() => {
          nextTurnRan = true;
          resolve();
        });
      });

      const persisted = store.put(
        "async-build",
        {
          entries: [
            {
              ...build().artifacts[0]!,
              content: "x".repeat(4 * 1024 * 1024),
            },
          ],
        },
        { ...build().metadata, buildKey: "async-build" }
      );

      await nextTurn;
      expect(nextTurnRan).toBe(true);
      await expect(persisted).resolves.toMatchObject({ buildKey: "async-build" });
    } finally {
      await cleanupRoot(root);
    }
  });

  it("rejects tampered cached bytes and ambiguous artifact paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    try {
      setStateRoot(root);
      const result = await store.put("build-key", { entries: build().artifacts }, build().metadata);
      const coldReaderRoot = path.join(root, "cold-reader");
      const coldBuildDir = path.join(coldReaderRoot, "builds", "build-key");
      fs.mkdirSync(path.dirname(coldBuildDir), { recursive: true });
      fs.cpSync(result.dir, coldBuildDir, { recursive: true });
      fs.writeFileSync(path.join(coldBuildDir, "worker.js"), "tampered");
      setStateRoot(coldReaderRoot);
      await expect(store.get("build-key")).resolves.toBeNull();

      for (const artifactPath of ["", ".", "assets\\chunk.js", "assets//chunk.js"]) {
        await expect(
          store.put(
            `invalid-${artifactPath}`,
            { entries: [{ ...build().artifacts[0]!, path: artifactPath }] },
            { ...build().metadata, buildKey: `invalid-${artifactPath}` }
          )
        ).rejects.toThrow(/artifact path/i);
      }
      await expect(
        store.put(
          "duplicates",
          { entries: [build().artifacts[0]!, build().artifacts[0]!] },
          { ...build().metadata, buildKey: "duplicates" }
        )
      ).rejects.toThrow(/Duplicate build artifact path/);
    } finally {
      await cleanupRoot(root);
    }
  });

  it("defers full payload hashing until artifact content is consumed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    try {
      setStateRoot(root);
      const original = build();
      await store.put(
        "lazy-build",
        { entries: original.artifacts },
        {
          ...original.metadata,
          buildKey: "lazy-build",
        }
      );
      const artifactPath = path.join(root, "builds", "lazy-build", "worker.js");
      const cachedBefore = await store.get("lazy-build");
      expect(
        await store.readStoredArtifactContent(cachedBefore!, cachedBefore!.artifacts[0]!)
      ).toBe("export default {};");
      const bytes = fs.readFileSync(artifactPath, "utf8");
      fs.writeFileSync(artifactPath, "x".repeat(Buffer.byteLength(bytes)));

      const cached = await store.get("lazy-build");
      expect(cached).not.toBeNull();
      const artifact = cached!.artifacts[0]!;
      if (artifact.byteLength === undefined) throw new Error("Fixture artifact has no byte length");
      await expect(
        store.readStoredArtifactContent(cached!, {
          ...artifact,
          byteLength: artifact.byteLength + 1,
        })
      ).rejects.toThrow(/length mismatch/i);
      await expect(store.readStoredArtifactContent(cached!, cached!.artifacts[0]!)).rejects.toThrow(
        /integrity mismatch/i
      );
    } finally {
      await cleanupRoot(root);
    }
  });

  it("rejects unsealed or mismatched workspace build identities", async () => {
    const artifacts = { entries: build().artifacts };
    await expect(
      store.put("other-key", artifacts, { ...build().metadata, buildKey: "build-key" })
    ).rejects.toThrow(/does not match content-addressed store key/);
    await expect(
      store.put("missing-authority", artifacts, {
        ...build().metadata,
        buildKey: "missing-authority",
        sourcePath: "workers/a",
        authority: undefined,
        sourceStateHash: `state:${"c".repeat(64)}`,
      })
    ).rejects.toThrow(/missing sealed authority metadata/);
  });

  it("computes app build integrity from the stored artifact manifest", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    try {
      setStateRoot(root);
      const metadata = {
        ...build().metadata,
        buildKey: "app-build-key",
        kind: "app" as const,
        details: {
          kind: "app" as const,
          target: "react-native" as const,
          integrity: "sha256-provider-supplied",
          rnHostAbi: "rn-host-2",
          provider: null,
        },
      };
      const result = await store.put(
        "app-build-key",
        {
          entries: [
            {
              path: "index.android.bundle",
              role: "primary",
              contentType: "application/javascript; charset=utf-8",
              encoding: "utf8",
              platform: "android",
              content: "android",
            },
            {
              path: "index.ios.bundle",
              role: "primary",
              contentType: "application/javascript; charset=utf-8",
              encoding: "utf8",
              platform: "ios",
              content: "ios",
            },
          ],
        },
        metadata
      );
      const expected = expectedArtifactSetIntegrity(result.artifacts);

      expect(result.metadata.details).toMatchObject({ integrity: expected });
      expect((await store.get("app-build-key"))?.metadata.details).toMatchObject({
        integrity: expected,
      });
    } finally {
      await cleanupRoot(root);
    }
  });

  it("seals a full execution digest from source, build inputs, and exact artifacts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-identity-"));
    const buildKey = "a".repeat(64);
    const workspaceMetadata = {
      ...build().metadata,
      buildKey,
      sourcePath: "workers/a",
      ev: "b".repeat(64),
      sourceStateHash: `state:${"c".repeat(64)}`,
    };
    const storeInRoot = async (dir: string, metadata = workspaceMetadata, content = "one") => {
      setStateRoot(path.join(root, dir));
      return store.put(
        metadata.buildKey,
        {
          entries: [
            {
              path: "worker.js",
              role: "primary" as const,
              contentType: "text/javascript; charset=utf-8",
              encoding: "utf8" as const,
              content,
            },
          ],
        },
        metadata
      );
    };

    try {
      const first = await storeInRoot("first");
      const same = await storeInRoot("same");
      const changedArtifact = await storeInRoot("artifact", workspaceMetadata, "two");
      const changedInputs = await storeInRoot("inputs", {
        ...workspaceMetadata,
        buildKey: "d".repeat(64),
      });
      const changedSource = await storeInRoot("source", {
        ...workspaceMetadata,
        ev: "e".repeat(64),
      });

      expect(first.metadata.execution?.executionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(same.metadata.execution).toEqual(first.metadata.execution);
      expect(changedArtifact.metadata.execution?.executionDigest).not.toBe(
        first.metadata.execution?.executionDigest
      );
      expect(changedInputs.metadata.execution?.executionDigest).not.toBe(
        first.metadata.execution?.executionDigest
      );
      expect(changedSource.metadata.execution?.executionDigest).not.toBe(
        first.metadata.execution?.executionDigest
      );
      expect((await store.get(workspaceMetadata.buildKey))?.metadata.execution).toEqual(
        changedSource.metadata.execution
      );
    } finally {
      await cleanupRoot(root);
    }
  });

  it("rebinds reusable artifact bytes to the exact current source state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-rebind-"));
    const buildKey = "e".repeat(64);
    const firstState = `state:${"1".repeat(64)}`;
    const secondState = `state:${"2".repeat(64)}`;
    try {
      setStateRoot(root);
      setExecutionIdentity({
        serviceAuthorityForSource: async (metadata) =>
          metadata.sourceStateHash === firstState ? "a".repeat(64) : "b".repeat(64),
        workspaceId: "workspace:rebind",
        executionStateForContent: (stateHash) =>
          stateHash === firstState
            ? { kind: "event", eventId: "event:first" }
            : stateHash === secondState
              ? { kind: "event", eventId: "event:second" }
              : null,
      });
      await store.put(
        buildKey,
        { entries: build().artifacts },
        {
          ...build().metadata,
          buildKey,
          sourcePath: "workers/a",
          ev: "f".repeat(64),
          sourceStateHash: firstState,
        }
      );

      const first = (await store.get(buildKey))!;
      const firstExecutionDigest = first.metadata.execution!.executionDigest;
      const rebound = await store.rebindSourceState(first, secondState);

      expect(rebound.sourceStateHash).toBe(secondState);
      expect(first.metadata.serviceAuthorityDigest).toBe("a".repeat(64));
      expect(rebound.metadata.serviceAuthorityDigest).toBe("b".repeat(64));
      expect(
        (await store.getByExecution(buildKey, firstExecutionDigest))?.metadata
          .serviceAuthorityDigest
      ).toBe("a".repeat(64));
      expect(rebound.metadata.sourceState).toEqual({ kind: "event", eventId: "event:second" });
      expect((await store.get(buildKey))?.metadata.execution?.sourceState.state).toEqual({
        kind: "event",
        eventId: "event:second",
      });
      expect(
        (await store.getByExecution(buildKey, rebound.metadata.execution!.executionDigest))
          ?.metadata.execution
      ).toEqual(rebound.metadata.execution);
      const retained = JSON.parse(
        fs.readFileSync(
          path.join(root, "builds", buildKey, "executions", `${firstExecutionDigest}.json`),
          "utf8"
        )
      ) as Record<string, unknown>;
      expect(Object.keys(retained).sort()).toEqual([
        "execution",
        "serviceAuthorityDigest",
        "sourceState",
        "sourceStateHash",
        "version",
      ]);
      expect(retained).not.toHaveProperty("executableModules");
    } finally {
      await cleanupRoot(root);
    }
  });

  it("quarantines for a full epoch, rechecks publication at delete, and retains source after commit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-gc-"));
    const buildKey = "9".repeat(64);
    try {
      setStateRoot(root);
      await store.put(
        buildKey,
        {
          entries: [
            {
              path: "worker.js",
              role: "primary",
              contentType: "text/javascript; charset=utf-8",
              content: "export default {};",
            },
          ],
        },
        {
          ...build().metadata,
          buildKey,
          sourcePath: "workers/a",
          ev: "8".repeat(64),
          sourceStateHash: `state:${"7".repeat(64)}`,
          sourceState: { kind: "event", eventId: "event:gc" },
        }
      );
      const base = {
        mode: "sweep" as const,
        rootedBuildKeys: new Set<string>(),
        publicationProtectedBuildKeys: new Set<string>(),
        graceMs: 0,
        now: 100,
      };

      const first = await store.collectRetention({
        ...base,
        epoch: 1,
        commitArtifactDeletion: (_key, commit) => {
          commit();
          return true;
        },
      });
      expect(first).toMatchObject({ quarantined: 1, deleted: 0 });
      expect(await store.has(buildKey)).toBe(true);
      expect(first.retainedSourceRoots).toEqual([
        { repoPath: "workers/a", stateHash: `state:${"7".repeat(64)}` },
      ]);

      const raced = await store.collectRetention({
        ...base,
        epoch: 2,
        commitArtifactDeletion: () => false,
      });
      expect(raced).toMatchObject({ deleted: 0, retainedForGrace: 1 });
      expect(await store.has(buildKey)).toBe(true);

      const deleted = await store.collectRetention({
        ...base,
        epoch: 3,
        commitArtifactDeletion: (_key, commit) => {
          commit();
          return true;
        },
      });
      expect(deleted.deleted).toBe(1);
      expect(await store.has(buildKey)).toBe(false);
      expect(deleted.retainedSourceRoots).toHaveLength(1);

      const later = await store.collectRetention({ ...base, mode: "quarantine", epoch: 4 });
      expect(later.retainedSourceRoots).toEqual([]);
    } finally {
      await cleanupRoot(root);
    }
  });

  it("rescues a quarantined last-good when an authoritative root reappears", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-gc-rescue-"));
    const buildKey = "6".repeat(64);
    try {
      setStateRoot(root);
      await store.put(
        buildKey,
        {
          entries: [
            {
              path: "worker.js",
              role: "primary",
              contentType: "text/javascript; charset=utf-8",
              content: "export default {};",
            },
          ],
        },
        {
          ...build().metadata,
          buildKey,
          sourcePath: "workers/a",
          ev: "5".repeat(64),
          sourceStateHash: `state:${"4".repeat(64)}`,
          sourceState: { kind: "event", eventId: "event:rescue" },
        }
      );
      const first = await store.collectRetention({
        epoch: 1,
        mode: "quarantine",
        rootedBuildKeys: new Set(),
        publicationProtectedBuildKeys: new Set(),
        graceMs: 0,
      });
      expect(first.quarantined).toBe(1);

      const rescued = await store.collectRetention({
        epoch: 2,
        mode: "sweep",
        rootedBuildKeys: new Set([buildKey]),
        publicationProtectedBuildKeys: new Set(),
        graceMs: 0,
        commitArtifactDeletion: (_key, commit) => {
          commit();
          return true;
        },
      });
      expect(rescued).toMatchObject({ deleted: 0, retainedForGrace: 0 });
      expect(await store.has(buildKey)).toBe(true);
    } finally {
      await cleanupRoot(root);
    }
  });

  it("recovers an atomic deletion rename whose tombstone persistence was interrupted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-gc-recovery-"));
    const buildKey = "3".repeat(64);
    try {
      setStateRoot(root);
      await store.put(
        buildKey,
        {
          entries: [
            {
              path: "worker.js",
              role: "primary",
              contentType: "text/javascript; charset=utf-8",
              content: "export default {};",
            },
          ],
        },
        {
          ...build().metadata,
          buildKey,
          sourcePath: "workers/a",
          ev: "2".repeat(64),
          sourceStateHash: `state:${"1".repeat(64)}`,
          sourceState: { kind: "event", eventId: "event:recovery" },
        }
      );
      await store.collectRetention({
        epoch: 1,
        mode: "quarantine",
        rootedBuildKeys: new Set(),
        publicationProtectedBuildKeys: new Set(),
        graceMs: 0,
      });
      const trashRoot = path.join(root, "execution-retention", "build-trash");
      fs.mkdirSync(trashRoot, { recursive: true });
      fs.renameSync(
        path.join(root, "builds", buildKey),
        path.join(trashRoot, `${buildKey}.2.interrupted`)
      );

      const recovered = await store.collectRetention({
        epoch: 2,
        mode: "sweep",
        rootedBuildKeys: new Set(),
        publicationProtectedBuildKeys: new Set(),
        graceMs: 0,
        commitArtifactDeletion: (_key, commit) => {
          commit();
          return true;
        },
      });
      expect(recovered.notReconstructible).toEqual([]);
      expect(recovered.retainedSourceRoots).toHaveLength(1);
      expect(fs.existsSync(path.join(trashRoot, `${buildKey}.2.interrupted`))).toBe(false);
    } finally {
      await cleanupRoot(root);
    }
  });

  it("keeps report mode read-only even when atomic deletion recovery is pending", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-gc-report-"));
    const buildKey = "2".repeat(64);
    try {
      setStateRoot(root);
      await store.put(
        buildKey,
        { entries: build().artifacts },
        {
          ...build().metadata,
          buildKey,
          sourcePath: "workers/a",
          ev: "3".repeat(64),
          sourceStateHash: `state:${"4".repeat(64)}`,
          sourceState: { kind: "event", eventId: "event:report" },
        }
      );
      await store.collectRetention({
        epoch: 1,
        mode: "quarantine",
        rootedBuildKeys: new Set(),
        publicationProtectedBuildKeys: new Set(),
        graceMs: 0,
      });
      const trashRoot = path.join(root, "execution-retention", "build-trash");
      const trashDir = path.join(trashRoot, `${buildKey}.2.interrupted`);
      fs.mkdirSync(trashRoot, { recursive: true });
      fs.renameSync(path.join(root, "builds", buildKey), trashDir);
      const stateBefore = fs.readFileSync(
        path.join(root, "execution-retention", "build-gc.json"),
        "utf8"
      );

      const report = await store.collectRetention({
        epoch: 2,
        mode: "report",
        rootedBuildKeys: new Set([buildKey]),
        publicationProtectedBuildKeys: new Set(),
        graceMs: 0,
      });

      expect(report.notReconstructible).toEqual([]);
      expect(fs.existsSync(trashDir)).toBe(true);
      expect(fs.existsSync(path.join(root, "builds", buildKey))).toBe(false);
      expect(fs.readFileSync(path.join(root, "execution-retention", "build-gc.json"), "utf8")).toBe(
        stateBefore
      );
    } finally {
      await cleanupRoot(root);
    }
  });

  it("deletes nothing when preflight finds a non-reconstructible artifact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-gc-alarm-"));
    const corruptKey = "4".repeat(64);
    const healthyKey = "5".repeat(64);
    try {
      setStateRoot(root);
      for (const key of [corruptKey, healthyKey]) {
        await store.put(
          key,
          { entries: build().artifacts },
          {
            ...build().metadata,
            buildKey: key,
            sourcePath: `workers/${key}`,
            ev: "6".repeat(64),
            sourceStateHash: `state:${"7".repeat(64)}`,
            sourceState: { kind: "event", eventId: `event:${key}` },
          }
        );
      }
      await store.collectRetention({
        epoch: 1,
        mode: "quarantine",
        rootedBuildKeys: new Set(),
        publicationProtectedBuildKeys: new Set(),
        graceMs: 0,
      });
      fs.rmSync(path.join(root, "builds", corruptKey), { recursive: true });
      let commits = 0;

      const result = await store.collectRetention({
        epoch: 2,
        mode: "sweep",
        rootedBuildKeys: new Set(),
        publicationProtectedBuildKeys: new Set(),
        graceMs: 0,
        commitArtifactDeletion: (_key, commit) => {
          commits += 1;
          commit();
          return true;
        },
      });

      expect(result.notReconstructible).toEqual([
        { buildKey: corruptKey, missing: ["artifact bytes"] },
      ]);
      expect(result.deleted).toBe(0);
      expect(commits).toBe(0);
      expect(await store.has(healthyKey)).toBe(true);
    } finally {
      await cleanupRoot(root);
    }
  });

  it("rejects build directories without an artifact manifest", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    try {
      setStateRoot(root);
      const dir = path.join(root, "builds", "legacy-key");
      fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
      const metadata = {
        ...build().metadata,
        kind: "app" as const,
        details: {
          kind: "app" as const,
          target: "electron" as const,
          integrity: null,
          rnHostAbi: null,
          provider: null,
        },
      };
      fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata));
      fs.writeFileSync(path.join(dir, "bundle.js"), "console.log('legacy');");
      fs.writeFileSync(path.join(dir, "bundle.css"), "body{}");
      fs.writeFileSync(
        path.join(dir, "index.html"),
        '<script type="module" src="./bundle.js"></script>'
      );
      fs.writeFileSync(path.join(dir, "assets", "chunk.js"), "export {};");

      const result = await store.get("legacy-key");

      expect(result).toBeNull();
    } finally {
      await cleanupRoot(root);
    }
  });

  it("treats invalid metadata as a cache miss during direct and shared-style reads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-metadata-validation-"));
    const buildKey = "d".repeat(64);
    try {
      setStateRoot(path.join(root, "producer"));
      const produced = await store.put(
        buildKey,
        { entries: build().artifacts },
        { ...build().metadata, buildKey }
      );

      const corruptRoot = path.join(root, "corrupt-reader");
      const corruptDir = path.join(corruptRoot, "builds", buildKey);
      fs.mkdirSync(path.dirname(corruptDir), { recursive: true });
      fs.cpSync(produced.dir, corruptDir, { recursive: true });
      const metadataPath = path.join(corruptDir, "metadata.json");
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      metadata["details"] = { kind: "generic", unowned: true };
      fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      setStateRoot(corruptRoot);
      await expect(store.get(buildKey)).resolves.toBeNull();
      await expect(store.findSharedStyleBuild("e".repeat(64))).resolves.toBeNull();
    } finally {
      await cleanupRoot(root);
    }
  });

  it("refuses to remove or replace a legacy workspace cache entry online", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-legacy-"));
    const buildKey = "a".repeat(64);
    const metadata = {
      ...build().metadata,
      buildKey,
      sourcePath: "workers/a",
      ev: "b".repeat(64),
      sourceStateHash: `state:${"c".repeat(64)}`,
    };
    try {
      setStateRoot(root);
      const dir = path.join(root, "builds", buildKey);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "worker.js"), "legacy");
      fs.writeFileSync(
        path.join(dir, "artifacts.json"),
        JSON.stringify([
          {
            path: "worker.js",
            role: "primary",
            contentType: "text/javascript; charset=utf-8",
            encoding: "utf8",
            integrity: `sha256-${createHash("sha256").update("legacy").digest("hex")}`,
          },
        ])
      );
      fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata));
      await expect(store.get(buildKey)).resolves.toBeNull();

      await expect(store.put(buildKey, { entries: build().artifacts }, metadata)).rejects.toThrow(
        /stop the server and remove it/
      );
      expect(fs.readFileSync(path.join(dir, "worker.js"), "utf8")).toBe("legacy");
    } finally {
      await cleanupRoot(root);
    }
  });

  it("deduplicates artifact bytes across workspace-local build stores", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    const previousPool = process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"];
    try {
      const pool = path.join(root, "artifact-cas");
      const stateA = path.join(root, "workspaces", "a", "state");
      const stateB = path.join(root, "workspaces", "b", "state");
      process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"] = pool;

      setStateRoot(stateA);
      const buildA = "a".repeat(64);
      const buildB = "b".repeat(64);
      const resultA = await store.put(
        buildA,
        { entries: build().artifacts },
        {
          ...build().metadata,
          buildKey: buildA,
          sourcePath: "workers/a",
          ev: "d".repeat(64),
          sourceStateHash: `state:${"1".repeat(64)}`,
        }
      );
      setStateRoot(stateB);
      const resultB = await store.put(
        buildB,
        { entries: build().artifacts },
        {
          ...build().metadata,
          buildKey: buildB,
          sourcePath: "workers/a",
          ev: "e".repeat(64),
          sourceStateHash: `state:${"2".repeat(64)}`,
        }
      );

      const artifactA = fs.statSync(path.join(resultA.dir, "worker.js"));
      const artifactB = fs.statSync(path.join(resultB.dir, "worker.js"));
      expect(artifactA.ino).toBe(artifactB.ino);
      expect(artifactA.nlink).toBeGreaterThanOrEqual(3);
      expect(resultA.sourceStateHash).toBe(`state:${"1".repeat(64)}`);
      expect(resultB.sourceStateHash).toBe(`state:${"2".repeat(64)}`);
      expect(fs.statSync(path.join(resultA.dir, "metadata.json")).ino).not.toBe(
        fs.statSync(path.join(resultB.dir, "metadata.json")).ino
      );
    } finally {
      if (previousPool === undefined) delete process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"];
      else process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"] = previousPool;
      await cleanupRoot(root);
    }
  });

  it.each(["compact", "inline"])(
    "hydrates %s metadata from a captured record without copying mutable cache files",
    async (format) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-snapshot-"));
      const previousSharedCache = process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
      const sharedCache = path.join(root, "shared");
      process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = sharedCache;
      const key = "snapshot-build";
      const modules = [
        {
          moduleId: "workers/a/index.ts",
          contentDigest: "a".repeat(64),
          package: { kind: "first-party" as const },
          format: "ts" as const,
          source: "export default {};",
        },
      ];
      let linkSpy: import("vitest").MockInstance<typeof fs.promises.link> | undefined;
      try {
        setStateRoot(path.join(root, "producer"));
        await store.put(
          key,
          { entries: build().artifacts },
          {
            ...build().metadata,
            buildKey: key,
            executableModules: modules,
          }
        );
        // Hydration joins this process's background publication, providing a
        // deterministic published-cache boundary before introducing the race.
        setStateRoot(path.join(root, "first-reader"));
        const first = await store.getOrHydrate(key);
        expect(first?.metadata).not.toHaveProperty("executableModules");
        expect(await store.readExecutableModules(first!.dir)).toEqual(modules);
        await store.writeBuildMetadata(first!.dir, first!.metadata);
        expect(await store.readExecutableModules(first!.dir)).toEqual(modules);
        const sharedDir = path.join(sharedCache, key);
        const metadataPath = path.join(sharedDir, "metadata.json");
        if (format === "inline") {
          fs.writeFileSync(
            metadataPath,
            JSON.stringify({ ...first!.metadata, executableModules: modules })
          );
          fs.unlinkSync(path.join(sharedDir, "executable-modules.json.gz"));
        }
        const metadataBefore = fs.readFileSync(metadataPath, "utf8");
        fs.writeFileSync(path.join(sharedDir, "metadata.json.tmp.other-writer"), "in flight");
        const realLink = fs.promises.link;
        linkSpy = vi.spyOn(fs.promises, "link").mockImplementation(async (source, target) => {
          if (String(source) === path.join(sharedDir, "executable-modules.json.gz")) {
            throw Object.assign(new Error("Concurrent metadata replacement"), { code: "ENOENT" });
          }
          return realLink(source, target);
        });
        setStateRoot(path.join(root, "second-reader"));
        const hydrated = await store.getOrHydrate(key);
        expect(hydrated?.metadata).not.toHaveProperty("executableModules");
        expect(await store.readExecutableModules(hydrated!.dir)).toEqual(modules);
        expect(await store.readStoredArtifactContent(hydrated!, hydrated!.artifacts[0]!)).toBe(
          "export default {};"
        );
        expect(fs.existsSync(path.join(hydrated!.dir, "metadata.json.tmp.other-writer"))).toBe(
          false
        );
        expect(
          JSON.parse(fs.readFileSync(path.join(hydrated!.dir, "package.json"), "utf8"))
        ).toEqual({ type: "module" });
        expect(fs.readFileSync(metadataPath, "utf8")).toBe(metadataBefore);
        if (format === "inline") {
          await store.writeBuildMetadata(sharedDir, first!.metadata);
          expect(await store.readExecutableModules(sharedDir)).toEqual(modules);
        }
      } finally {
        linkSpy?.mockRestore();
        if (previousSharedCache === undefined)
          delete process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
        else process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = previousSharedCache;
        await cleanupRoot(root);
      }
    }
  );

  it("reuses artifact bytes without changing either workspace's persisted execution identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    const previousSharedCache = process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
    const previousSharedDerived = process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
    const previousInstanceRoot = process.env["VIBESTUDIO_INSTANCE_ROOT"];
    try {
      const sharedDerived = path.join(root, "profile-derived");
      const sharedCache = path.join(sharedDerived, "build-results");
      const instanceA = path.join(root, "instance-a");
      const instanceB = path.join(root, "instance-b");
      const stateA = path.join(instanceA, "workspaces", "a", "state");
      const stateB = path.join(instanceB, "workspaces", "b", "state");
      delete process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
      process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = sharedDerived;
      process.env["VIBESTUDIO_INSTANCE_ROOT"] = instanceA;

      setStateRoot(stateA);
      const buildKey = "a".repeat(64);
      const original = await store.put(
        buildKey,
        { entries: build().artifacts },
        {
          ...build().metadata,
          buildKey,
          sourcePath: "workers/a",
          ev: "d".repeat(64),
          sourceStateHash: `state:${"1".repeat(64)}`,
        }
      );
      expect(original.dir).toBe(path.join(stateA, "builds", buildKey));

      setStateRoot(stateB);
      process.env["VIBESTUDIO_INSTANCE_ROOT"] = instanceB;
      setExecutionIdentity({
        serviceAuthorityForSource: async () => "c".repeat(64),
        workspaceId: "workspace:b",
        executionStateForContent: (stateHash) =>
          stateHash === `state:${"2".repeat(64)}`
            ? { kind: "event", eventId: "event:workspace-b" }
            : null,
      });
      expect(await store.has(buildKey)).toBe(false);
      const reused = await store.getOrHydrate(buildKey, `state:${"2".repeat(64)}`);
      expect(await store.has(buildKey)).toBe(true);

      expect(reused).toMatchObject({
        dir: path.join(stateB, "builds", buildKey),
        sourceStateHash: `state:${"2".repeat(64)}`,
      });
      expect(reused?.metadata.serviceAuthorityDigest).toBe("c".repeat(64));
      expect(reused?.metadata.serviceAuthorityDigest).not.toBe(
        original.metadata.serviceAuthorityDigest
      );
      expect(reused?.metadata.sourceState).toEqual({
        kind: "event",
        eventId: "event:workspace-b",
      });
      expect(reused?.metadata.execution?.sourceState.state).toEqual({
        kind: "event",
        eventId: "event:workspace-b",
      });
      expect(await store.readStoredArtifactContent(reused!, reused!.artifacts[0]!)).toBe(
        "export default {};"
      );
      expect(fs.existsSync(path.join(stateB, "builds", "same-build-key"))).toBe(false);

      // A fresh lookup of A must still reproduce its sealed execution after B
      // hydrates the shared bytes. Read a copied workspace record under a new
      // state root to exercise the disk verification used after a restart.
      const stateAReader = path.join(instanceA, "workspaces", "a-reader", "state");
      const stateAReaderBuild = path.join(stateAReader, "builds", buildKey);
      fs.mkdirSync(path.dirname(stateAReaderBuild), { recursive: true });
      fs.cpSync(original.dir, stateAReaderBuild, { recursive: true });
      setStateRoot(stateAReader);
      process.env["VIBESTUDIO_INSTANCE_ROOT"] = instanceA;
      setExecutionIdentity({
        serviceAuthorityForSource: async () =>
          "b7e01c5f5a5351d9b1e459b5fc9e3c36920637eac75afd9ad271b3a0d8736e06",
        workspaceId: "workspace:test",
        executionStateForContent: (stateHash) => ({
          kind: "event",
          eventId: `event:${stateHash}`,
        }),
      });
      expect(
        (await store.getByExecution(buildKey, original.metadata.execution!.executionDigest))
          ?.metadata.execution
      ).toEqual(original.metadata.execution);
      for (const metadataDir of [original.dir, path.join(sharedCache, buildKey)]) {
        expect(
          JSON.parse(fs.readFileSync(path.join(metadataDir, "metadata.json"), "utf8"))
        ).toEqual(original.metadata);
      }
      if (process.platform !== "win32") {
        const metadataInodes = [original.dir, path.join(sharedCache, buildKey), reused!.dir].map(
          (dir) => fs.statSync(path.join(dir, "metadata.json")).ino
        );
        expect(new Set(metadataInodes).size).toBe(3);
        expect(fs.statSync(path.join(original.dir, "worker.js")).ino).toBe(
          fs.statSync(path.join(reused!.dir, "worker.js")).ino
        );
      }
    } finally {
      if (previousSharedCache === undefined) {
        delete process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
      } else {
        process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = previousSharedCache;
      }
      if (previousSharedDerived === undefined) {
        delete process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
      } else {
        process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = previousSharedDerived;
      }
      if (previousInstanceRoot === undefined) {
        delete process.env["VIBESTUDIO_INSTANCE_ROOT"];
      } else {
        process.env["VIBESTUDIO_INSTANCE_ROOT"] = previousInstanceRoot;
      }
      await cleanupRoot(root);
    }
  });

  it.each(["valid", "corrupt"] as const)(
    "accepts a validated %s shared-build winner after a rename collision",
    async (winnerKind) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-shared-publish-winner-"));
      const previousSharedCache = process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
      const sharedCache = path.join(root, "shared");
      process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = sharedCache;
      const key = `${winnerKind}-${"a".repeat(60)}`;
      setStateRoot(path.join(root, "producer"));
      const winnerError = Object.assign(new Error("rename winner already published"), {
        code: "EPERM",
      });
      const realRename = fs.promises.rename;
      let renameSpy: import("vitest").MockInstance<typeof fs.promises.rename> | undefined;
      try {
        const sharedDir = path.join(sharedCache, key);
        renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
          if (String(to) !== sharedDir) return realRename(from, to);
          fs.cpSync(String(from), sharedDir, { recursive: true, errorOnExist: true });
          if (winnerKind === "corrupt") {
            fs.writeFileSync(path.join(sharedDir, "worker.js"), "export default [];");
          }
          throw winnerError;
        });

        let source: BuildResult | undefined;
        if (winnerKind === "valid") {
          source = await store.put(
            key,
            { entries: build().artifacts },
            { ...build().metadata, buildKey: key }
          );
          setStateRoot(path.join(root, "consumer"));
          const hydrated = await store.getOrHydrate(key);
          expect(await store.readStoredArtifactContent(hydrated!, hydrated!.artifacts[0]!)).toBe(
            "export default {};"
          );
          expect(fs.existsSync(path.join(sharedDir, "metadata.json"))).toBe(true);
        } else {
          let publicationFailure: unknown;
          try {
            await store.put(
              key,
              { entries: build().artifacts },
              { ...build().metadata, buildKey: key }
            );
          } catch (error) {
            publicationFailure = error;
          }
          expect(publicationFailure).toSatisfy((error: unknown) => {
            if (!(error instanceof AggregateError)) return false;
            const failures = [...error.errors];
            return (
              failures.includes(winnerError) &&
              failures.some(
                (failure) => failure instanceof Error && /integrity/i.test(failure.message)
              )
            );
          });
          expect(await store.readLocal(key)).not.toBeNull();
          await expect(owner.drain()).resolves.toBeUndefined();
        }
        if (source) expect(source.buildKey).toBe(key);
      } finally {
        renameSpy?.mockRestore();
        if (previousSharedCache === undefined)
          delete process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
        else process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = previousSharedCache;
        await cleanupRoot(root);
      }
    }
  );

  it("preserves shared-build rename and cleanup failures together", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-shared-publish-cleanup-"));
    const previousSharedCache = process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
    const sharedCache = path.join(root, "shared");
    process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = sharedCache;
    const key = `cleanup-${"b".repeat(58)}`;
    setStateRoot(path.join(root, "producer"));
    const renameError = Object.assign(new Error("directory rename denied"), { code: "EPERM" });
    const cleanupError = new Error("temporary publication cleanup denied");
    const realRename = fs.promises.rename;
    const realRm = fs.promises.rm;
    let renameSpy: import("vitest").MockInstance<typeof fs.promises.rename> | undefined;
    let rmSpy: import("vitest").MockInstance<typeof fs.promises.rm> | undefined;
    try {
      const sharedDir = path.join(sharedCache, key);
      let tempPath: string | undefined;
      renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (String(to) !== sharedDir) return realRename(from, to);
        tempPath = String(from);
        fs.cpSync(tempPath, sharedDir, { recursive: true, errorOnExist: true });
        throw renameError;
      });
      rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
        if (String(target) === tempPath) throw cleanupError;
        return realRm(target, options);
      });

      let failure: unknown;
      try {
        await store.put(
          key,
          { entries: build().artifacts },
          { ...build().metadata, buildKey: key }
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      const failures: unknown[] = [];
      const collect = (error: unknown): void => {
        if (error instanceof AggregateError) {
          for (const member of error.errors) collect(member);
        } else {
          failures.push(error);
        }
      };
      collect(failure);
      expect(failures).toContain(renameError);
      expect(failures).toContain(cleanupError);
      expect(await store.readLocal(key)).not.toBeNull();
      await expect(owner.drain()).resolves.toBeUndefined();
    } finally {
      rmSpy?.mockRestore();
      renameSpy?.mockRestore();
      if (previousSharedCache === undefined)
        delete process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
      else process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = previousSharedCache;
      await cleanupRoot(root);
    }
  });

  it("drains independent shared-build publication failures as one complete graph", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-shared-publish-drain-"));
    const previousSharedCache = process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
    process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = path.join(root, "shared");
    setStateRoot(path.join(root, "producer"));
    const failures = [
      new Error("first publication failure"),
      new Error("second publication failure"),
    ];
    let releasePublications: (() => void) | undefined;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublications = resolve;
    });
    let enteredRenames = 0;
    let releaseRenameAdmission: (() => void) | undefined;
    const bothRenamesEntered = new Promise<void>((resolve) => {
      releaseRenameAdmission = resolve;
    });
    const realRename = fs.promises.rename;
    let renameSpy: import("vitest").MockInstance<typeof fs.promises.rename> | undefined;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (path.dirname(String(to)) === process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"]) {
          const index = path.basename(String(to)).endsWith("1") ? 0 : 1;
          enteredRenames += 1;
          if (enteredRenames === 2) releaseRenameAdmission?.();
          await publicationGate;
          throw failures[index];
        }
        return realRename(from, to);
      });
      const writes = ["1", "2"].map((suffix) => {
        const key = `${"c".repeat(62)}${suffix}`;
        return store.put(
          key,
          { entries: build().artifacts },
          { ...build().metadata, buildKey: key }
        );
      });
      await bothRenamesEntered;
      releasePublications?.();
      const outcomes = await Promise.allSettled(writes);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      for (const [index, outcome] of outcomes.entries()) {
        expect(outcome).toMatchObject({ status: "rejected", reason: failures[index] });
      }
      await expect(owner.drain()).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      renameSpy?.mockRestore();
      if (previousSharedCache === undefined)
        delete process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
      else process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = previousSharedCache;
      await cleanupRoot(root);
    }
  });

  it("shares an operation failure with every admitted caller without retaining history", async () => {
    const failure = new Error("shared publication failed");
    let releaseWork: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let executions = 0;
    const work = async (): Promise<void> => {
      executions += 1;
      await gate;
      throw failure;
    };

    const first = owner.admit("shared-operation", work);
    const second = owner.admit("shared-operation", work);
    expect(second).toBe(first);
    releaseWork?.();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(executions).toBe(1);

    let successfulExecutions = 0;
    await owner.admit("completed-operation", async () => {
      successfulExecutions += 1;
    });
    await owner.admit("completed-operation", async () => {
      successfulExecutions += 1;
    });
    expect(successfulExecutions).toBe(2);
    await expect(owner.drain()).resolves.toBeUndefined();
  });

  it("reports an unclaimed operation failure when process drain joins it", async () => {
    const failure = new Error("unclaimed process operation failed");
    const processOwner = createBuildStoreProcessOwner();
    let releaseWork: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const operation = processOwner.admit("unclaimed-operation", async () => {
      await gate;
      throw failure;
    });
    void operation.catch(() => undefined);

    const drain = processOwner.drain();
    releaseWork?.();
    await expect(drain).rejects.toBe(failure);
  });
});
