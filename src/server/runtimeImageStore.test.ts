import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeImageStore } from "./runtimeImageStore.js";
import { stateLayout } from "./stateLayout.js";

describe("RuntimeImageStore sealed execution identity", () => {
  it("persists full execution digests and reloads the versioned cache", () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-images-"));
    try {
      const store = new RuntimeImageStore(statePath);
      store.upsert({
        id: "worker:workers/a:one",
        source: "workers/a",
        unitName: "@workspace-workers/a",
        stateHash: `state:${"a".repeat(64)}`,
        buildKey: "b".repeat(64),
        executionDigest: "c".repeat(64),
        authorityRequests: [
          {
            capability: "service:workspace-state.alarmClear",
            resource: { kind: "exact", key: "workspace:test" },
            tier: "gated",
            evidence: "exact",
          },
        ],
        effectiveVersion: "d".repeat(64),
      });

      expect(new RuntimeImageStore(statePath).get("worker:workers/a:one")).toMatchObject({
        executionDigest: "c".repeat(64),
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
          version: 5,
          records: [{ id: "worker:workers/a:one", executionDigest: "not-a-digest" }],
        })
      );

      expect(() => new RuntimeImageStore(statePath)).toThrow(/record 0 has invalid source/);
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
