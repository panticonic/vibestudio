import { z } from "zod";
import { UsagePingSchema } from "../../../packages/service-schemas/src/usageAnalytics";
import {
  decodeReport,
  problemFingerprint,
  reportDigest,
  REPORT_MEDIA_TYPE,
  REPORT_POLICY,
  ReportSignatureSchema,
  reportSignaturePayload,
} from "../../../packages/service-schemas/src/problemReportBundle";

export type ReportingBindings = Pick<
  Cloudflare.Env,
  | "REPORT_DB"
  | "REPORT_BUNDLES"
  | "REPORT_SUBMIT_LIMIT"
  | "REPORT_READ_LIMIT"
  | "REPORT_MUTATION_LIMIT"
  | "REPORT_RECEIPT_LIMIT"
  | "REPORT_AUTH_FAILURE_LIMIT"
  | "REPORT_USAGE_LIMIT"
> & { REPORT_KEYS?: string };

const KeySchema = z
  .array(
    z
      .object({
        id: z.string().max(128),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
  )
  .min(1)
  .max(100);
type Key = z.infer<typeof KeySchema>[number];
type Stored = {
  submission_id: string;
  digest: string;
  receipt_secret_digest: string;
  receipt_id: string;
  signing_public_key: string;
  signature: string;
  received_at: string;
  content_state: string;
  r2_key: string;
  deletion_completed: number;
  triage_status?: string;
  fixed_version?: string | null;
  triage_updated_at?: string;
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
async function limited(binding: RateLimit, key: string): Promise<void> {
  if (!(await binding.limit({ key })).success) throw new HttpError(429, "Rate limit exceeded");
}
function equalDigest(a: string, b: string): boolean {
  return (
    a.length === b.length &&
    crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b))
  );
}
async function failedAuth(request: Request, env: ReportingBindings): Promise<never> {
  await limited(
    env.REPORT_AUTH_FAILURE_LIMIT,
    await reportDigest(request.headers.get("CF-Connecting-IP") ?? "unknown")
  );
  throw new HttpError(401, "Authentication required");
}
async function authorize(request: Request, env: ReportingBindings): Promise<Key> {
  if (!env.REPORT_KEYS) throw new HttpError(503, "Developer access is not configured");
  const keys = KeySchema.parse(JSON.parse(env.REPORT_KEYS));
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return failedAuth(request, env);
  const digest = await reportDigest(token);
  const key = keys.find((key) => equalDigest(key.digest, digest));
  if (!key) return failedAuth(request, env);
  return key;
}
async function boundedBody(request: Request, max: number): Promise<Uint8Array> {
  if (
    request.headers.get("content-encoding") &&
    request.headers.get("content-encoding") !== "identity"
  )
    throw new HttpError(415, "Content-Encoding must be identity");
  if (Number(request.headers.get("content-length")) > max)
    throw new HttpError(413, "Payload exceeds byte budget");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > max) {
        await reader.cancel();
        throw new HttpError(413, "Payload exceeds byte budget");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function acceptUsage(request: Request, env: ReportingBindings, url: URL): Promise<Response> {
  if (!env.REPORT_DB || !env.REPORT_USAGE_LIMIT)
    throw new HttpError(503, "Usage counting unavailable");
  await limited(
    env.REPORT_USAGE_LIMIT,
    await reportDigest(request.headers.get("CF-Connecting-IP") ?? "unknown")
  );
  if (
    url.search ||
    [
      "authorization",
      "cookie",
      "x-report-public-key",
      "x-report-signature",
      "x-report-submission-id",
      "x-report-digest",
      "x-report-receipt-secret",
    ].some((name) => request.headers.has(name))
  )
    throw new HttpError(400, "Usage counters accept no identity fields");
  const startup = url.pathname === "/v1/problem-reports/usage/startup";
  let counts: Record<string, number>;
  if (startup) {
    await boundedBody(request, 0);
    counts = { startup: 1 };
  } else {
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
      throw new HttpError(415, "JSON required");
    counts = UsagePingSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          await boundedBody(request, 1024)
        )
      )
    ).counts as Record<string, number>;
  }
  const day = new Date().toISOString().slice(0, 10);
  await env.REPORT_DB.batch(
    Object.entries(counts).map(([metric, count]) =>
      env.REPORT_DB.prepare(
        "INSERT INTO usage_daily(day,mode,metric,count) VALUES (?,?,?,?) ON CONFLICT(day,mode,metric) DO UPDATE SET count=usage_daily.count+excluded.count"
      ).bind(day, startup ? "baseline" : "improvement", metric, count)
    )
  );
  // Nothing about an individual request is retained. No receipt, cookie, signature, or deduplication identity.
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
function receipt(row: Stored): unknown {
  return {
    submissionId: row.submission_id,
    digest: row.digest,
    receiptId: row.receipt_id,
    receivedAt: row.received_at,
    status: row.content_state,
    deletionCompleted: !!row.deletion_completed,
    ...(row.content_state === "available" && row.triage_status && row.triage_updated_at
      ? {
          resolution: {
            status: row.triage_status,
            fixedVersion: row.fixed_version ?? null,
            updatedAt: row.triage_updated_at,
          },
        }
      : {}),
  };
}
async function lookup(env: ReportingBindings, id: string): Promise<Stored | null> {
  return env.REPORT_DB.prepare(
    "SELECT s.*,g.status AS triage_status,g.fixed_version,g.updated_at AS triage_updated_at FROM submissions s LEFT JOIN triage_groups g ON s.fingerprint=g.fingerprint WHERE submission_id=?"
  )
    .bind(id)
    .first<Stored>();
}
async function receiptAuthorize(
  request: Request,
  env: ReportingBindings,
  id: string
): Promise<Stored> {
  const secret = request.headers.get("x-report-receipt-secret") ?? "";
  if (!/^[a-f0-9]{64}$/.test(secret)) return failedAuth(request, env);
  const digest = await reportDigest(secret);
  const row = await lookup(env, id);
  if (!row || !equalDigest(row.receipt_secret_digest, digest)) return failedAuth(request, env);
  await limited(env.REPORT_RECEIPT_LIMIT, digest);
  return row;
}
async function accept(request: Request, env: ReportingBindings): Promise<Response> {
  // Cloudflare supplies this header; never accept a caller-selected installation ID as the abuse boundary.
  // This transient limiter key is not stored with reports or recorded in SQL audit rows.
  await limited(
    env.REPORT_SUBMIT_LIMIT,
    await reportDigest(request.headers.get("CF-Connecting-IP") ?? "unknown")
  );
  if (request.headers.get("content-type")?.split(";")[0] !== REPORT_MEDIA_TYPE)
    throw new HttpError(415, "Problem report media type required");
  const id = z.string().uuid().parse(request.headers.get("x-report-submission-id"));
  const declared = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(request.headers.get("x-report-digest"));
  const secret = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(request.headers.get("x-report-receipt-secret"));
  const signed = ReportSignatureSchema.parse({
    publicKey: request.headers.get("x-report-public-key"),
    signature: request.headers.get("x-report-signature"),
  });
  const secretDigest = await reportDigest(secret);
  const unhex = (hex: string) => Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  let verified = false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      unhex(signed.publicKey),
      "Ed25519",
      false,
      ["verify"]
    );
    verified = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      unhex(signed.signature),
      reportSignaturePayload(id, declared, secretDigest)
    );
  } catch {
    /* Malformed keys are invalid signatures, never an acceptance path. */
  }
  if (!verified) throw new HttpError(401, "Invalid report signature");
  const machineKeyId = await reportDigest(unhex(signed.publicKey));
  await limited(env.REPORT_SUBMIT_LIMIT, `machine:${machineKeyId}`);
  const bytes = await boundedBody(request, REPORT_POLICY.bundleBytes);
  const digest = await reportDigest(bytes);
  if (!equalDigest(declared, digest)) throw new HttpError(422, "Bundle digest mismatch");
  const existing = await lookup(env, id);
  const duplicate = (row: Stored) => {
    if (
      !equalDigest(row.digest, digest) ||
      !equalDigest(row.receipt_secret_digest, secretDigest) ||
      row.signing_public_key !== signed.publicKey ||
      row.signature !== signed.signature
    )
      throw new HttpError(409, "Submission identity conflict");
    return response(receipt(row));
  };
  if (existing) return duplicate(existing);
  let bundle;
  try {
    bundle = await decodeReport(bytes);
  } catch {
    throw new HttpError(
      422,
      "Invalid report schema, attachment integrity, budget, or canonical encoding"
    );
  }
  if (bundle.submissionId !== id) throw new HttpError(422, "Submission ID mismatch");
  const now = Date.now();
  const age = now - Date.parse(bundle.createdAt);
  if (age > 30 * 86400000 || age < -5 * 60000)
    throw new HttpError(
      422,
      "Creation time outside acceptance window; prepare a current reviewed revision"
    );
  const r2Key = `submissions/${id}/${digest}.json`;
  const fingerprint = await problemFingerprint(bundle.problem);
  // Conditional immutable persistence precedes acceptance. Unaccepted objects are swept after a grace period.
  await env.REPORT_BUNDLES.put(r2Key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: REPORT_MEDIA_TYPE },
  });
  const receivedAt = new Date(now).toISOString();
  const receiptId = crypto.randomUUID();
  await env.REPORT_DB.batch([
    env.REPORT_DB.prepare(
      `INSERT OR IGNORE INTO submissions
 (submission_id,digest,receipt_secret_digest,receipt_id,machine_key_id,signing_public_key,signature,received_at,created_at,intent,component,product_version,code,fingerprint,declared_fingerprint,occurrence_count,r2_key,bytes,observed_at,failure_kind,operation,fingerprint_version,build_version,template_version,installation_pseudonym)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id,
      digest,
      secretDigest,
      receiptId,
      machineKeyId,
      signed.publicKey,
      signed.signature,
      receivedAt,
      bundle.createdAt,
      bundle.intent,
      bundle.problem.component,
      bundle.environment.productVersion,
      bundle.problem.code,
      fingerprint,
      bundle.occurrence.fingerprint,
      bundle.occurrence.count,
      r2Key,
      bytes.length,
      bundle.observedAt,
      bundle.problem.kind,
      bundle.problem.operation,
      1,
      bundle.environment.buildVersion,
      bundle.environment.templateVersion,
      bundle.occurrence.installationPseudonym ?? null
    ),
    env.REPORT_DB.prepare(
      "INSERT OR IGNORE INTO triage_groups(fingerprint,updated_at) SELECT fingerprint,received_at FROM submissions WHERE submission_id=? AND receipt_id=? AND content_state='available'"
    ).bind(id, receiptId),
    env.REPORT_DB.prepare(
      "INSERT OR IGNORE INTO group_reports SELECT fingerprint,submission_id FROM submissions WHERE submission_id=? AND receipt_id=? AND content_state='available'"
    ).bind(id, receiptId),
  ]);
  const accepted = await lookup(env, id);
  if (!accepted) throw new HttpError(503, "Acceptance unavailable");
  if (accepted.receipt_id !== receiptId) return duplicate(accepted);
  return response(receipt(accepted), 201);
}
async function remove(env: ReportingBindings, row: Stored): Promise<Response> {
  await env.REPORT_DB.batch([
    env.REPORT_DB.prepare(
      "DELETE FROM investigation_events WHERE EXISTS(SELECT 1 FROM json_each(report_ids_json) WHERE value=?)"
    ).bind(row.submission_id),
    env.REPORT_DB.prepare(
      `UPDATE submissions SET content_state='deleted',deleted_at=COALESCE(deleted_at,?),intent=NULL,component=NULL,product_version=NULL,code=NULL,fingerprint=NULL,declared_fingerprint=NULL,occurrence_count=NULL,observed_at=NULL,failure_kind=NULL,operation=NULL,fingerprint_version=NULL,build_version=NULL,template_version=NULL,installation_pseudonym=NULL WHERE submission_id=?`
    ).bind(new Date().toISOString(), row.submission_id),
    env.REPORT_DB.prepare("DELETE FROM group_reports WHERE submission_id=?").bind(
      row.submission_id
    ),
  ]);
  try {
    await env.REPORT_BUNDLES.delete(row.r2_key);
    await env.REPORT_DB.prepare("UPDATE submissions SET deletion_completed=1 WHERE submission_id=?")
      .bind(row.submission_id)
      .run();
  } catch {
    /* scheduled sweep owns retry; index already denies content */
  }
  return response(receipt((await lookup(env, row.submission_id))!));
}
const FiltersSchema = z
  .object({
    since: z.string().datetime(),
    until: z.string().datetime(),
    machinePublicKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    component: z.string().max(128).optional(),
    version: z.string().max(128).optional(),
    code: z.string().max(128).optional(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    intent: z.enum(["manual-problem", "automatic-diagnostic"]).optional(),
    status: z.enum(["available", "deleted", "expired"]).optional(),
  })
  .strict();
function filters(url: URL) {
  const until = url.searchParams.get("until") ?? new Date().toISOString();
  const since =
    url.searchParams.get("since") ?? new Date(Date.parse(until) - 86400000).toISOString();
  const result = FiltersSchema.parse({
    since,
    until,
    ...Object.fromEntries(
      [
        "component",
        "version",
        "code",
        "fingerprint",
        "intent",
        "status",
        "machinePublicKey",
      ].flatMap((key) => (url.searchParams.has(key) ? [[key, url.searchParams.get(key)]] : []))
    ),
  });
  if (
    Date.parse(result.until) - Date.parse(result.since) > 90 * 86400000 ||
    result.until < result.since
  )
    throw new HttpError(400, "Window must be between zero and 90 days");
  const clauses = ["received_at>=?", "received_at<=?"];
  const params: (string | number)[] = [result.since, result.until];
  for (const [field, column] of [
    ["machinePublicKey", "signing_public_key"],
    ["component", "component"],
    ["version", "product_version"],
    ["code", "code"],
    ["fingerprint", "fingerprint"],
    ["intent", "intent"],
    ["status", "content_state"],
  ] as const) {
    const value = result[field];
    if (value !== undefined) {
      clauses.push(`${column}=?`);
      params.push(value);
    }
  }
  return { result, clauses, params };
}
async function admin(request: Request, env: ReportingBindings, url: URL): Promise<Response> {
  const key = await authorize(request, env);
  const path = url.pathname.slice("/v1/problem-reports/admin".length);
  if (path !== "/sql")
    await limited(
      request.method === "GET" ? env.REPORT_READ_LIMIT : env.REPORT_MUTATION_LIMIT,
      key.id
    );
  if (path === "/sql" && request.method === "POST") {
    const body = z
      .object({
        sql: z.string().min(1),
        params: z.array(z.union([z.string(), z.number().finite(), z.null()])).default([]),
      })
      .strict()
      .parse(await request.json());
    await env.REPORT_DB.prepare("INSERT INTO admin_audit VALUES (?,?,?,?,?)")
      .bind(
        crypto.randomUUID(),
        key.id,
        "sql",
        await reportDigest(body.sql),
        new Date().toISOString()
      )
      .run();
    // Authenticated developers have full SQL authority. Return the complete D1 result;
    // Cloudflare platform limits apply, with no application query/result caps or SQL rate limiter.
    const result = await env.REPORT_DB.prepare(body.sql)
      .bind(...body.params)
      .all();
    return response({ results: result.results, meta: result.meta, complete: true });
  }
  if (request.method !== "GET" && request.method !== "DELETE")
    throw new HttpError(405, "Method not allowed");
  if (path === "/analytics" && request.method === "GET") {
    const days = z.coerce
      .number()
      .int()
      .min(1)
      .max(400)
      .parse(url.searchParams.get("days") ?? 30);
    const today = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400000)
      .toISOString()
      .slice(0, 10);
    const result = await env.REPORT_DB.prepare(
      "SELECT day,mode,metric,count FROM usage_daily WHERE day>=? AND day<=? ORDER BY day,mode,metric"
    )
      .bind(since, today)
      .all();
    return response({
      since,
      until: today,
      queriedAt: new Date().toISOString(),
      rows: result.results,
      metric: "Accepted aggregate counters, not unique people or machines",
    });
  }
  if (path === "/reports" && request.method === "GET") {
    const cursorValue = url.searchParams.get("cursor");
    if (cursorValue && cursorValue.length > 4096) throw new HttpError(400, "Cursor exceeds budget");
    const cursor = cursorValue
      ? z
          .object({
            signature: z.string(),
            filters: FiltersSchema,
            at: z.string().datetime(),
            id: z.string().uuid(),
          })
          .strict()
          .parse(JSON.parse(atob(cursorValue)))
      : null;
    if (cursor)
      for (const name of ["since", "until"] as const)
        if (!url.searchParams.has(name)) url.searchParams.set(name, cursor.filters[name]);
    const f = filters(url);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(url.searchParams.get("limit") ?? 50);
    const signature = await reportDigest(JSON.stringify(f.result));
    if (cursor) {
      if (cursor.signature !== signature) throw new HttpError(400, "Cursor filters changed");
      f.clauses.push("(received_at,submission_id)<(?,?)");
      f.params.push(cursor.at, cursor.id);
    }
    const result = await env.REPORT_DB.prepare(
      `SELECT submission_id,digest,receipt_id,machine_key_id,signing_public_key,signature,receipt_secret_digest,received_at,intent,component,product_version,code,fingerprint,occurrence_count,bytes,content_state,pinned FROM submissions WHERE ${f.clauses.join(" AND ")} ORDER BY received_at DESC,submission_id DESC LIMIT ?`
    )
      .bind(...f.params, limit + 1)
      .all<{ received_at: string; submission_id: string }>();
    const rows = result.results.slice(0, limit);
    const last = rows.at(-1);
    return response({
      filters: f.result,
      reports: rows,
      nextCursor:
        result.results.length > limit && last
          ? btoa(
              JSON.stringify({
                signature,
                filters: f.result,
                at: last.received_at,
                id: last.submission_id,
              })
            )
          : null,
      complete: result.results.length <= limit,
    });
  }
  if (path === "/overview" && request.method === "GET") {
    const f = filters(url);
    const window = Date.parse(f.result.until) - Date.parse(f.result.since);
    const bucket = window <= 2 * 86400000 ? 3600 : 86400;
    const [counts, groups, totals] = await Promise.all([
      env.REPORT_DB.prepare(
        `SELECT CAST(strftime('%s',received_at)/? AS INTEGER)*? AS bucket,count(*) AS reports,count(distinct signing_public_key) AS machines FROM submissions WHERE ${f.clauses.join(" AND ")} AND content_state='available' GROUP BY bucket ORDER BY bucket LIMIT 2161`
      )
        .bind(bucket, bucket, ...f.params)
        .all(),
      env.REPORT_DB.prepare(
        `SELECT fingerprint,component,product_version,code, failure_kind AS failureKind, max((SELECT status FROM triage_groups g WHERE g.fingerprint=submissions.fingerprint)) AS triageStatus,max((SELECT severity FROM triage_groups g WHERE g.fingerprint=submissions.fingerprint)) AS severity,max((SELECT revision FROM triage_groups g WHERE g.fingerprint=submissions.fingerprint)) AS triageRevision,count(distinct signing_public_key) AS distinctMachines,count(distinct installation_pseudonym) AS distinctReportedInstallations,count(*) AS reports,sum(occurrence_count) AS reportedOccurrences,min(received_at) AS firstReceived,max(received_at) AS lastReceived FROM submissions WHERE ${f.clauses.join(" AND ")} AND content_state='available' GROUP BY fingerprint,component,product_version,code ORDER BY reports DESC LIMIT 200`
      )
        .bind(...f.params)
        .all(),
      env.REPORT_DB.prepare(
        `SELECT count(*) AS reports,count(distinct signing_public_key) AS machines,count(distinct fingerprint) AS groups,
        COALESCE(sum(intent='manual-problem'),0) AS manual,COALESCE(sum(intent='automatic-diagnostic'),0) AS automatic,
        count(distinct CASE WHEN NOT EXISTS(SELECT 1 FROM submissions prior WHERE prior.fingerprint=submissions.fingerprint AND prior.content_state='available' AND prior.received_at<?) THEN fingerprint END) AS newGroups,
        count(distinct CASE WHEN EXISTS(SELECT 1 FROM submissions prior WHERE prior.fingerprint=submissions.fingerprint AND prior.content_state='available' AND prior.received_at<?) THEN fingerprint END) AS recurringGroups
        FROM submissions WHERE ${f.clauses.join(" AND ")} AND content_state='available'`
      )
        .bind(f.result.since, f.result.since, ...f.params)
        .first(),
    ]);
    return response({
      queriedAt: new Date().toISOString(),
      window: f.result,
      bucketSeconds: bucket,
      totals,
      counts: counts.results,
      groups: groups.results,
      groupLimit: 200,
      metric: "submitted reports; not population crash rate",
    });
  }
  const match = /^\/reports\/([a-f0-9-]+)(\/bundle)?$/.exec(path);
  if (match) {
    const row = await lookup(env, z.string().uuid().parse(match[1]));
    if (!row) throw new HttpError(404, "Report unavailable");
    if (request.method === "DELETE") {
      if (match[2]) throw new HttpError(405, "Method not allowed");
      return remove(env, row);
    }
    if (match[2]) {
      if (row.content_state !== "available")
        throw new HttpError(410, "Report content deleted or expired");
      const object = await env.REPORT_BUNDLES.get(row.r2_key);
      if (!object) throw new HttpError(503, "Stored bundle unavailable");
      return new Response(object.body, {
        headers: {
          "content-type": REPORT_MEDIA_TYPE,
          "content-disposition": `attachment; filename="${row.submission_id}.vibestudio-report.json"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-report-digest": row.digest,
        },
      });
    }
    const metadata = await env.REPORT_DB.prepare(
      "SELECT submission_id,digest,receipt_id,machine_key_id,signing_public_key,signature,receipt_secret_digest,received_at,intent,component,product_version,code,fingerprint,occurrence_count,bytes,content_state,pinned FROM submissions WHERE submission_id=?"
    )
      .bind(row.submission_id)
      .first();
    return response(metadata);
  }
  throw new HttpError(404, "Route unavailable");
}
export async function handleProblemReports(
  request: Request,
  env: ReportingBindings
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      ["/v1/problem-reports/usage", "/v1/problem-reports/usage/startup"].includes(url.pathname)
    )
      return await acceptUsage(request, env, url);
    if (
      !env.REPORT_DB ||
      !env.REPORT_BUNDLES ||
      !env.REPORT_SUBMIT_LIMIT ||
      !env.REPORT_READ_LIMIT ||
      !env.REPORT_MUTATION_LIMIT ||
      !env.REPORT_RECEIPT_LIMIT ||
      !env.REPORT_AUTH_FAILURE_LIMIT
    )
      throw new HttpError(503, "Reporting is not configured");
    if (url.pathname === "/v1/problem-reports" && request.method === "POST")
      return await accept(request, env);
    if (url.pathname.startsWith("/v1/problem-reports/admin/"))
      return await admin(request, env, url);
    const match = /^\/v1\/problem-reports\/submissions\/([a-f0-9-]+)(\/status)?$/.exec(
      url.pathname
    );
    if (
      match &&
      ((request.method === "GET" && match[2]) || (request.method === "DELETE" && !match[2]))
    ) {
      const row = await receiptAuthorize(request, env, z.string().uuid().parse(match[1]));
      return request.method === "DELETE" ? await remove(env, row) : response(receipt(row));
    }
    throw new HttpError(404, "Route unavailable");
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : 503;
    const result = response(
      {
        error:
          error instanceof HttpError
            ? error.message
            : status === 400
              ? "Invalid request fields"
              : "Reporting temporarily unavailable",
      },
      status
    );
    if (status === 429) result.headers.set("retry-after", "60");
    return result;
  }
}
export async function sweepProblemReports(env: ReportingBindings): Promise<void> {
  if (env.REPORT_DB)
    await env.REPORT_DB.prepare("DELETE FROM usage_daily WHERE day<?")
      .bind(new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10))
      .run();
  if (!env.REPORT_DB || !env.REPORT_BUNDLES) return;
  const now = Date.now();
  await env.REPORT_DB.prepare("DELETE FROM admin_audit WHERE created_at<?")
    .bind(new Date(now - 365 * 86400000).toISOString())
    .run();
  await env.REPORT_DB.prepare(
    "UPDATE submissions SET content_state='expired',intent=NULL,component=NULL,product_version=NULL,code=NULL,fingerprint=NULL,declared_fingerprint=NULL,occurrence_count=NULL,observed_at=NULL,failure_kind=NULL,operation=NULL,fingerprint_version=NULL,build_version=NULL,template_version=NULL,installation_pseudonym=NULL WHERE content_state='available' AND pinned=0 AND received_at<?"
  )
    .bind(new Date(now - 90 * 86400000).toISOString())
    .run();
  await env.REPORT_DB.prepare(
    "DELETE FROM investigation_events WHERE EXISTS(SELECT 1 FROM json_each(report_ids_json) refs JOIN submissions s ON s.submission_id=refs.value WHERE s.content_state!='available')"
  ).run();
  const expired = await env.REPORT_DB.prepare(
    "SELECT submission_id,r2_key FROM submissions WHERE content_state IN ('deleted','expired') AND deletion_completed=0 LIMIT 100"
  ).all<{ submission_id: string; r2_key: string }>();
  for (const row of expired.results) {
    await env.REPORT_BUNDLES.delete(row.r2_key);
    await env.REPORT_DB.batch([
      env.REPORT_DB.prepare(
        "UPDATE submissions SET deletion_completed=1 WHERE submission_id=?"
      ).bind(row.submission_id),
      env.REPORT_DB.prepare("DELETE FROM group_reports WHERE submission_id=?").bind(
        row.submission_id
      ),
    ]);
  }
  await env.REPORT_DB.prepare(
    "DELETE FROM submissions WHERE content_state!='available' AND deletion_completed=1 AND received_at<?"
  )
    .bind(new Date(now - 365 * 86400000).toISOString())
    .run();
  // Bounded R2 scan with durable cursor; newly created unaccepted candidates have a 24-hour grace.
  const cursorObject = await env.REPORT_BUNDLES.get("maintenance/orphan-cursor");
  const cursor = cursorObject ? await cursorObject.text() : undefined;
  const listing = await env.REPORT_BUNDLES.list({ prefix: "submissions/", limit: 100, cursor });
  for (const object of listing.objects)
    if (
      object.uploaded.getTime() < now - 86400000 &&
      !(await env.REPORT_DB.prepare("SELECT 1 FROM submissions WHERE r2_key=? LIMIT 1")
        .bind(object.key)
        .first())
    )
      await env.REPORT_BUNDLES.delete(object.key);
  if (listing.truncated) await env.REPORT_BUNDLES.put("maintenance/orphan-cursor", listing.cursor);
  else await env.REPORT_BUNDLES.delete("maintenance/orphan-cursor");
}
