import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { BuildResult, StoredBuildResult } from "../../src/server/buildV2/buildStore.js";

const roots = new Set<string>();
const storedBuilds = new WeakMap<BuildResult, StoredBuildResult>();

/** Materialize wire fixture bytes so host tests exercise the real stored-file reader. */
export function storedBuildFixture(build: BuildResult): StoredBuildResult {
  const existing = storedBuilds.get(build);
  if (existing) return existing;

  const root = mkdtempSync(resolve(tmpdir(), "vibestudio-stored-build-fixture-"));
  roots.add(root);
  const dir = resolve(root, "builds", build.buildKey);
  const buildRelativePath = relative(root, dir);
  if (
    buildRelativePath === ".." ||
    buildRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(buildRelativePath)
  ) {
    throw new Error(`Unsafe stored build fixture key: ${build.buildKey}`);
  }
  mkdirSync(dir, { recursive: true });
  const artifacts = build.artifacts.map((artifact) => {
    const target = resolve(dir, artifact.path);
    const rel = relative(dir, target);
    if (rel.startsWith("..") || resolve(target) === resolve(dir)) {
      throw new Error(`Unsafe stored build fixture artifact path: ${artifact.path}`);
    }
    const bytes = Buffer.isBuffer(artifact.content)
      ? artifact.content
      : Buffer.from(artifact.content, artifact.encoding === "base64" ? "base64" : "utf8");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      path: artifact.path,
      role: artifact.role,
      contentType: artifact.contentType,
      encoding: artifact.encoding ?? "utf8",
      byteLength: bytes.byteLength,
      integrity: `sha256-${digest}`,
    };
  });
  const stored: StoredBuildResult = {
    dir,
    buildKey: build.buildKey,
    sourceStateHash: build.sourceStateHash,
    metadata: build.metadata,
    artifacts,
  };
  storedBuilds.set(build, stored);
  return stored;
}

export function cleanupStoredBuildFixtures(): void {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots.clear();
}
