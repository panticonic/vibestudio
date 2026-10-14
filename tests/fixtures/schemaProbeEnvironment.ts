import { createHash } from "node:crypto";
import fs from "node:fs/promises";
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

export function useSchemaProbeFixtureCache(): void {
  let root: string;
  beforeEach(async () => {
    await fs.mkdir(path.resolve(".cache"), { recursive: true });
    root = await fs.mkdtemp(path.resolve(".cache/schema-probe-test-"));
    vi.stubEnv("VIBESTUDIO_SHARED_DERIVED_CACHE_DIR", root);
  });
  afterEach(async () => {
    await closeDerivedCacheCoordinators();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
}
