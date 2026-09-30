import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ProblemReportingStore } from "./store";
import { reportFixture } from "./testFixture";
import { ReportCapture } from "./capture";
import {
  encodeReport,
  decodeReport,
  reportDraftContent,
} from "@vibestudio/service-schemas/problemReportBundle";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action();
});
function store() {
  const directory = mkdtempSync(join(tmpdir(), "report-store-"));
  const store = new ProblemReportingStore(directory);
  cleanup.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => store.close()
  );
  return store;
}
function queued(store: ProblemReportingStore, automatic = false) {
  const consent = store.consent("alice");
  const report = reportFixture(
    automatic
      ? {
          intent: "automatic-diagnostic",
          consent: {
            policyVersion: "problem-reporting.v2",
            revision: consent.revision,
            mode: "automatic",
            approvedAt: consent.decidedAt!,
            destination: "https://vibestudio.app/v1/problem-reports",
          },
          occurrence: { ...reportFixture().occurrence, installationPseudonym: consent.pseudonym! },
          observedAt: new Date(Date.now() + 1).toISOString(),
        }
      : {}
  );
  store.create("alice", "ws", report);
  const prepared = store.prepare("alice", "ws", report.reportId, 1);
  store.queue("alice", "ws", report.reportId, 1, prepared.digest);
  return report;
}
describe("installation-owned reporting", () => {
  it("persists independent choices and cancels only automatic claims transactionally", () => {
    const s = store();
    expect(s.consent("alice").state).toBe("undecided");
    s.decide("alice", 0, "on", "shell");
    expect(s.consent("bob").state).toBe("undecided");
    const automatic = queued(s, true);
    const manual = queued(s);
    const claim = s.claim()!;
    s.decide("alice", 1, "off", "shell");
    expect(s.dispatchAllowed(String(claim["id"]), String(claim["lease"]))).toBe(false);
    expect(s.submission("alice", "ws", automatic.submissionId)["state"]).toBe("cancelled");
    expect(s.submission("alice", "ws", manual.submissionId)["state"]).toBe("queued");
  });
  it("freezes identical preview/export/delivery bytes, protects receipts, and enforces owner/revision", () => {
    const s = store();
    const report = queued(s);
    const row = s.claim()!;
    expect(s.bytes(row)).toBe(encodeReport(report));
    expect(s.bytes(row)).not.toContain(String(row["receipt_secret"]));
    expect(statSync(String(row["path"])).mode & 0o777).toBe(0o600);
    expect(() => s.get("bob", "ws", report.reportId)).toThrow();
    expect(() => s.update("alice", "ws", report.reportId, 2, reportDraftContent(report))).toThrow();
  });
  it("recovers leases without changing identity and records a late receipt after cancellation", () => {
    const s = store();
    const report = queued(s);
    const claim = s.claim()!;
    expect(s.claim()).toBeUndefined();
    const recovered = s.claim(Date.now() + 61000)!;
    expect(recovered["id"]).toBe(claim["id"]);
    expect(recovered["lease"]).not.toBe(claim["lease"]);
    s.cancel("alice", "ws", report.reportId);
    s.finish(
      String(recovered["id"]),
      String(recovered["lease"]),
      "received",
      null,
      Date.now(),
      JSON.stringify({
        submissionId: report.submissionId,
        digest: String(claim["digest"]),
        receiptId: randomUUID(),
        receivedAt: new Date().toISOString(),
        status: "available",
      })
    );
    expect(s.submission("alice", "ws", report.submissionId)["state"]).toBe("received");
    expect(() => s.deleteLocal("alice", "ws", report.reportId, false)).toThrow();
  });
  it("deduplicates exact observations rather than recounting snapshots", () => {
    const s = store();
    const origin = randomUUID();
    const id = s.observe("alice", "ws", origin, "fingerprint", "{}");
    expect(id.added).toBe(true);
    expect(s.observe("alice", "ws", origin, "fingerprint", "{}")).toEqual({
      incidentId: id.incidentId,
      added: false,
    });
    expect(s.observe("alice", "ws", randomUUID(), "fingerprint", "{}")).toEqual({
      incidentId: id.incidentId,
      added: true,
    });
  });
  it("never queues historical or unconsented failures; automatic bundles omit all free text", () => {
    const s = store();
    const capture = new ReportCapture(s, "ws", () => {});
    const problem = reportFixture().problem;
    capture.observe("alice", problem);
    s.decide("alice", 0, "on", "shell");
    s.rememberOwner("alice", "Alice");
    capture.flush();
    expect(s.history("alice", "ws")).toHaveLength(0);
    capture.observe("alice", problem, randomUUID(), new Date(Date.now() + 2).toISOString());
    capture.flush();
    const rows = s.history("alice", "ws");
    expect(rows).toHaveLength(1);
    const bytes = s.bytes(s.claim()!);
    expect(bytes).not.toContain("secret");
    expect(JSON.parse(bytes).evidence).toEqual([]);
    capture.stop();
  });
  it("supports large agent narratives and rejects noncanonical or automatic content", async () => {
    const report = reportFixture({
      narrative: [
        {
          id: randomUUID(),
          section: "investigation",
          author: "agent",
          authorLabel: "Investigator",
          claims: "inferred",
          markdown: "Detailed findings. ".repeat(4000),
          evidenceIds: [],
        },
      ],
    });
    const bytes = encodeReport(report);
    expect(
      (await decodeReport(new TextEncoder().encode(bytes))).narrative[0]!.markdown.length
    ).toBeGreaterThan(60000);
    await expect(decodeReport(new TextEncoder().encode(JSON.stringify(report)))).rejects.toThrow(
      "Canonical"
    );
    expect(() => encodeReport({ ...report, intent: "automatic-diagnostic" })).toThrow();
  });
});
