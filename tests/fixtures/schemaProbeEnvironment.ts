import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { beforeEach, afterEach, vi } from "vitest";
import { closeDerivedCacheCoordinators } from "@vibestudio/shared/derivedCache";
import type { WorkspaceReleaseIdentity } from "../../src/server/preparedWorkspaceRelease.js";

/** A test publisher seals the exact injected program fixture, rather than
 * borrowing a developer installation or disabling evidence admission. */
export function schemaProbeEnvironmentForFixture(programs: unknown): WorkspaceReleaseIdentity {
  const hash = (input: string) => createHash("sha256").update(input).digest("hex");
  return {
    hostBuild: {
      version: 1,
      mode: "development",
      fingerprint: hash(JSON.stringify(programs)),
      inputCount: 1,
    },
    appDependencyFingerprint: hash("owned-test-dependency-realm"),
    compilerProtocol: {
      cacheVersion: "owned-test-compiler",
      panelEntryProtocolFingerprint: hash("owned-test-panel-protocol"),
    },
  };
}

/** Cache persistence tests own their disk-pressure condition, independently of the developer disk. */
export function mockSchemaProbeDiskSpace(root: string): () => void {
  const statfs = fsSync.statfsSync.bind(fsSync);
  const spy = vi.spyOn(fsSync, "statfsSync").mockImplementation(((file: fsSync.PathLike, options?: unknown) => {
    const value = statfs(file, options as never);
    if (!path.resolve(String(file)).startsWith(path.resolve(root) + path.sep)) return value;
    return { ...value, bavail: typeof value.bavail === "bigint" ? 2n ** 40n : 2 ** 40 };
  }) as typeof fsSync.statfsSync);
  syncBuiltinESMExports();
  return () => { spy.mockRestore(); syncBuiltinESMExports(); };
}

export function useSchemaProbeFixtureCache(): void {
  let root: string;
  let restoreDisk: (() => void) | undefined;
  beforeEach(async () => {
    await fs.mkdir(path.resolve(".cache"), { recursive: true });
    root = await fs.mkdtemp(path.resolve(".cache/schema-probe-test-"));
    vi.stubEnv("VIBESTUDIO_SHARED_DERIVED_CACHE_DIR", root);
    restoreDisk = mockSchemaProbeDiskSpace(root);
  });
  afterEach(async () => {
    await closeDerivedCacheCoordinators();
    restoreDisk?.();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
}
