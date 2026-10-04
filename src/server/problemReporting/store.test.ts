import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("opens shared reporting state while another connection finishes its database work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "report-open-contention-"));
    new ProblemReportingStore(directory).close();
    const worker = new Worker(
      `const { DatabaseSync } = require('node:sqlite');
       const { parentPort, workerData } = require('node:worker_threads');
       const db = new DatabaseSync(workerData);
       db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
       parentPort.postMessage('locked');
       // Hold a real SQLite lock briefly so the opening connection must wait.
       // This delay belongs only to the contention fixture, not store recovery.
       setTimeout(() => { db.exec('COMMIT'); db.close(); }, 250);`,
      { eval: true, workerData: join(directory, "reports.db") }
    );
    const exited = once(worker, "exit");
    try {
      await once(worker, "message");
      const reopened = new ProblemReportingStore(directory);
      try {
        expect(reopened.installationId).toBeTruthy();
      } finally {
        reopened.close();
      }
    } finally {
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("opens the shared reporting store while another workspace commits a write", async () => {
    const directory = mkdtempSync(join(tmpdir(), "report-shared-startup-"));
    const first = new ProblemReportingStore(directory);
    cleanup.push(
      () => rmSync(directory, { recursive: true, force: true }),
      () => first.close()
    );
    first.decide("alice", 0, "on", "shell");
    const writer = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData);
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('writing');
      // A finite fixture transaction models a sibling process completing its
      // actual write. This is not a production retry or recovery deadline.
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 200);
    `,
      { eval: true, workerData: join(directory, "reports.db") }
    );
    const joined = new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Reporting writer exited ${code}`))
      );
    });
    const outcomes = await Promise.allSettled([
      (async () => {
        await new Promise<void>((resolve, reject) => {
          writer.once("message", (message) =>
            message === "writing"
              ? resolve()
              : reject(new Error("Writer did not own the transaction"))
          );
          writer.once("error", reject);
        });
        const second = new ProblemReportingStore(directory);
        cleanup.push(() => second.close());
        expect(second.installationId).toBe(first.installationId);
        expect(second.consent("alice")).toEqual(first.consent("alice"));
      })(),
      joined,
    ]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : []
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Shared reporting admission and writer join failed");
  });
  it("closes a refused schema owner and preserves its original admission failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "report-refused-startup-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "reports.db");
    const original = new DatabaseSync(file);
    original.exec(
      "CREATE TABLE future_report(id INTEGER PRIMARY KEY); INSERT INTO future_report VALUES (1); PRAGMA user_version=2;"
    );
    original.close();
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      expect(() => new ProblemReportingStore(directory)).toThrow("schema version is 2, expected 1");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
    const observed = new DatabaseSync(file, { readOnly: true });
    try {
      expect(observed.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
      expect(observed.prepare("SELECT id FROM future_report").get()?.["id"]).toBe(1);
    } finally {
      observed.close();
    }
  });
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
  it.each(["on", "off"] as const)(
    "converges concurrent installation choices to %s without revising the saved decision",
    (state) => {
      const directory = mkdtempSync(join(tmpdir(), "report-consent-"));
      const first = new ProblemReportingStore(directory);
      const second = new ProblemReportingStore(directory);
      cleanup.push(
        () => rmSync(directory, { recursive: true, force: true }),
        () => first.close(),
        () => second.close()
      );
      const firstReview = first.consent("alice");
      const secondReview = second.consent("alice");
      const saved = first.decide("alice", firstReview.revision, state, "shell");

      expect(second.decide("alice", secondReview.revision, state, "shell")).toEqual(saved);
      expect(first.decide("alice", saved.revision, state, "shell")).toEqual(saved);
      expect(second.consent("alice")).toEqual(saved);
      expect(saved.revision).toBe(1);
      expect(second.consent("bob").state).toBe("undecided");
    }
  );

  it("keeps a later sharing choice authoritative against stale opposing decisions", () => {
    const s = store();
    s.decide("alice", 0, "on", "shell");
    const withdrawn = s.decide("alice", 1, "off", "shell");

    expect(() => s.decide("alice", 0, "on", "shell")).toThrow("Consent changed");
    expect(() => s.decide("alice", 1, "on", "shell")).toThrow("Consent changed");
    expect(s.consent("alice")).toEqual(withdrawn);
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
