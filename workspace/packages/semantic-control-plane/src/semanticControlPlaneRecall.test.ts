/** Recall deduplication across copied trajectory and channel projections. */
import { describe, expect, it, beforeEach } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "./index.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;
type PrivateReach = {
  indexMemoryRow(row: {
    text: string;
    kind: "message" | "file" | "commit";
    logId?: string | null;
    head?: string | null;
    eventId?: string | null;
    path?: string | null;
    contentHash?: string | null;
    anchor?: Record<string, unknown> | null;
  }): void;
};
const reach = (doi: GadWorkspaceDO): PrivateReach => doi as unknown as PrivateReach;

describe("GadWorkspaceDO — recall deduplication", () => {
  let gad: TestGad;
  let doi: GadWorkspaceDO;

  beforeEach(async () => {
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad-recall-soft" });
    doi = gad.instance;
  });

  it("dedup keeps the page full: a duplicate copy is collapsed without stealing a slot", () => {
    // Six distinct items sharing the term "widget", each a distinct event id.
    for (let i = 1; i <= 6; i += 1) {
      reach(doi).indexMemoryRow({
        text: `widget number ${["one", "two", "three", "four", "five", "six"][i - 1]}`,
        kind: "message",
        logId: "traj:D",
        head: "h-main",
        eventId: `e-w${i}`,
      });
    }
    // A published/fork COPY of the first item: same (kind, event_id), other head.
    reach(doi).indexMemoryRow({
      text: "widget number one",
      kind: "message",
      logId: "traj:D",
      head: "h-fork",
      eventId: "e-w1",
    });

    const results = doi.recallMemory({ query: "widget", limit: 5 }).results;
    // Full page (a naive dedup-after-fetch under a limit-5 SQL page would return
    // 4 here, since the copy sits inside the first five inserted rows).
    expect(results).toHaveLength(5);
    const ids = results.map((r) => r.eventId);
    expect(new Set(ids).size).toBe(5);
    expect(ids.filter((id) => id === "e-w1").length).toBeLessThanOrEqual(1);
  });

  it("dedup prefers the trajectory-log copy over a channel republish", () => {
    gad.sql.exec(
      `INSERT INTO log_heads (log_id, head, log_kind, owner_json, created_at)
       VALUES ('traj:X', 'main', 'trajectory', '{}', '2026-01-01T00:00:00.000Z'),
              ('chan:Y', 'main', 'channel', '{}', '2026-01-01T00:00:00.000Z')`
    );
    // Insert the channel copy FIRST so the swap branch (adopt the trajectory
    // copy over an already-kept non-trajectory one) is exercised.
    reach(doi).indexMemoryRow({
      text: "shared echo of a published message",
      kind: "message",
      logId: "chan:Y",
      head: "main",
      eventId: "e-shared",
    });
    reach(doi).indexMemoryRow({
      text: "shared echo of a published message",
      kind: "message",
      logId: "traj:X",
      head: "main",
      eventId: "e-shared",
    });

    const results = doi.recallMemory({ query: "shared echo" }).results;
    expect(results).toHaveLength(1);
    expect(results[0]!.logId).toBe("traj:X");
  });
});
