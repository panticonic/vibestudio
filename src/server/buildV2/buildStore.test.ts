import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";

import {
  artifactFilePath,
  collectRetention,
  dedupeBuildArtifacts,
  get,
  has,
  primaryArtifact,
  primaryArtifactFilePath,
  primaryTextArtifactContent,
  put,
  scanRetention,
  setBuildExecutionIdentityContext,
  type BuildResult,
} from "./buildStore.js";

beforeEach(() => {
  setBuildExecutionIdentityContext({
    workspaceId: "workspace:test",
    semanticStateForContent: (stateHash) => ({
      kind: "event",
      eventId: `event:${stateHash}`,
    }),
  });
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
      authority: { requests: [] },
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
  it("reports stored bytes without removing an unreferenced build", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-retention-"));
    try {
      setUserDataPath(root);
      const buildDir = path.join(root, "builds", "unreferenced");
      fs.mkdirSync(path.join(buildDir, "nested"), { recursive: true });
      fs.writeFileSync(path.join(buildDir, "metadata.json"), "meta");
      fs.writeFileSync(path.join(buildDir, "nested", "bundle.js"), "bundle");

      await expect(scanRetention()).resolves.toEqual({
        builds: [{ key: "unreferenced", bytes: 10 }],
        failures: [],
      });
      expect(fs.readFileSync(path.join(buildDir, "nested", "bundle.js"), "utf8")).toBe("bundle");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the manifest primary artifact content", () => {
    const result = build();

    expect(primaryArtifact(result)).toMatchObject({ path: "worker.js" });
    expect(primaryTextArtifactContent(result)).toBe("export default {};");
    expect(primaryArtifactFilePath(result)).toBe("/tmp/build/worker.js");
  });

  it("fails closed when a text primary artifact is unavailable", () => {
    expect(() => primaryTextArtifactContent(build({ artifacts: [] }))).toThrow(
      /no primary artifact/
    );
    expect(() =>
      primaryTextArtifactContent(
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
    ).toThrow(/not UTF-8 text/);
  });

  it("rejects unsafe artifact paths when deriving file paths", () => {
    expect(() => artifactFilePath(build(), { path: "../worker.js" })).toThrow(
      /Invalid build artifact path/
    );
    expect(() => artifactFilePath(build(), { path: "/tmp/worker.js" })).toThrow(
      /Invalid build artifact path/
    );
  });

  it("computes artifact integrity from stored bytes instead of trusting caller input", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    try {
      setUserDataPath(root);
      const metadata = build().metadata;
      const result = put(
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
      expect(get("build-key")?.artifacts[0]).toMatchObject({ integrity: expected });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects tampered cached bytes and ambiguous artifact paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    try {
      setUserDataPath(root);
      const result = put("build-key", { entries: build().artifacts }, build().metadata);
      fs.writeFileSync(path.join(result.dir, "worker.js"), "tampered");
      expect(get("build-key")).toBeNull();

      for (const artifactPath of ["", ".", "assets\\chunk.js", "assets//chunk.js"]) {
        expect(() =>
          put(
            `invalid-${artifactPath}`,
            { entries: [{ ...build().artifacts[0]!, path: artifactPath }] },
            { ...build().metadata, buildKey: `invalid-${artifactPath}` }
          )
        ).toThrow(/artifact path/i);
      }
      expect(() =>
        put(
          "duplicates",
          { entries: [build().artifacts[0]!, build().artifacts[0]!] },
          { ...build().metadata, buildKey: "duplicates" }
        )
      ).toThrow(/Duplicate build artifact path/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("defers full payload hashing until artifact content is consumed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    try {
      setUserDataPath(root);
      const original = build();
      put(
        "lazy-build",
        { entries: original.artifacts },
        {
          ...original.metadata,
          buildKey: "lazy-build",
        }
      );
      const artifactPath = path.join(root, "builds", "lazy-build", "worker.js");
      const bytes = fs.readFileSync(artifactPath, "utf8");
      fs.writeFileSync(artifactPath, "x".repeat(Buffer.byteLength(bytes)));

      const cached = get("lazy-build");
      expect(cached).not.toBeNull();
      expect(() => cached?.artifacts[0]?.content).toThrow(/integrity mismatch/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsealed or mismatched workspace build identities", () => {
    const artifacts = { entries: build().artifacts };
    expect(() =>
      put("other-key", artifacts, { ...build().metadata, buildKey: "build-key" })
    ).toThrow(/does not match content-addressed store key/);
    expect(() =>
      put("missing-authority", artifacts, {
        ...build().metadata,
        buildKey: "missing-authority",
        sourcePath: "workers/a",
        authority: undefined,
        sourceStateHash: `state:${"c".repeat(64)}`,
      })
    ).toThrow(/missing sealed authority metadata/);
  });

  it("computes app build integrity from the stored artifact manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    try {
      setUserDataPath(root);
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
      const result = put(
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
      expect(get("app-build-key")?.metadata.details).toMatchObject({ integrity: expected });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("seals a full execution digest from source, build inputs, and exact artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-identity-"));
    const buildKey = "a".repeat(64);
    const workspaceMetadata = {
      ...build().metadata,
      buildKey,
      sourcePath: "workers/a",
      ev: "b".repeat(64),
      sourceStateHash: `state:${"c".repeat(64)}`,
    };
    const store = (dir: string, metadata = workspaceMetadata, content = "one") => {
      setUserDataPath(path.join(root, dir));
      return put(
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
      const first = store("first");
      const same = store("same");
      const changedArtifact = store("artifact", workspaceMetadata, "two");
      const changedInputs = store("inputs", { ...workspaceMetadata, buildKey: "d".repeat(64) });
      const changedSource = store("source", { ...workspaceMetadata, ev: "e".repeat(64) });

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
      expect(get(workspaceMetadata.buildKey)?.metadata.execution).toEqual(
        changedSource.metadata.execution
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("quarantines for a full epoch, rechecks publication at delete, and retains source after commit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-gc-"));
    const buildKey = "9".repeat(64);
    try {
      setUserDataPath(root);
      put(
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
          sourceSemanticState: { kind: "event", eventId: "event:gc" },
        }
      );
      const base = {
        mode: "sweep" as const,
        rootedBuildKeys: new Set<string>(),
        publicationProtectedBuildKeys: new Set<string>(),
        graceMs: 0,
        now: 100,
      };

      const first = await collectRetention({
        ...base,
        epoch: 1,
        commitArtifactDeletion: (_key, commit) => {
          commit();
          return true;
        },
      });
      expect(first).toMatchObject({ quarantined: 1, deleted: 0 });
      expect(has(buildKey)).toBe(true);
      expect(first.retainedSourceRoots).toEqual([
        { repoPath: "workers/a", stateHash: `state:${"7".repeat(64)}` },
      ]);

      const raced = await collectRetention({
        ...base,
        epoch: 2,
        commitArtifactDeletion: () => false,
      });
      expect(raced).toMatchObject({ deleted: 0, retainedForGrace: 1 });
      expect(has(buildKey)).toBe(true);

      const deleted = await collectRetention({
        ...base,
        epoch: 3,
        commitArtifactDeletion: (_key, commit) => {
          commit();
          return true;
        },
      });
      expect(deleted.deleted).toBe(1);
      expect(has(buildKey)).toBe(false);
      expect(deleted.retainedSourceRoots).toHaveLength(1);

      const later = await collectRetention({ ...base, mode: "quarantine", epoch: 4 });
      expect(later.retainedSourceRoots).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rescues a quarantined last-good when an authoritative root reappears", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-gc-rescue-"));
    const buildKey = "6".repeat(64);
    try {
      setUserDataPath(root);
      put(
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
          sourceSemanticState: { kind: "event", eventId: "event:rescue" },
        }
      );
      const first = await collectRetention({
        epoch: 1,
        mode: "quarantine",
        rootedBuildKeys: new Set(),
        publicationProtectedBuildKeys: new Set(),
        graceMs: 0,
      });
      expect(first.quarantined).toBe(1);

      const rescued = await collectRetention({
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
      expect(has(buildKey)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers an atomic deletion rename whose tombstone persistence was interrupted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-gc-recovery-"));
    const buildKey = "3".repeat(64);
    try {
      setUserDataPath(root);
      put(
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
          sourceSemanticState: { kind: "event", eventId: "event:recovery" },
        }
      );
      await collectRetention({
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

      const recovered = await collectRetention({
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
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps report mode read-only even when atomic deletion recovery is pending", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-gc-report-"));
    const buildKey = "2".repeat(64);
    try {
      setUserDataPath(root);
      put(
        buildKey,
        { entries: build().artifacts },
        {
          ...build().metadata,
          buildKey,
          sourcePath: "workers/a",
          ev: "3".repeat(64),
          sourceStateHash: `state:${"4".repeat(64)}`,
          sourceSemanticState: { kind: "event", eventId: "event:report" },
        }
      );
      await collectRetention({
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

      const report = await collectRetention({
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
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes nothing when preflight finds a non-reconstructible artifact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-gc-alarm-"));
    const corruptKey = "4".repeat(64);
    const healthyKey = "5".repeat(64);
    try {
      setUserDataPath(root);
      for (const key of [corruptKey, healthyKey]) {
        put(
          key,
          { entries: build().artifacts },
          {
            ...build().metadata,
            buildKey: key,
            sourcePath: `workers/${key}`,
            ev: "6".repeat(64),
            sourceStateHash: `state:${"7".repeat(64)}`,
            sourceSemanticState: { kind: "event", eventId: `event:${key}` },
          }
        );
      }
      await collectRetention({
        epoch: 1,
        mode: "quarantine",
        rootedBuildKeys: new Set(),
        publicationProtectedBuildKeys: new Set(),
        graceMs: 0,
      });
      fs.rmSync(path.join(root, "builds", corruptKey), { recursive: true });
      let commits = 0;

      const result = await collectRetention({
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
      expect(has(healthyKey)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects build directories without an artifact manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    try {
      setUserDataPath(root);
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

      const result = get("legacy-key");

      expect(result).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to remove or replace a legacy workspace cache entry online", () => {
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
      setUserDataPath(root);
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
      expect(get(buildKey)).toBeNull();

      expect(() => put(buildKey, { entries: build().artifacts }, metadata)).toThrow(
        /stop the server and remove it/
      );
      expect(fs.readFileSync(path.join(dir, "worker.js"), "utf8")).toBe("legacy");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates artifact bytes across workspace-local build stores", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    const previousPool = process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"];
    try {
      const pool = path.join(root, "artifact-cas");
      const stateA = path.join(root, "workspaces", "a", "state");
      const stateB = path.join(root, "workspaces", "b", "state");
      process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"] = pool;

      setUserDataPath(stateA);
      const buildA = "a".repeat(64);
      const buildB = "b".repeat(64);
      const resultA = put(
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
      setUserDataPath(stateB);
      const resultB = put(
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
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses complete immutable builds across workspace stores", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    const previousSharedCache = process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
    try {
      const sharedCache = path.join(root, "shared-builds");
      const stateA = path.join(root, "workspaces", "a", "state");
      const stateB = path.join(root, "workspaces", "b", "state");
      process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = sharedCache;

      setUserDataPath(stateA);
      const buildKey = "a".repeat(64);
      const original = put(
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

      setUserDataPath(stateB);
      expect(has(buildKey)).toBe(true);
      const reused = get(buildKey);

      expect(reused).toMatchObject({
        dir: path.join(stateB, "builds", buildKey),
        sourceStateHash: `state:${"1".repeat(64)}`,
      });
      expect(reused?.artifacts[0]?.content).toBe("export default {};");
      expect(fs.existsSync(path.join(stateB, "builds", "same-build-key"))).toBe(false);
    } finally {
      if (previousSharedCache === undefined) {
        delete process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
      } else {
        process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = previousSharedCache;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates existing independent artifacts into the shared CAS", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-store-"));
    const previousPool = process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"];
    try {
      delete process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"];
      const stateA = path.join(root, "a");
      const stateB = path.join(root, "b");
      setUserDataPath(stateA);
      const resultA = put(
        "build-a",
        { entries: build().artifacts },
        {
          ...build().metadata,
          buildKey: "build-a",
        }
      );
      setUserDataPath(stateB);
      const resultB = put(
        "build-b",
        { entries: build().artifacts },
        {
          ...build().metadata,
          buildKey: "build-b",
        }
      );
      const fileA = path.join(resultA.dir, "worker.js");
      const fileB = path.join(resultB.dir, "worker.js");
      expect(fs.statSync(fileA).ino).not.toBe(fs.statSync(fileB).ino);

      const pool = path.join(root, "artifact-cas");
      const first = dedupeBuildArtifacts(path.join(stateA, "builds"), pool);
      const second = dedupeBuildArtifacts(path.join(stateB, "builds"), pool);

      expect(first.alreadyShared).toBe(1);
      expect(second.linked).toBe(1);
      expect(fs.statSync(fileA).ino).toBe(fs.statSync(fileB).ino);
    } finally {
      if (previousPool === undefined) delete process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"];
      else process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"] = previousPool;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
