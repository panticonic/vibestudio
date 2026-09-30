import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { ProblemReportingStore } from "./store";
import { ReportDelivery } from "./delivery";
import { reportFixture } from "./testFixture";
import type { EgressProxy } from "../services/egressProxy";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});
function fixture(forward: EgressProxy["forwardHostFetch"]) {
  const directory = mkdtempSync(join(tmpdir(), "report-delivery-"));
  const store = new ProblemReportingStore(directory);
  store.rememberOwner("alice", "alice");
  const report = reportFixture();
  store.create("alice", "ws", report);
  const preview = store.prepare("alice", "ws", report.reportId, 1);
  store.queue("alice", "ws", report.reportId, 1, preview.digest);
  const delivery = new ReportDelivery(store, { forwardHostFetch: forward }, async () => ({
    publicKey: "a".repeat(64),
    signature: "b".repeat(128),
  }));
  cleanup.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => store.close(),
    () => delivery.stop()
  );
  return { store, report, preview, delivery };
}
function response(status: number, body: unknown, headers: [string, string][] = []) {
  return {
    status,
    statusText: "",
    headerPairs: headers,
    body: new TextEncoder().encode(JSON.stringify(body)),
    finalUrl: "https://vibestudio.app/v1/problem-reports",
  };
}
describe("durable report delivery", () => {
  it("recovers lost acknowledgement with the stable protected secret and exact digest, without a second upload", async () => {
    vi.useFakeTimers();
    let accepted: unknown;
    let protectedSecret: string | undefined;
    let posts = 0;
    const f = fixture(async (params) => {
      if (params.method === "POST") {
        posts++;
        expect(params.body).toBe(f.preview.bytes);
        expect(params.credentialId).toBeNull();
        expect(params.headers?.["authorization"]).toBeUndefined();
        expect(params.headers?.["x-report-signature"]).toHaveLength(128);
        protectedSecret = params.headers?.["x-report-receipt-secret"];
        accepted = {
          submissionId: f.report.submissionId,
          digest: f.preview.digest,
          receiptId: randomUUID(),
          receivedAt: new Date().toISOString(),
          status: "available",
        };
        throw new Error("Lost acknowledgement");
      }
      expect(params.credentialId).toBeNull();
      expect(params.headers?.["x-report-receipt-secret"]).toBe(protectedSecret);
      return response(200, accepted);
    });
    f.delivery.wake();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.submission("alice", "ws", f.report.submissionId)["state"]).toBe("queued");
    await vi.advanceTimersByTimeAsync(6000);
    expect(posts).toBe(1);
    expect(f.store.submission("alice", "ws", f.report.submissionId)["state"]).toBe("received");
  });
  it("honors Retry-After and pauses denied access instead of retrying forever", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const f = fixture(async () =>
      response(++calls === 1 ? 429 : 401, {}, [["retry-after", "120"]])
    );
    f.delivery.wake();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(119000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.store.submission("alice", "ws", f.report.submissionId)["state"]).toBe("paused");
  });
  it("rejects an acknowledgement for different bytes rather than marking a report received", async () => {
    vi.useFakeTimers();
    const f = fixture(async () =>
      response(201, {
        submissionId: f.report.submissionId,
        digest: "0".repeat(64),
        receiptId: randomUUID(),
        receivedAt: new Date().toISOString(),
        status: "available",
      })
    );
    f.delivery.wake();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.submission("alice", "ws", f.report.submissionId)["state"]).toBe("rejected");
  });
});
