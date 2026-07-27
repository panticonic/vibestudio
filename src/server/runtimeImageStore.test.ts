import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import type { Sha256 } from "@vibestudio/shared/execution/identity";
import { RuntimeImageStore } from "./runtimeImageStore.js";
import { stateLayout } from "./stateLayout.js";

function artifact(buildKey = "b".repeat(64)): ExecutionArtifactRefV1 {
  const contentRoots = [{ repoPath: "workers/a", stateHash: `state:${"a".repeat(64)}` }];
  const unsigned = {
    version: 1 as const,
    sourceState: {
      kind: "workspace" as const,
      workspaceId: "workspace:test",
      effectiveVersion: "d".repeat(64) as Sha256,
      state: { kind: "event" as const, eventId: "event:test" },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: "e".repeat(64) as Sha256,
    buildKey: buildKey as Sha256,
    artifactDigest: "f".repeat(64) as Sha256,
  };
  return verifyExecutionArtifactRef({
    ...unsigned,
    executionDigest: executionArtifactDigest(unsigned),
  });
}

describe("RuntimeImageStore sealed execution identity", () => {
  it("does not persist a runtime image when exact execution reservation fails", () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-images-"));
    try {
      const store = new RuntimeImageStore(statePath, {
        reserve() {
          throw new Error("execution identity mismatch");
        },
        finalize() {},
      });
      expect(() =>
        store.upsert({
          id: "worker:workers/a:one",
          source: "workers/a",
          unitName: "@workspace-workers/a",
          artifact: artifact(),
          authorityRequests: [],
        })
      ).toThrow(/identity mismatch/);
      expect(store.list()).toEqual([]);
    } finally {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });

  it("persists full execution digests and reloads the versioned cache", () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-images-"));
    try {
      const store = new RuntimeImageStore(statePath);
      store.upsert({
        id: "worker:workers/a:one",
        source: "workers/a",
        unitName: "@workspace-workers/a",
        artifact: artifact(),
        authorityRequests: [
          {
            capability: "service:workspace-state.alarmClear",
            resource: { kind: "exact", key: "workspace:test" },
            tier: "gated",
            evidence: "exact",
          },
        ],
      });

      expect(new RuntimeImageStore(statePath).get("worker:workers/a:one")).toMatchObject({
        artifact: expect.objectContaining({ executionDigest: artifact().executionDigest }),
        authorityRequests: [
          {
            capability: "service:workspace-state.alarmClear",
            resource: { kind: "exact", key: "workspace:test" },
            tier: "gated",
            evidence: "exact",
          },
        ],
      });
    } finally {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });

  it("fails closed on an unknown schema instead of treating it as an empty store", () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-images-"));
    try {
      const filePath = stateLayout(statePath).runtimeImagesFile;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          records: [
            {
              id: "worker:workers/a:one",
              source: "workers/a",
              unitName: "@workspace-workers/a",
              stateHash: "state:legacy",
              buildKey: "legacy-short-key",
              effectiveVersion: "legacy-short-ev",
              generation: 1,
              updatedAt: 1,
            },
          ],
        })
      );

      expect(() => new RuntimeImageStore(statePath)).toThrow(
        /schema version 1 predates the supported production baseline/
      );
    } finally {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });

  it("rejects the previous authority-envelope epoch without a legacy migration", () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-images-"));
    try {
      const filePath = stateLayout(statePath).runtimeImagesFile;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 3,
          records: [
            {
              id: "worker:workers/a:one",
              source: "workers/a",
              unitName: "@workspace-workers/a",
              stateHash: `state:${"a".repeat(64)}`,
              buildKey: "b".repeat(64),
              executionDigest: "c".repeat(64),
              authorityRequests: [
                {
                  capability: "workspace.files.read",
                  resource: { kind: "exact", key: "workspace:test" },
                  tier: "gated",
                  evidence: "exact",
                },
              ],
              authorityDelegations: [
                {
                  audience: "eval",
                  purpose: "agentic-code-execution",
                  capabilities: [],
                },
              ],
              effectiveVersion: "d".repeat(64),
              generation: 1,
              updatedAt: 1,
            },
          ],
        })
      );

      expect(() => new RuntimeImageStore(statePath)).toThrow(
        /predates the supported production baseline/
      );
    } finally {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed current-schema records", () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-images-"));
    try {
      const filePath = stateLayout(statePath).runtimeImagesFile;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 6,
          records: [
            {
              id: "worker:workers/a:one",
              source: "workers/a",
              unitName: "@workspace-workers/a",
              artifact: { ...artifact(), executionDigest: "not-a-digest" },
              authorityRequests: [],
              generation: 1,
              updatedAt: 1,
            },
          ],
        })
      );

      expect(() => new RuntimeImageStore(statePath)).toThrow(/record 0 has invalid artifact/);
    } finally {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });

  it("surfaces corrupt JSON instead of silently clearing sealed identities", () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-images-"));
    try {
      const filePath = stateLayout(statePath).runtimeImagesFile;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "{not-json");
      expect(() => new RuntimeImageStore(statePath)).toThrow(/JSON/);
    } finally {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });
});
