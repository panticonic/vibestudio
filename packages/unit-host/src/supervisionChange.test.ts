import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SupervisionChange } from "@vibestudio/shared/events";
import { UnitRegistry, createPendingUnitRegistryEntry, observeUnitSupervision } from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function observed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-supervision-"));
  roots.push(root);
  const registry = new UnitRegistry({ statePath: root, unitKind: "app" });
  const changes: SupervisionChange[] = [];
  observeUnitSupervision(registry, (change) => changes.push(change));
  registry.upsert(
    createPendingUnitRegistryEntry({
      unitKind: "app",
      name: "@apps/a",
      version: "1.0.0",
      sourceRepo: "workspace/apps/a",
      ref: "main",
    })
  );
  return { registry, changes };
}

describe("observeUnitSupervision", () => {
  it("announces lifecycle changes in the supervision vocabulary", () => {
    const { registry, changes } = observed();
    registry.patch("@apps/a", { status: "available", activeBundleKey: "k".repeat(64) });
    registry.patch("@apps/a", { lastError: "update refused" });

    expect(changes.map((c) => [c.status, c.lastError, c.artifact.buildKey])).toEqual([
      ["starting", null, null],
      ["running", null, "k".repeat(64)],
      ["running", "update refused", "k".repeat(64)],
    ]);
    expect(changes[0]).toMatchObject({
      identity: { kind: "app", entityId: "@apps/a" },
      source: "apps/a",
      change: "status",
    });
  });

  it("stays quiet when a patch changes neither status, error nor build", () => {
    const { registry, changes } = observed();
    registry.patch("@apps/a", { version: "1.0.1" });
    expect(changes).toHaveLength(1);
  });

  it("announces a removed unit as stopped", () => {
    const { registry, changes } = observed();
    registry.delete("@apps/a");
    expect(changes.at(-1)).toMatchObject({ status: "stopped", lastError: null });
  });
});
