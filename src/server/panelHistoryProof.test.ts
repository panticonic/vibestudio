import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PanelAttempt } from "@vibestudio/shared/panel/observation";
import { createPanelHistoryProof } from "./panelHistoryProof.js";
import { PanelRuntimeStore } from "./panelRuntimeStore.js";

describe("panel history proof", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-proof-"));
    dirs.push(dir);
    const store = new PanelRuntimeStore({ databasePath: path.join(dir, "db") });
    const attempts = new Map<string, PanelAttempt>();
    const listeners: Array<(id: string) => void> = [];
    // Newest first: e3 (current, build b3) → e2 (b2) → e1 (b1)
    const history = [
      { entry_key: "e3", entity_id: "panel:e3" },
      { entry_key: "e2", entity_id: "panel:e2" },
      { entry_key: "e1", entity_id: "panel:e1" },
    ];
    let current = "panel:e3";
    const reverts: Array<[string, string, string]> = [];
    const errors: unknown[] = [];
    const proof = createPanelHistoryProof({
      store,
      coordinator: {
        onAttemptChanged: (l) => {
          listeners.push(l);
          return () => {};
        },
        attemptById: (id) => attempts.get(id) ?? null,
      },
      slotHistory: async () => history,
      entityBuildKey: async (entityId) => `b${entityId.slice(-1)}`,
      currentEntity: async () => current,
      revertTo: async (slotId, expected, entryKey) => {
        reverts.push([slotId, expected, entryKey]);
        current = `panel:${entryKey}`;
      },
      onError: (e) => errors.push(e),
    });
    let n = 0;
    const report = (entity: string, phase: PanelAttempt["phase"], code?: string) => {
      const attempt = {
        epoch: "ep",
        attemptId: `a${++n}`,
        slotId: "slot",
        runtimeEntityId: entity,
        buildKey: `b${entity.slice(-1)}`,
        phase,
        revision: 1,
        reporter: "host",
        updatedAt: n,
        ...(code ? { failure: { stage: "entry", code } } : {}),
      } as PanelAttempt;
      attempts.set(attempt.attemptId, attempt);
      listeners.forEach((l) => l(attempt.attemptId));
    };
    return { proof, store, report, reverts, errors, setCurrent: (e: string) => (current = e) };
  }

  it("proves a build the first time it starts", async () => {
    const { proof, report } = setup();
    report("panel:e1", "ready");
    expect((await proof.proofForSlot("slot")).map((p) => [p.entryKey, p.state])).toEqual([
      ["e3", "unproven"],
      ["e2", "unproven"],
      ["e1", "proven"],
    ]);
  });

  it("reverts a never-proven current build that fails by its own code to the newest proven entry", async () => {
    const { proof, report, reverts } = setup();
    report("panel:e1", "ready");
    report("panel:e3", "failed", "entry_threw");
    await proof.idle();
    expect(reverts).toEqual([["slot", "panel:e3", "e1"]]);
    const e3 = (await proof.proofForSlot("slot")).find((p) => p.entryKey === "e3")!;
    expect(e3.state).toBe("failed");
    expect(e3.failure).toMatchObject({ code: "entry_threw" });
  });

  it("does not revert for infrastructure failures, or for proven builds failing later", async () => {
    const { proof, report, reverts } = setup();
    report("panel:e1", "ready");
    report("panel:e3", "failed", "asset_transport_failed");
    report("panel:e3", "ready");
    report("panel:e3", "failed", "render_crashed");
    await proof.idle();
    expect(reverts).toEqual([]);
  });

  it("reverts once per build and not when the slot already moved on", async () => {
    const { proof, report, reverts, setCurrent } = setup();
    report("panel:e1", "ready");
    setCurrent("panel:e2");
    report("panel:e3", "failed", "boot_stalled");
    report("panel:e3", "failed", "boot_stalled");
    await proof.idle();
    expect(reverts).toEqual([]);
  });

  it("leaves the failure visible when nothing is proven", async () => {
    const { proof, report, reverts } = setup();
    report("panel:e3", "failed", "compile_failed");
    await proof.idle();
    expect(reverts).toEqual([]);
    expect((await proof.proofForSlot("slot"))[0]!.state).toBe("failed");
  });
});
