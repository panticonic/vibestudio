import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeImageStore } from "./runtimeImageStore.js";
import { stateLayout } from "./stateLayout.js";

describe("RuntimeImageStore execution identity migration", () => {
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
          },
        ],
        authorityDelegations: [],
        effectiveVersion: "d".repeat(64),
      });

      expect(new RuntimeImageStore(statePath).get("worker:workers/a:one")).toMatchObject({
        executionDigest: "c".repeat(64),
        authorityRequests: [
          {
            capability: "service:workspace-state.alarmClear",
            resource: { kind: "exact", key: "workspace:test" },
          },
        ],
      });
    } finally {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });

  it("discards legacy records that cannot identify immutable executable bytes", () => {
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

      expect(new RuntimeImageStore(statePath).list()).toEqual([]);
    } finally {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });

  it("discards execution-only records rather than inferring authority from a version", () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-images-"));
    try {
      const filePath = stateLayout(statePath).runtimeImagesFile;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 2,
          records: [
            {
              id: "worker:workers/a:one",
              source: "workers/a",
              unitName: "@workspace-workers/a",
              stateHash: `state:${"a".repeat(64)}`,
              buildKey: "b".repeat(64),
              executionDigest: "c".repeat(64),
              effectiveVersion: "d".repeat(64),
              generation: 1,
              updatedAt: 1,
            },
          ],
        })
      );

      expect(new RuntimeImageStore(statePath).list()).toEqual([]);
    } finally {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });
});
