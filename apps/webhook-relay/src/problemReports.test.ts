import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { randomUUID, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  encodeReport,
  reportDigest,
  reportSignaturePayload,
  problemFingerprint,
  REPORT_MEDIA_TYPE,
} from "../../../packages/service-schemas/src/problemReportBundle";
import { reportFixture } from "../../../src/server/problemReporting/testFixture";
import { handleProblemReports, type ReportingBindings } from "./problemReports";
let mf: Miniflare;
const developerKey = "2".repeat(64),
  secret = "3".repeat(64);
const root = "http://localhost/v1/problem-reports";
beforeAll(async () => {
  const compiled = await build({
    stdin: {
      contents:
        'import {handleProblemReports,sweepProblemReports} from "./apps/webhook-relay/src/problemReports"; export default {fetch:handleProblemReports, async scheduled(event,env){await sweepProblemReports(env)}};',
      resolveDir: process.cwd(),
      sourcefile: "report-intake.ts",
    },
    write: false,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  mf = new Miniflare({
    modules: true,
    script: compiled.outputFiles[0]!.text,
    compatibilityDate: "2024-11-15",
    d1Databases: ["REPORT_DB"],
    r2Buckets: ["REPORT_BUNDLES"],
    bindings: {
      REPORT_KEYS: JSON.stringify([{ id: "dev", digest: await reportDigest(developerKey) }]),
    },
    ratelimits: Object.fromEntries(
      ["SUBMIT", "READ", "MUTATION", "RECEIPT", "AUTH_FAILURE", "USAGE"].map((name, i) => [
        `REPORT_${name}_LIMIT`,
        {
          namespace_id: String(i + 1),
          simple: { limit: name === "SUBMIT" ? 20 : 100, period: 60 },
        },
      ])
    ),
  });
  const db = await mf.getD1Database("REPORT_DB");
  for (const file of ["0001_problem_reports.sql", "0002_usage_analytics.sql"])
    for (const sql of readFileSync(`apps/webhook-relay/migrations/${file}`, "utf8")
      .split(";")
      .filter((sql) => sql.trim()))
      await db.prepare(sql).run();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
let machine: { privateKey: KeyObject; publicKey: KeyObject };
let source = 0;
beforeEach(() => {
  machine = generateKeyPairSync("ed25519");
  source++;
});
async function signedHeaders(id: string, bytes: string, receiptSecret = secret) {
  const digest = await reportDigest(bytes);
  return {
    "CF-Connecting-IP": `192.0.2.${source}`,
    "content-type": REPORT_MEDIA_TYPE,
    "x-report-submission-id": id,
    "x-report-digest": digest,
    "x-report-receipt-secret": receiptSecret,
    "x-report-public-key": Buffer.from(
      machine.publicKey.export({ format: "jwk" }).x!,
      "base64url"
    ).toString("hex"),
    "x-report-signature": sign(
      null,
      reportSignaturePayload(id, digest, await reportDigest(receiptSecret)),
      machine.privateKey
    ).toString("hex"),
  };
}
async function upload(report = reportFixture(), receiptSecret = secret) {
  const bytes = encodeReport(report);
  return mf.dispatchFetch(root, {
    method: "POST",
    headers: await signedHeaders(report.submissionId, bytes, receiptSecret),
    body: bytes,
  });
}
describe("Cloudflare intake with real D1 and R2", () => {
  it("requires a valid self-issued signature, but no login or registered submission key; protects developer access", async () => {
    const report = reportFixture(),
      bytes = encodeReport(report);
    const headers = await signedHeaders(report.submissionId, bytes);
    const altered = await mf.dispatchFetch(root, {
      method: "POST",
      headers: { ...headers, "x-report-signature": "0".repeat(128) },
      body: bytes,
    });
    expect(altered.status).toBe(401);
    const changedSecret = await mf.dispatchFetch(root, {
      method: "POST",
      headers: { ...headers, "x-report-receipt-secret": "5".repeat(64) },
      body: bytes,
    });
    expect(changedSecret.status).toBe(401);
    expect((await mf.dispatchFetch(`${root}/admin/overview`)).status).toBe(401);
    const db = await mf.getD1Database("REPORT_DB");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM submissions").first<{ n: number }>())!.n
    ).toBe(0);
    expect((await upload(report)).status).toBe(201);
  });
  it("accepts exact bytes once and recovers the same receipt on retry", async () => {
    const report = reportFixture();
    const first = await upload(report);
    expect(first.status).toBe(201);
    const receipt = await first.json();
    const retry = await upload(report);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(receipt);
    const download = await mf.dispatchFetch(`${root}/admin/reports/${report.submissionId}/bundle`, {
      headers: { authorization: `Bearer ${developerKey}` },
    });
    expect(await download.text()).toBe(encodeReport(report));
    expect(
      (await upload({ ...report, problem: { ...report.problem, symptom: "different" } })).status
    ).toBe(409);
  });
  it("makes wrong receipt secrets indistinguishable and prevents deleted replay resurrection", async () => {
    const report = reportFixture();
    await upload(report);
    const wrong = await mf.dispatchFetch(`${root}/submissions/${report.submissionId}/status`, {
      headers: { "x-report-receipt-secret": "4".repeat(64) },
    });
    const missing = await mf.dispatchFetch(`${root}/submissions/${randomUUID()}/status`, {
      headers: { "x-report-receipt-secret": "4".repeat(64) },
    });
    expect(wrong.status).toBe(missing.status);
    expect(await wrong.text()).toBe(await missing.text());
    const deletion = await mf.dispatchFetch(`${root}/submissions/${report.submissionId}`, {
      method: "DELETE",
      headers: { "x-report-receipt-secret": secret },
    });
    expect(deletion.status).toBe(200);
    const replay = await upload(report);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { status: string }).status).toBe("deleted");
    expect(
      (
        await mf.dispatchFetch(`${root}/admin/reports/${report.submissionId}/bundle`, {
          headers: { authorization: `Bearer ${developerKey}` },
        })
      ).status
    ).toBe(410);
  });
  it("rejects automatic prose and noncanonical JSON without content in errors", async () => {
    const report = reportFixture();
    const bytes = JSON.stringify(report);
    const result = await mf.dispatchFetch(root, {
      method: "POST",
      headers: {
        ...(await signedHeaders(report.submissionId, bytes)),
      },
      body: bytes,
    });
    expect(result.status).toBe(422);
    expect(await result.text()).not.toContain(report.submissionId);
  });
  it("supports indexed overview and unrestricted administrative SQL with audit", async () => {
    const sql = await mf.dispatchFetch(`${root}/admin/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${developerKey}` },
      body: JSON.stringify({
        sql: "SELECT name FROM sqlite_schema ORDER BY name LIMIT 30",
        params: [],
      }),
    });
    expect(sql.status).toBe(200);
    expect(((await sql.json()) as { results: unknown[] }).results.length).toBeGreaterThan(5);
    const overview = await mf.dispatchFetch(`${root}/admin/overview`, {
      headers: { authorization: `Bearer ${developerKey}` },
    });
    expect(overview.status).toBe(200);
    const db = await mf.getD1Database("REPORT_DB");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM admin_audit").first<{ n: number }>())!.n
    ).toBe(1);
  });

  it("returns complete large developer results, accepts long SQL, and permits schema and data changes", async () => {
    const headers = { authorization: `Bearer ${developerKey}`, "content-type": "application/json" };
    const query = (sql: string, params: (string | number | null)[] = []) =>
      mf.dispatchFetch(`${root}/admin/sql`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sql, params }),
      });
    const large = await query(
      "/*" +
        "comment ".repeat(3000) +
        "*/ WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<601) SELECT n,? AS value FROM rows",
      ["x".repeat(800)]
    );
    expect(large.status).toBe(200);
    const result = (await large.json()) as {
      results: { n: number; value: string }[];
      complete: boolean;
    };
    expect(result.complete).toBe(true);
    expect(result.results).toHaveLength(601);
    expect(JSON.stringify(result).length).toBeGreaterThan(256 * 1024);
    expect(result.results.at(-1)?.n).toBe(601);
    expect(
      (await query("CREATE TABLE developer_access_probe (id INTEGER PRIMARY KEY, value TEXT)"))
        .status
    ).toBe(200);
    expect(
      (await query("INSERT INTO developer_access_probe VALUES (?,?)", [1, "original"])).status
    ).toBe(200);
    const changed = await query(
      "UPDATE developer_access_probe SET value=? WHERE id=? RETURNING value",
      ["changed", 1]
    );
    expect(((await changed.json()) as { results: unknown[] }).results).toEqual([
      { value: "changed" },
    ]);
    expect((await query("DROP TABLE developer_access_probe")).status).toBe(200);
  });

  it("returns resolution metadata with receipt access and removes report-derived investigation evidence on deletion", async () => {
    const report = reportFixture();
    expect((await upload(report)).status).toBe(201);
    const db = await mf.getD1Database("REPORT_DB");
    const fingerprint = (await db
      .prepare("SELECT fingerprint FROM submissions WHERE submission_id=?")
      .bind(report.submissionId)
      .first<{ fingerprint: string }>())!.fingerprint;
    const investigationId = randomUUID(),
      eventId = randomUUID();
    await db.batch([
      db
        .prepare(
          "UPDATE triage_groups SET status='resolved',fixed_version='test-fixed',updated_at=? WHERE fingerprint=?"
        )
        .bind(new Date().toISOString(), fingerprint),
      db
        .prepare(
          "INSERT INTO investigations(id,fingerprint,status,created_at,updated_at) VALUES (?,?,'resolved',?,?)"
        )
        .bind(investigationId, fingerprint, new Date().toISOString(), new Date().toISOString()),
      db
        .prepare("INSERT INTO investigation_events VALUES (?,?,'finding',?,?,?)")
        .bind(
          eventId,
          investigationId,
          JSON.stringify({ facts: "derived private narrative" }),
          JSON.stringify([report.submissionId]),
          new Date().toISOString()
        ),
    ]);
    const status = await mf.dispatchFetch(`${root}/submissions/${report.submissionId}/status`, {
      headers: { "x-report-receipt-secret": secret },
    });
    expect(((await status.json()) as { resolution: unknown }).resolution).toMatchObject({
      status: "resolved",
      fixedVersion: "test-fixed",
    });
    const deleted = await mf.dispatchFetch(`${root}/submissions/${report.submissionId}`, {
      method: "DELETE",
      headers: { "x-report-receipt-secret": secret },
    });
    expect(deleted.status).toBe(200);
    expect(
      await db.prepare("SELECT id FROM investigation_events WHERE id=?").bind(eventId).first()
    ).toBeNull();
    expect(((await deleted.json()) as { resolution?: unknown }).resolution).toBeUndefined();
    expect(
      await db.prepare("SELECT id FROM investigations WHERE id=?").bind(investigationId).first()
    ).not.toBeNull();
  });

  it("counts payload-free anonymous startups as daily totals and rejects identifying content without storing reports", async () => {
    const url = `${root}/usage/startup`;
    const headers = { "CF-Connecting-IP": "192.0.2.200" };
    const db = await mf.getD1Database("REPORT_DB");
    const reports = await db
      .prepare("SELECT count(*) AS n FROM submissions")
      .first<{ n: number }>();
    const bare = new Request(url, { method: "POST" });
    expect(bare.body).toBeNull();
    const accepted = await handleProblemReports(bare, {
      REPORT_DB: db,
      REPORT_USAGE_LIMIT: { limit: async () => ({ success: true }) },
    } as unknown as ReportingBindings);
    expect(accepted.status).toBe(204);
    for (let i = 0; i < 3; i++) {
      const ping = await mf.dispatchFetch(url, { method: "POST", headers });
      expect(ping.status).toBe(204);
      expect(await ping.text()).toBe("");
      expect(ping.headers.has("set-cookie")).toBe(false);
    }
    expect(
      (await mf.dispatchFetch(url, { method: "POST", headers, body: '{"machine":"identifier"}' }))
        .status
    ).toBe(413);
    expect(
      (
        await mf.dispatchFetch(url, {
          method: "POST",
          headers: { ...headers, "x-report-public-key": "a".repeat(64) },
        })
      ).status
    ).toBe(400);
    expect((await mf.dispatchFetch(url + "?id=machine", { method: "POST", headers })).status).toBe(
      400
    );
    const rows = await db.prepare("SELECT * FROM usage_daily WHERE mode='baseline'").all();
    expect(rows.results).toEqual([
      { day: new Date().toISOString().slice(0, 10), mode: "baseline", metric: "startup", count: 4 },
    ]);
    expect(await db.prepare("SELECT count(*) AS n FROM submissions").first()).toEqual(reports);
    expect((await mf.dispatchFetch(`${root}/admin/analytics`)).status).toBe(401);
  });
  it("accepts only fixed coarse opt-in usage counters and exposes aggregate analytics with developer SQL", async () => {
    const headers = { "CF-Connecting-IP": "192.0.2.201", "content-type": "application/json" };
    const body = {
      schema: "vibestudio.usage.v1",
      counts: { startup: 1, "report-draft": 3, "reporting-runtime-minutes": 5 },
    };
    expect(
      (
        await mf.dispatchFetch(`${root}/usage`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      ).status
    ).toBe(204);
    expect(
      (
        await mf.dispatchFetch(`${root}/usage`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, machinePublicKey: "a".repeat(64) }),
        })
      ).status
    ).toBe(400);
    expect(
      (
        await mf.dispatchFetch(`${root}/usage`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, counts: { chatText: 1 } }),
        })
      ).status
    ).toBe(400);
    const response = await mf.dispatchFetch(`${root}/admin/analytics?days=7`, {
      headers: { authorization: `Bearer ${developerKey}` },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { rows: unknown[] }).rows).toContainEqual({
      day: new Date().toISOString().slice(0, 10),
      mode: "improvement",
      metric: "report-draft",
      count: 3,
    });
  });

  it("commits one receipt and group membership under concurrent identical retries", async () => {
    const report = reportFixture();
    const results = await Promise.all([upload(report), upload(report)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await results[0]!.json()).toEqual(await results[1]!.json());
    const db = await mf.getD1Database("REPORT_DB");
    expect(
      (await db
        .prepare("SELECT count(*) AS n FROM group_reports WHERE submission_id=?")
        .bind(report.submissionId)
        .first<{ n: number }>())!.n
    ).toBe(1);
  });
  it("keeps cursor snapshots stable when default time windows advance", async () => {
    const headers = { authorization: `Bearer ${developerKey}` };
    const first = await mf.dispatchFetch(`${root}/admin/reports?limit=1`, { headers });
    const page = (await first.json()) as {
      reports: { submission_id: string }[];
      nextCursor: string;
      filters: unknown;
    };
    expect(page.nextCursor).toBeTruthy();
    const second = await mf.dispatchFetch(
      `${root}/admin/reports?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      { headers }
    );
    expect(second.status).toBe(200);
    const next = (await second.json()) as {
      reports: { submission_id: string }[];
      filters: unknown;
    };
    expect(next.filters).toEqual(page.filters);
    expect(next.reports[0]?.submission_id).not.toBe(page.reports[0]?.submission_id);
  });
  it("rejects compressed and corrupt attachments before accepting content", async () => {
    const report = reportFixture();
    const bytes = encodeReport(report);
    const compressed = await mf.dispatchFetch(root, {
      method: "POST",
      headers: {
        ...(await signedHeaders(report.submissionId, bytes)),
        "content-encoding": "gzip",
      },
      body: bytes,
    });
    expect(compressed.status).toBe(415);
    const corrupt = await upload({
      ...report,
      attachments: [
        {
          id: randomUUID(),
          name: "evidence.txt",
          mimeType: "text/plain",
          size: 3,
          base64: "YWJj",
          digest: "0".repeat(64),
        },
      ],
    });
    expect(corrupt.status).toBe(422);
    const db = await mf.getD1Database("REPORT_DB");
    expect(
      await db
        .prepare("SELECT 1 FROM submissions WHERE submission_id=?")
        .bind(report.submissionId)
        .first()
    ).toBeNull();
  });
  it("joins verified reports by machine public key and counts distinct machines within a group", async () => {
    const base = reportFixture();
    base.problem.operation = "test.machine-join";
    const fingerprint = await problemFingerprint(base.problem);
    const firstMachine = machine;
    const publicKey = Buffer.from(
      machine.publicKey.export({ format: "jwk" }).x!,
      "base64url"
    ).toString("hex");
    expect((await upload(base)).status).toBe(201);
    expect(
      (await upload({ ...base, submissionId: randomUUID(), reportId: randomUUID() })).status
    ).toBe(201);
    machine = generateKeyPairSync("ed25519");
    expect(
      (await upload({ ...base, submissionId: randomUUID(), reportId: randomUUID() })).status
    ).toBe(201);
    const headers = { authorization: `Bearer ${developerKey}` };
    const overview = await mf.dispatchFetch(`${root}/admin/overview?fingerprint=${fingerprint}`, {
      headers,
    });
    expect(overview.status).toBe(200);
    const data = (await overview.json()) as {
      groups: { reports: number; distinctMachines: number }[];
    };
    expect(data.groups[0]).toMatchObject({ reports: 3, distinctMachines: 2 });
    const filtered = await mf.dispatchFetch(
      `${root}/admin/reports?machinePublicKey=${publicKey}&fingerprint=${fingerprint}`,
      { headers }
    );
    const reports = (await filtered.json()) as {
      reports: { signing_public_key: string; signature: string }[];
    };
    expect(reports.reports).toHaveLength(2);
    expect(
      reports.reports.every(
        (row) => row.signing_public_key === publicKey && row.signature.length === 128
      )
    ).toBe(true);
    machine = firstMachine;
  });
  it("rate limits anonymous signed writes before persistence and returns an actionable retry delay", async () => {
    const report = reportFixture();
    let result = await upload(report);
    for (let i = 0; i < 25 && result.status !== 429; i++) result = await upload(report);
    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe("60");
    const db = await mf.getD1Database("REPORT_DB");
    const before = (await db
      .prepare("SELECT count(*) AS n FROM submissions")
      .first<{ n: number }>())!.n;
    expect((await upload(reportFixture())).status).toBe(429);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM submissions").first<{ n: number }>())!.n
    ).toBe(before);
  });
});
