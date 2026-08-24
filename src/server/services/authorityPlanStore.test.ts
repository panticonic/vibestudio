import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AuthorityPlanStore } from "./authorityPlanStore.js";

function statePath(): string {
  return mkdtempSync(join(tmpdir(), "authority-plan-store-"));
}

const leaf = {
  service: "notification",
  method: "showToUser",
  capability: "notification.show",
  capabilityDefinitionDigest: "b".repeat(64),
  provider: "-" as const,
  providerEffectiveVersion: "-" as const,
  resource: { kind: "exact" as const, key: "user:alice" },
  tier: "gated" as const,
  use: "action" as const,
};

describe("AuthorityPlanStore", () => {
  it("publishes one canonical content-addressed artifact independent of leaf order", () => {
    const store = new AuthorityPlanStore({ statePath: statePath() });
    const input = {
      catalogDigest: "c".repeat(64),
      executionImageDigest: "d".repeat(64),
      leaves: [leaf, { ...leaf, method: "dismiss" }],
      now: 10,
    };
    const first = store.publish(input);
    const replay = store.publish({ ...input, leaves: [...input.leaves].reverse(), now: 20 });
    expect(replay).toEqual(first);
    expect(store.get(first.bodyDigest)).toEqual(first);
    store.close();
  });

  it("survives restart and rejects a body whose stored contents do not match its digest", () => {
    const root = statePath();
    const firstStore = new AuthorityPlanStore({ statePath: root });
    const artifact = firstStore.publish({
      catalogDigest: "c".repeat(64),
      executionImageDigest: "d".repeat(64),
      leaves: [leaf],
      now: 10,
    });
    const databasePath = firstStore.databasePath;
    firstStore.close();

    const reopened = new AuthorityPlanStore({ statePath: root });
    expect(reopened.get(artifact.bodyDigest)).toEqual(artifact);
    reopened.close();

    const database = new DatabaseSync(databasePath);
    const tampered = { ...artifact, catalogDigest: "f".repeat(64) };
    database
      .prepare("UPDATE authority_plans SET artifact_json=? WHERE digest=?")
      .run(JSON.stringify(tampered), artifact.bodyDigest);
    database.close();

    const corrupted = new AuthorityPlanStore({ statePath: root });
    expect(() => corrupted.get(artifact.bodyDigest)).toThrow(/content-address verification/);
    corrupted.close();
  });
});
