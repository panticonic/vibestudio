import { canonicalJson } from "@vibestudio/content-addressing";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import {
  encodeReport,
  ProblemReportReceiptSchema,
  REPORT_POLICY,
  type ProblemReportBundle,
  type ReportDraftContent,
  type ReportSignature,
} from "@vibestudio/service-schemas/problemReportBundle";

const tables = {
  reporting_owners: `CREATE TABLE reporting_owners (owner TEXT PRIMARY KEY, handle TEXT NOT NULL)`,
  local_identity: `CREATE TABLE local_identity (id INTEGER PRIMARY KEY CHECK(id=1), user_id TEXT NOT NULL, handle TEXT NOT NULL)`,
  installation: `CREATE TABLE installation (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
  consent_decisions: `CREATE TABLE consent_decisions (owner TEXT NOT NULL, destination TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('undecided','off','on')), policy TEXT NOT NULL, decided_at TEXT NOT NULL, pseudonym TEXT NOT NULL, surface TEXT NOT NULL, PRIMARY KEY(owner,destination,revision))`,
  incidents: `CREATE TABLE incidents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL, count INTEGER NOT NULL)`,
  incident_observations: `CREATE TABLE incident_observations (origin TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE, observed_at TEXT NOT NULL)`,
  projection_cursors: `CREATE TABLE projection_cursors (source TEXT PRIMARY KEY, coordinate TEXT NOT NULL)`,
  reports: `CREATE TABLE reports (id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  imported_snapshots: `CREATE TABLE imported_snapshots (owner TEXT NOT NULL, workspace TEXT NOT NULL, source TEXT NOT NULL, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, PRIMARY KEY(owner,workspace,source))`,
  submissions: `CREATE TABLE submissions (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, owner TEXT NOT NULL, digest TEXT NOT NULL, path TEXT, intent TEXT NOT NULL, consent_revision INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, due_at INTEGER NOT NULL, lease TEXT, lease_until INTEGER, receipt_secret TEXT NOT NULL, receipt TEXT, reason TEXT, approved_at TEXT, received_at TEXT, retained INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, signing_public_key TEXT, signature TEXT)`,
  delivery_attempts: `CREATE TABLE delivery_attempts (submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, PRIMARY KEY(submission_id,attempt))`,
  automatic_allowances: `CREATE TABLE automatic_allowances (owner TEXT NOT NULL, day TEXT NOT NULL, fingerprint TEXT NOT NULL, version TEXT NOT NULL, submission_id TEXT NOT NULL, claimed_at INTEGER NOT NULL, PRIMARY KEY(owner,fingerprint,version,day))`,
};
const indexes = {
  incidents_owner: `CREATE INDEX incidents_owner ON incidents(owner,workspace,last_at)`,
  incidents_group: `CREATE INDEX incidents_group ON incidents(owner,workspace,fingerprint,last_at)`,
  reports_owner: `CREATE INDEX reports_owner ON reports(owner,workspace,updated_at)`,
  submissions_due: `CREATE INDEX submissions_due ON submissions(state,due_at)`,
};
export type Consent = {
  state: "undecided" | "off" | "on";
  revision: number;
  policy: string;
  decidedAt: string | null;
  pseudonym: string | null;
};
type Row = Record<string, SQLOutputValue>;
export class ReportConflict extends Error {}
export class ProblemReportingStore {
  private readonly db: DatabaseSync;
  readonly installationId: string;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = join(directory, "reports.db");
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      // Workspace children share this installation database. Apply its existing
      // SQLite writer contention policy before canonical schema admission, too.
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      openCanonicalSqliteDatabase(
        this.db,
        {
          version: 1,
          objects: [
            ...Object.entries(tables).map(([name, sql]) => ({ type: "table" as const, name, sql })),
            ...Object.entries(indexes).map(([name, sql]) => ({
              type: "index" as const,
              name,
              sql,
            })),
          ],
        },
        { description: "problem reporting store" }
      );
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.transaction(() => {
        if (!this.db.prepare("SELECT id FROM installation LIMIT 1").get())
          this.db
            .prepare("INSERT INTO installation VALUES (?,?)")
            .run(randomUUID(), new Date().toISOString());
      });
      this.installationId = String(this.db.prepare("SELECT id FROM installation").get()!["id"]);
    } catch (error) {
      try {
        this.db.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Problem reporting store admission and close failed"
        );
      }
      throw error;
    }
  }
  localIdentity(): { userId: string; handle: string } | null {
    const row = this.db.prepare("SELECT * FROM local_identity WHERE id=1").get();
    return row ? { userId: String(row["user_id"]), handle: String(row["handle"]) } : null;
  }
  setLocalIdentity(subject: { userId: string; handle: string }): void {
    this.db
      .prepare(
        "INSERT INTO local_identity VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,handle=excluded.handle"
      )
      .run(subject.userId, subject.handle);
  }
  rememberOwner(owner: string, handle: string): void {
    this.db
      .prepare(
        "INSERT INTO reporting_owners VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET handle=excluded.handle"
      )
      .run(owner, handle);
  }
  ownerSubject(owner: string): { owner: string; handle: string } | null {
    const row = this.db.prepare("SELECT handle FROM reporting_owners WHERE owner=?").get(owner);
    return row ? { owner, handle: String(row["handle"]) } : null;
  }
  availability(
    owner: string,
    workspace: string
  ): {
    submissionAccess: "anonymous";
    incidents: number;
    destination: string;
    policy: string;
    limits: typeof REPORT_POLICY;
  } {
    return {
      submissionAccess: "anonymous",
      incidents: Number(
        this.db
          .prepare("SELECT count(*) AS n FROM incidents WHERE owner=? AND workspace=?")
          .get(owner, workspace)!["n"]
      ),
      destination: REPORT_POLICY.destination,
      policy: REPORT_POLICY.version,
      limits: REPORT_POLICY,
    };
  }
  incidents(owner: string, workspace: string): Row[] {
    return this.db
      .prepare(
        "SELECT id,fingerprint,value,first_at,last_at,count FROM incidents WHERE owner=? AND workspace=? ORDER BY last_at DESC LIMIT 100"
      )
      .all(owner, workspace);
  }
  nextDeliveryAt(): number | null {
    const row = this.db
      .prepare(
        "SELECT min(at) AS at FROM (SELECT due_at AS at FROM submissions WHERE state='queued' UNION ALL SELECT lease_until AS at FROM submissions WHERE state='sending')"
      )
      .get();
    return row?.["at"] == null ? null : Number(row["at"]);
  }
  private assertStorageBudget(additional: number): void {
    const drafts = Number(
      this.db
        .prepare("SELECT COALESCE(sum(length(CAST(value AS BLOB))),0) AS n FROM reports")
        .get()!["n"]
    );
    let exports = 0;
    for (const file of readdirSync(this.directory))
      if (file.endsWith(".vibestudio-report.json"))
        exports += statSync(join(this.directory, file)).size;
    if (drafts + exports + additional > 200 * 1024 * 1024)
      throw new Error(
        "Reporting storage is full (200 MiB). Export or delete old reports before adding content."
      );
  }
  maintenance(now = Date.now()): void {
    this.transaction(() => this.maintain(now));
  }
  private maintain(now: number): void {
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM incidents WHERE last_at<?")
        .run(new Date(now - 14 * 86400000).toISOString());
      this.db
        .prepare("DELETE FROM automatic_allowances WHERE claimed_at<?")
        .run(now - 2 * 86400000);
      // Bound repeated-origin retention as well as incident payload bytes.
      this.db.exec(
        "DELETE FROM incident_observations WHERE origin IN (SELECT origin FROM incident_observations ORDER BY observed_at DESC LIMIT -1 OFFSET 100000)"
      );
      this.db.exec(
        "DELETE FROM incidents WHERE id IN (SELECT id FROM (SELECT id,sum(length(CAST(value AS BLOB))) OVER (ORDER BY last_at DESC,id) AS bytes FROM incidents) WHERE bytes>52428800)"
      );
    });
    const expired = this.db
      .prepare(
        "SELECT id,path FROM submissions WHERE state='received' AND retained=0 AND received_at<? AND path IS NOT NULL LIMIT 100"
      )
      .all(new Date(now - 30 * 86400000).toISOString());
    this.transaction(() => {
      for (const row of expired)
        this.db
          .prepare(
            "UPDATE submissions SET path=NULL WHERE id=? AND state='received' AND retained=0"
          )
          .run(row["id"]!);
    });
    for (const row of expired)
      if (!this.db.prepare("SELECT 1 FROM submissions WHERE path=? LIMIT 1").get(row["path"]!))
        rmSync(String(row["path"]), { force: true });
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith(".tmp") && !file.endsWith(".vibestudio-report.json")) continue;
      const path = join(this.directory, file);
      if (statSync(path).mtimeMs > now - 86400000) continue;
      if (!this.db.prepare("SELECT 1 FROM submissions WHERE path=? LIMIT 1").get(path))
        rmSync(path, { force: true });
    }
  }
  close(): void {
    this.db.close();
  }
  private inTransaction = false;
  private transaction<T>(action: () => T): T {
    if (this.inTransaction) return action();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const value = action();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  consent(owner: string): Consent {
    const row = this.db
      .prepare(
        "SELECT * FROM consent_decisions WHERE owner=? AND destination=? ORDER BY revision DESC LIMIT 1"
      )
      .get(owner, REPORT_POLICY.destination);
    if (!row)
      return {
        state: "undecided",
        revision: 0,
        policy: REPORT_POLICY.version,
        decidedAt: null,
        pseudonym: null,
      };
    return {
      state:
        row["policy"] === REPORT_POLICY.version ? (row["state"] as Consent["state"]) : "undecided",
      revision: Number(row["revision"]),
      policy: String(row["policy"]),
      decidedAt: String(row["decided_at"]),
      pseudonym: String(row["pseudonym"]),
    };
  }
  decide(owner: string, revision: number, state: "off" | "on", surface: "shell" | "cli"): Consent {
    return this.transaction(() => {
      const current = this.consent(owner);
      // Consent records a desired sharing state. Several workspace shells can
      // observe the same installation before its first choice is saved. Once
      // that choice is established, the same decision is already satisfied;
      // it must neither mint another revision nor fail a waiting shell. A
      // different choice still requires the revision the human reviewed.
      if (current.state === state) return current;
      if (current.revision !== revision)
        throw new ReportConflict("Consent changed; refresh your choice");
      this.db
        .prepare("INSERT INTO consent_decisions VALUES (?,?,?,?,?,?,?,?)")
        .run(
          owner,
          REPORT_POLICY.destination,
          revision + 1,
          state,
          REPORT_POLICY.version,
          new Date().toISOString(),
          current.state === "on" && state === "on" ? current.pseudonym! : randomUUID(),
          surface
        );
      if (state === "off")
        this.db
          .prepare(
            "UPDATE submissions SET state='cancelled',reason='consent-withdrawn' WHERE owner=? AND intent='automatic-diagnostic' AND state IN ('queued','sending','paused')"
          )
          .run(owner);
      return this.consent(owner);
    });
  }
  observe(
    owner: string,
    workspace: string,
    origin: string,
    fingerprint: string,
    value: string,
    at = new Date().toISOString(),
    cursor?: { source: string; coordinate: string }
  ): { incidentId: string; added: boolean } {
    if (Buffer.byteLength(value) > 16384) throw new Error("Observation exceeds byte budget");
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT incident_id FROM incident_observations WHERE origin=?")
        .get(origin);
      if (previous) {
        if (cursor)
          this.db
            .prepare(
              "INSERT INTO projection_cursors VALUES (?,?) ON CONFLICT(source) DO UPDATE SET coordinate=excluded.coordinate"
            )
            .run(cursor.source, cursor.coordinate);
        return { incidentId: String(previous["incident_id"]), added: false };
      }
      const group = this.db
        .prepare(
          "SELECT id FROM incidents WHERE owner=? AND workspace=? AND fingerprint=? AND last_at>=? ORDER BY last_at DESC LIMIT 1"
        )
        .get(owner, workspace, fingerprint, new Date(Date.parse(at) - 86400000).toISOString());
      const incidentId = group ? String(group["id"]) : randomUUID();
      if (group)
        this.db
          .prepare("UPDATE incidents SET count=count+1,last_at=? WHERE id=?")
          .run(at, incidentId);
      else
        this.db
          .prepare("INSERT INTO incidents VALUES (?,?,?,?,?,?,?,1)")
          .run(incidentId, owner, workspace, fingerprint, value, at, at);
      this.db
        .prepare("INSERT INTO incident_observations VALUES (?,?,?)")
        .run(origin, incidentId, at);
      if (cursor)
        this.db
          .prepare(
            "INSERT INTO projection_cursors VALUES (?,?) ON CONFLICT(source) DO UPDATE SET coordinate=excluded.coordinate"
          )
          .run(cursor.source, cursor.coordinate);
      return { incidentId, added: true };
    });
  }
  importSnapshot(
    owner: string,
    workspace: string,
    source: string,
    value: ProblemReportBundle
  ): ReturnType<ProblemReportingStore["get"]> {
    return this.transaction(() => {
      const previous = this.db
        .prepare(
          "SELECT report_id FROM imported_snapshots WHERE owner=? AND workspace=? AND source=?"
        )
        .get(owner, workspace, source);
      if (previous) return this.get(owner, workspace, String(previous["report_id"]));
      this.create(owner, workspace, value);
      this.db
        .prepare("INSERT INTO imported_snapshots VALUES (?,?,?,?)")
        .run(owner, workspace, source, value.reportId);
      return this.get(owner, workspace, value.reportId);
    });
  }
  create(
    owner: string,
    workspace: string,
    value: ProblemReportBundle
  ): { id: string; revision: number } {
    return this.transaction(() => this.createDraft(owner, workspace, value));
  }
  private createDraft(
    owner: string,
    workspace: string,
    value: ProblemReportBundle
  ): { id: string; revision: number } {
    encodeReport(value);
    this.assertStorageBudget(Buffer.byteLength(JSON.stringify(value)));
    this.db
      .prepare("INSERT INTO reports VALUES (?,?,?,?,?,?)")
      .run(value.reportId, owner, workspace, 1, JSON.stringify(value), new Date().toISOString());
    return { id: value.reportId, revision: 1 };
  }
  get(
    owner: string,
    workspace: string,
    id: string
  ): { id: string; revision: number; value: ProblemReportBundle } {
    const row = this.db
      .prepare("SELECT * FROM reports WHERE id=? AND owner=? AND workspace=?")
      .get(id, owner, workspace);
    if (!row) throw new Error("Report unavailable");
    return {
      id,
      revision: Number(row["revision"]),
      value: JSON.parse(String(row["value"])) as ProblemReportBundle,
    };
  }
  update(
    owner: string,
    workspace: string,
    id: string,
    revision: number,
    content: ReportDraftContent
  ): { id: string; revision: number } {
    return this.transaction(() => this.updateDraft(owner, workspace, id, revision, content));
  }
  private updateDraft(
    owner: string,
    workspace: string,
    id: string,
    revision: number,
    content: ReportDraftContent
  ): { id: string; revision: number } {
    const old = this.get(owner, workspace, id);
    if (old.revision !== revision)
      throw new ReportConflict("Report changed; refresh before editing");
    if (old.value.intent !== "manual-problem") throw new Error("Automatic reports are host-owned");
    const fingerprint = createHash("sha256")
      .update(
        canonicalJson({
          version: 1,
          component: content.problem.component,
          operation: content.problem.operation,
          code: content.problem.code,
          kind: content.problem.kind,
          frames: content.problem.frames,
        })
      )
      .digest("hex");
    const value: ProblemReportBundle = {
      ...old.value,
      ...content,
      reportId: id,
      reportRevision: revision + 1,
      submissionId: randomUUID(),
      createdAt: new Date().toISOString(),
      occurrence: { ...old.value.occurrence, fingerprint },
    };
    encodeReport(value);
    this.assertStorageBudget(
      Math.max(
        0,
        Buffer.byteLength(JSON.stringify(value)) - Buffer.byteLength(JSON.stringify(old.value))
      )
    );
    const result = this.db
      .prepare(
        "UPDATE reports SET revision=revision+1,value=?,updated_at=? WHERE id=? AND owner=? AND workspace=? AND revision=?"
      )
      .run(JSON.stringify(value), new Date().toISOString(), id, owner, workspace, revision);
    if (!result.changes) throw new ReportConflict("Report changed; refresh before editing");
    return { id, revision: revision + 1 };
  }
  history(owner: string, workspace: string): Row[] {
    return this.db
      .prepare(
        "SELECT r.id,r.revision,r.updated_at,s.id AS submissionId,s.state,s.reason,s.receipt,s.retained FROM reports r LEFT JOIN submissions s ON s.report_id=r.id WHERE r.owner=? AND r.workspace=? ORDER BY r.updated_at DESC LIMIT 200"
      )
      .all(owner, workspace);
  }
  prepare(
    owner: string,
    workspace: string,
    id: string,
    revision: number
  ): { submissionId: string; digest: string; bytes: string } {
    return this.transaction(() => this.freezeDraft(owner, workspace, id, revision));
  }
  private freezeDraft(
    owner: string,
    workspace: string,
    id: string,
    revision: number
  ): { submissionId: string; digest: string; bytes: string } {
    const report = this.get(owner, workspace, id);
    if (report.revision !== revision) throw new ReportConflict("Report changed; review again");
    const bytes = encodeReport(report.value);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const destination = join(this.directory, `${digest}.vibestudio-report.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    if (!this.db.prepare("SELECT 1 FROM submissions WHERE digest=? LIMIT 1").get(digest))
      this.assertStorageBudget(Buffer.byteLength(bytes));
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, destination);
    // POSIX directory fsync makes rename durable. Windows does not expose directory handles through node:fs.
    if (process.platform !== "win32") {
      const directoryFd = openSync(this.directory, "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
    this.transaction(() => {
      if (this.get(owner, workspace, id).revision !== revision)
        throw new ReportConflict("Report changed during preparation");
      const existing = this.db
        .prepare("SELECT digest FROM submissions WHERE id=?")
        .get(report.value.submissionId);
      if (existing) {
        if (existing["digest"] !== digest)
          throw new ReportConflict(
            "Submission already frozen; create a new revision and submission ID"
          );
        this.db
          .prepare("UPDATE submissions SET path=? WHERE id=?")
          .run(destination, report.value.submissionId);
        return;
      }
      this.db
        .prepare(
          "INSERT INTO submissions (id,report_id,owner,digest,path,intent,consent_revision,state,created_at,due_at,receipt_secret) VALUES (?,?,?,?,?,?,?,'prepared',?,?,?)"
        )
        .run(
          report.value.submissionId,
          id,
          owner,
          digest,
          destination,
          report.value.intent,
          report.value.consent.revision,
          report.value.createdAt,
          Date.now(),
          randomBytes(32).toString("hex")
        );
    });
    return { submissionId: report.value.submissionId, digest, bytes };
  }
  queue(owner: string, workspace: string, id: string, revision: number, digest: string): void {
    this.transaction(() => {
      const report = this.get(owner, workspace, id);
      if (report.revision !== revision) throw new ReportConflict("Report changed after preview");
      const submission = this.db
        .prepare(
          "SELECT * FROM submissions WHERE id=? AND owner=? AND digest=? AND state='prepared'"
        )
        .get(report.value.submissionId, owner, digest);
      if (!submission) throw new ReportConflict("Frozen preview unavailable");
      if (submission["intent"] === "automatic-diagnostic") {
        const consent = this.consent(owner);
        if (
          consent.state !== "on" ||
          consent.revision !== Number(submission["consent_revision"]) ||
          Date.parse(report.value.observedAt) < Date.parse(consent.decidedAt!)
        )
          throw new ReportConflict("Automatic consent unavailable");
        const day = new Date().toISOString().slice(0, 10);
        const count = Number(
          this.db
            .prepare("SELECT count(*) AS n FROM automatic_allowances WHERE owner=? AND day=?")
            .get(owner, day)!["n"]
        );
        if (
          count >= REPORT_POLICY.dailyAutomatic ||
          this.db
            .prepare(
              "SELECT 1 FROM automatic_allowances WHERE owner=? AND fingerprint=? AND version=? AND claimed_at>?"
            )
            .get(
              owner,
              report.value.occurrence.fingerprint,
              report.value.environment.productVersion ?? "unknown",
              Date.now() - 86400000
            )
        )
          throw new Error("Automatic allowance exhausted");
        this.db
          .prepare("INSERT INTO automatic_allowances VALUES (?,?,?,?,?,?)")
          .run(
            owner,
            day,
            report.value.occurrence.fingerprint,
            report.value.environment.productVersion ?? "unknown",
            report.value.submissionId,
            Date.now()
          );
      }
      this.db
        .prepare("UPDATE submissions SET state='queued',approved_at=? WHERE id=?")
        .run(new Date().toISOString(), report.value.submissionId);
    });
  }
  claim(now = Date.now()): Row | undefined {
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE submissions SET state='queued',lease=NULL WHERE state='sending' AND lease_until<?"
        )
        .run(now);
      if (
        this.db
          .prepare("SELECT 1 FROM submissions WHERE state='sending' AND lease_until>=? LIMIT 1")
          .get(now)
      )
        return undefined;
      this.db
        .prepare(
          "UPDATE submissions SET state='expired',reason='automatic-expired' WHERE state='queued' AND intent='automatic-diagnostic' AND created_at<?"
        )
        .run(new Date(now - 7 * 86400000).toISOString());
      this.db
        .prepare(
          "UPDATE submissions SET state='paused',reason='manual-stale' WHERE state='queued' AND intent='manual-problem' AND created_at<?"
        )
        .run(new Date(now - 30 * 86400000).toISOString());
      const row = this.db
        .prepare(
          "SELECT * FROM submissions WHERE state='queued' AND due_at<=? ORDER BY due_at LIMIT 1"
        )
        .get(now);
      if (!row) return undefined;
      if (row["intent"] === "automatic-diagnostic" && !this.automaticAllowed(row)) {
        this.db
          .prepare(
            "UPDATE submissions SET state='cancelled',reason='consent-unavailable' WHERE id=?"
          )
          .run(row["id"]!);
        return undefined;
      }
      const lease = randomUUID();
      this.db
        .prepare(
          "UPDATE submissions SET state='sending',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?"
        )
        .run(lease, now + 60000, row["id"]!);
      this.db
        .prepare("INSERT INTO delivery_attempts VALUES (?,?,?,NULL,NULL)")
        .run(row["id"]!, Number(row["attempts"]) + 1, now);
      return this.db.prepare("SELECT * FROM submissions WHERE id=?").get(row["id"]!);
    });
  }
  private automaticAllowed(row: Row): boolean {
    const consent = this.consent(String(row["owner"]));
    return consent.state === "on" && consent.revision === Number(row["consent_revision"]);
  }
  dispatchAllowed(id: string, lease: string): boolean {
    const row = this.db
      .prepare("SELECT * FROM submissions WHERE id=? AND lease=? AND state='sending'")
      .get(id, lease);
    return !!row && (row["intent"] !== "automatic-diagnostic" || this.automaticAllowed(row));
  }
  recordSignature(id: string, lease: string, signature: ReportSignature): ReportSignature {
    this.db
      .prepare(
        "UPDATE submissions SET signing_public_key=?,signature=? WHERE id=? AND lease=? AND signing_public_key IS NULL"
      )
      .run(signature.publicKey, signature.signature, id, lease);
    const row = this.db
      .prepare("SELECT signing_public_key,signature FROM submissions WHERE id=?")
      .get(id);
    if (!row?.["signature"]) throw new Error("Report signing lease expired");
    return { publicKey: String(row["signing_public_key"]), signature: String(row["signature"]) };
  }
  bytes(row: Row): string {
    const bytes = readFileSync(String(row["path"]), "utf8");
    if (createHash("sha256").update(bytes).digest("hex") !== row["digest"])
      throw new Error("Frozen bundle integrity mismatch");
    return bytes;
  }
  finish(
    id: string,
    lease: string,
    state: string,
    reason: string | null,
    dueAt = Date.now(),
    receipt?: string
  ): void {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT attempts,state,receipt,digest FROM submissions WHERE id=? AND lease=?")
        .get(id, lease);
      if (!row) return;
      if (receipt)
        receipt = this.mergeReceipt(
          id,
          String(row["digest"]),
          row["receipt"] ? String(row["receipt"]) : null,
          receipt
        );
      // A remotely accepted request remains recoverable even after opt-out/cancel.
      this.db
        .prepare(
          "UPDATE submissions SET state=?,reason=?,due_at=?,lease=NULL,lease_until=NULL,receipt=COALESCE(?,receipt),received_at=CASE WHEN ? IS NOT NULL THEN COALESCE(received_at,?) ELSE received_at END WHERE id=? AND lease=?"
        )
        .run(
          receipt ? "received" : row["state"] === "cancelled" ? "cancelled" : state,
          reason,
          dueAt,
          receipt ?? null,
          receipt ?? null,
          new Date().toISOString(),
          id,
          lease
        );
      this.db
        .prepare(
          "UPDATE delivery_attempts SET finished_at=?,outcome=? WHERE submission_id=? AND attempt=?"
        )
        .run(Date.now(), reason ?? state, id, row["attempts"]!);
    });
  }
  cancel(owner: string, workspace: string, id: string): void {
    this.get(owner, workspace, id);
    this.db
      .prepare(
        "UPDATE submissions SET state='cancelled',reason='user-cancelled' WHERE report_id=? AND owner=? AND state IN ('prepared','queued','sending','paused')"
      )
      .run(id, owner);
  }
  resume(owner: string, workspace: string, id: string): void {
    this.get(owner, workspace, id);
    this.db
      .prepare(
        "UPDATE submissions SET state='queued',reason=NULL,due_at=? WHERE report_id=? AND owner=? AND state='paused' AND reason!='manual-stale'"
      )
      .run(Date.now(), id, owner);
  }
  submission(owner: string, workspace: string, id: string): Row {
    const row = this.db
      .prepare(
        "SELECT s.* FROM submissions s JOIN reports r ON r.id=s.report_id WHERE s.id=? AND s.owner=? AND r.workspace=?"
      )
      .get(id, owner, workspace);
    if (!row) throw new Error("Submission unavailable");
    return row;
  }
  retainExport(owner: string, workspace: string, id: string, retained: boolean): void {
    const row = this.submission(owner, workspace, id);
    if (retained && !row["path"])
      throw new Error("Local export expired; prepare the saved draft to export it again.");
    this.db
      .prepare("UPDATE submissions SET retained=? WHERE id=? AND owner=?")
      .run(retained ? 1 : 0, row["id"]!, owner);
  }
  private mergeReceipt(
    id: string,
    digest: string,
    previous: string | null,
    candidate: string
  ): string {
    const value = ProblemReportReceiptSchema.parse(JSON.parse(candidate));
    if (value.submissionId !== id || value.digest !== digest)
      throw new Error("Receipt integrity mismatch");
    if (!previous) return candidate;
    const old = ProblemReportReceiptSchema.parse(JSON.parse(previous));
    if (old.receiptId !== value.receiptId) throw new Error("Receipt identity changed");
    const rank = { available: 0, expired: 1, deleted: 2 };
    if (
      rank[old.status] > rank[value.status] ||
      (old.status === value.status && old.deletionCompleted && !value.deletionCompleted)
    )
      return previous;
    return candidate;
  }
  recordRemote(owner: string, id: string, receipt: string): void {
    const row = this.db
      .prepare("SELECT receipt,digest FROM submissions WHERE owner=? AND id=?")
      .get(owner, id);
    if (!row) throw new Error("Submission unavailable");
    receipt = this.mergeReceipt(
      id,
      String(row["digest"]),
      row["receipt"] ? String(row["receipt"]) : null,
      receipt
    );
    this.db
      .prepare(
        "UPDATE submissions SET receipt=?,state='received',received_at=COALESCE(received_at,?) WHERE owner=? AND id=?"
      )
      .run(receipt, new Date().toISOString(), owner, id);
  }
  deleteLocal(owner: string, workspace: string, id: string, acknowledgeLoss: boolean): void {
    this.transaction(() => this.removeLocal(owner, workspace, id, acknowledgeLoss));
  }
  private removeLocal(
    owner: string,
    workspace: string,
    id: string,
    acknowledgeLoss: boolean
  ): void {
    this.get(owner, workspace, id);
    const rows = this.db
      .prepare("SELECT * FROM submissions WHERE report_id=? AND owner=?")
      .all(id, owner);
    if (rows.some((row) => row["state"] === "sending"))
      throw new Error("Cancel delivery and recover remote status before deleting");
    if (
      rows.some(
        (row) => row["receipt"] || (Number(row["attempts"]) > 0 && row["state"] !== "rejected")
      ) &&
      !acknowledgeLoss
    )
      throw new Error("Choose remote deletion or acknowledge loss of receipt access");
    this.db
      .prepare("DELETE FROM reports WHERE id=? AND owner=? AND workspace=?")
      .run(id, owner, workspace);
    for (const row of rows)
      if (!this.db.prepare("SELECT 1 FROM submissions WHERE digest=? LIMIT 1").get(row["digest"]!))
        if (row["path"] !== null) rmSync(String(row["path"]), { force: true });
  }
}
