import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workers/gad-store/index.js";
import { EffectOutbox } from "./effect-outbox.js";
import type { EffectDescriptor } from "@workspace/agent-loop";

describe("EffectOutbox.lease — deferred-effect redrive", () => {
  it("clears next_attempt_at on lease so a deferred effect backstops instead of hot-looping", async () => {
    const host = await createTestDO(GadWorkspaceDO, { __objectKey: "outbox-lease-host" });
    const outbox = new EffectOutbox(host.sql as never);
    const now = 1_700_000_000_000;

    const descriptor = {
      kind: "channel_call",
      effectId: "eff-1",
      channelId: "chan-1",
      idempotencyKey: "idem-1",
      transportCallId: "tc-1",
      invocationId: "inv-1",
      method: "set_title",
      args: { title: "x" },
      target: { id: "do:x" },
    } as unknown as EffectDescriptor;

    // Appended due at its dispatch time `now`.
    outbox.insert("branch-1", descriptor, now);
    expect(outbox.get("branch-1", "eff-1")?.nextAttemptAt).toBe(now);

    // Taking the row in-flight clears next_attempt_at (the now-stale dispatch time) and leases it.
    outbox.lease("branch-1", "eff-1", now + 5);
    const leased = outbox.get("branch-1", "eff-1");
    expect(leased?.nextAttemptAt).toBeNull();
    expect(leased?.leaseExpiresAt).not.toBeNull();
    expect(outbox.due(now + 10).some((r) => r.effectId === "eff-1")).toBe(false); // leased ⇒ not due

    // The driver's deferRedrive (mirrored here) releases the lease + applies its backstop. Because
    // lease() cleared next_attempt_at, the CASE falls through to the backstop — a FUTURE time —
    // instead of preserving the past dispatch time. That is the fix: the deferred effect is NOT due
    // again until the backstop, rather than re-dispatching on every alarm tick (~50ms).
    const deferAt = now + 8;
    const backstopMs = 60_000;
    host.sql.exec(
      `UPDATE effect_outbox
       SET lease_expires_at = NULL,
           next_attempt_at = CASE
             WHEN next_attempt_at IS NOT NULL AND next_attempt_at <= ? THEN next_attempt_at
             ELSE ?
           END
       WHERE branch_id = ? AND effect_id = ?`,
      deferAt,
      deferAt + backstopMs,
      "branch-1",
      "eff-1"
    );
    expect(outbox.get("branch-1", "eff-1")?.nextAttemptAt).toBe(deferAt + backstopMs);
    expect(outbox.due(deferAt + 10).some((r) => r.effectId === "eff-1")).toBe(false); // backstopped
  });
});
