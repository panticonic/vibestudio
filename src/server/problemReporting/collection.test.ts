import { expect, it, vi, afterEach } from "vitest";
import { collectReportEvidence, collectedPacket, type EvidenceCollector } from "./collection";
afterEach(() => vi.useRealTimers());
it("bounds concurrency, allocates budgets before reads, and retains selection order", async () => {
  let active = 0,
    peak = 0;
  const collectors: EvidenceCollector[] = Array.from({ length: 6 }, (_, i) => ({
    source: "server-log",
    coordinate: String(i),
    collect: async (_signal, budget) => {
      expect(budget).toBeLessThan((256 * 1024) / 6);
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return { value: { i }, retained: 1, omitted: 0 };
    },
  }));
  const sections = await collectReportEvidence(collectors);
  expect(peak).toBeLessThanOrEqual(2);
  expect(sections.map((e) => e.coordinate)).toEqual(["0", "1", "2", "3", "4", "5"]);
});
it("reports denial, byte loss, and deadline separately, and cancels owned collectors", async () => {
  vi.useFakeTimers();
  let cancelled = false;
  const result = collectReportEvidence([
    {
      source: "runtime",
      coordinate: "denied",
      collect: async () => {
        throw Object.assign(new Error("private"), { errorKind: "access" });
      },
    },
    {
      source: "server-log",
      coordinate: "large",
      collect: async () => ({ value: "x".repeat(256 * 1024), retained: 100, omitted: 8 }),
    },
    {
      source: "runtime",
      coordinate: "stuck",
      collect: (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true }
          )
        ),
    },
  ]);
  await vi.advanceTimersByTimeAsync(5001);
  const sections = await result;
  expect(sections.map((s) => s.reason)).toEqual(["scope-denied", "byte-budget", "deadline"]);
  expect(sections[1]?.omitted).toBe(108);
  expect(cancelled).toBe(true);
});
it("uses exact boot/sequence coordinates and actual record counts", () => {
  const packet = collectedPacket("server-log", {
    workspaceId: "ws",
    serverBootId: "boot",
    records: [{ seq: 31 }, { seq: 32 }],
    latestSeq: 42,
  });
  expect(packet.retained).toBe(2);
  expect(JSON.parse(packet.coordinate)).toEqual({
    workspaceId: "ws",
    serverBootId: "boot",
    firstSeq: 31,
    lastSeq: 32,
    ceilingSeq: 42,
  });
});
