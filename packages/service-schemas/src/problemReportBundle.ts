import { z } from "zod";
import { canonicalJson } from "@vibestudio/content-addressing";

export const REPORT_POLICY = {
  version: "problem-reporting.v2",
  destination: "https://vibestudio.app/v1/problem-reports",
  automaticBytes: 16 * 1024,
  bundleBytes: 10 * 1024 * 1024,
  narrativeBytes: 128 * 1024,
  evidenceBytes: 256 * 1024,
  attachmentBytes: 7 * 1024 * 1024,
  attachments: 5,
  dailyAutomatic: 20,
  collectionMilliseconds: 5000,
  collectionConcurrency: 2,
} as const;
export const REPORT_MEDIA_TYPE = "application/vnd.vibestudio.problem-report+json";
const id = z.string().uuid();
const timestamp = z.string().datetime();
const label = z.string().max(256);
const productToken = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z0-9_.:@/-]+$/);
export const ReportProblemSchema = z
  .object({
    category: z.enum(["runtime", "service", "build", "activation", "agent", "quality", "startup"]),
    component: z.enum([
      "host",
      "main",
      "renderer",
      "rpc",
      "workerd",
      "agent",
      "build",
      "workspace",
      "unknown",
    ]),
    operation: productToken.nullable(),
    code: productToken.nullable(),
    kind: z.enum(["internal", "protocol", "application", "transport", "access", "unknown"]),
    frames: z
      .array(
        z
          .object({
            source: productToken,
            line: z.number().int().safe().positive(),
            column: z.number().int().safe().nonnegative(),
          })
          .strict()
      )
      .max(64),
    externalFramesOmitted: z.number().int().safe().nonnegative(),
    symptom: z.string().max(8192).optional(),
    expected: z.string().max(8192).optional(),
  })
  .strict();
export const ReportNarrativeSchema = z
  .object({
    id,
    section: z.enum([
      "goal",
      "symptom",
      "expected",
      "reproduction",
      "timeline",
      "impact",
      "investigation",
      "findings",
      "hypotheses",
      "attempts",
      "verification",
      "questions",
    ]),
    author: z.enum(["user", "agent"]),
    authorLabel: label,
    claims: z.enum(["observed", "inferred", "unverified"]),
    markdown: z.string(),
    evidenceIds: z.array(id).max(100),
  })
  .strict();
export const ReportEvidenceSchema = z
  .object({
    id,
    source: z.enum([
      "runtime",
      "server-log",
      "invocation",
      "build",
      "panel",
      "chat",
      "file",
      "failure",
      "startup",
    ]),
    capturedAt: timestamp,
    coordinate: z.string().max(1024),
    completeness: z.enum(["complete", "truncated", "unavailable", "denied"]),
    reason: z
      .enum(["source-expired", "source-disconnected", "deadline", "byte-budget", "scope-denied"])
      .nullable(),
    retained: z.number().int().safe().nonnegative(),
    omitted: z.number().int().safe().nonnegative(),
    redactions: z.array(label).max(100),
    value: z.string(),
  })
  .strict();
export const ProblemReportBundleSchema = z
  .object({
    schema: z.literal("vibestudio.problem-report.v1"),
    submissionId: id,
    reportId: id,
    reportRevision: z.number().int().safe().positive(),
    intent: z.enum(["automatic-diagnostic", "manual-problem"]),
    createdAt: timestamp,
    observedAt: timestamp,
    consent: z
      .object({
        policyVersion: z.literal(REPORT_POLICY.version),
        revision: z.number().int().safe().positive(),
        mode: z.enum(["automatic", "manual"]),
        approvedAt: timestamp,
        destination: z.literal(REPORT_POLICY.destination),
      })
      .strict(),
    environment: z
      .object({
        productVersion: productToken.nullable(),
        buildVersion: productToken.nullable(),
        templateVersion: productToken.nullable(),
        platform: z.enum(["linux", "darwin", "win32", "android", "ios", "unknown"]),
        architecture: z.enum(["x64", "arm64", "unknown"]),
        runtime: z.enum(["server", "desktop", "mobile", "headless", "unknown"]),
      })
      .strict(),
    problem: ReportProblemSchema,
    occurrence: z
      .object({
        origin: id,
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        fingerprintVersion: z.literal(1),
        count: z.number().int().safe().positive(),
        firstAt: timestamp,
        lastAt: timestamp,
        dropped: z.number().int().safe().nonnegative(),
        sampled: z.boolean(),
        installationPseudonym: id.optional(),
      })
      .strict(),
    references: z
      .array(
        z
          .object({
            id,
            kind: z.enum(["invocation", "build", "panel", "receipt", "message", "report"]),
            coordinate: z.string().max(1024),
          })
          .strict()
      )
      .max(100),
    narrative: z.array(ReportNarrativeSchema).max(100),
    evidence: z.array(ReportEvidenceSchema).max(100),
    attachments: z
      .array(
        z
          .object({
            id,
            name: z
              .string()
              .max(128)
              .regex(/^[^/\\\x00-\x1f]+$/),
            mimeType: z
              .string()
              .max(128)
              .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
            size: z.number().int().safe().nonnegative(),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
            base64: z
              .string()
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
          })
          .strict()
      )
      .max(REPORT_POLICY.attachments),
  })
  .strict()
  .superRefine((report, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (report.intent === "automatic-diagnostic") {
      if (
        report.consent.mode !== "automatic" ||
        report.narrative.length ||
        report.evidence.length ||
        report.attachments.length ||
        report.references.length ||
        report.problem.symptom !== undefined ||
        report.problem.expected !== undefined
      )
        fail("Automatic reports contain only product diagnostic fields");
      if (!report.occurrence.installationPseudonym) fail("Automatic enrollment pseudonym required");
      if (!["internal", "protocol"].includes(report.problem.kind))
        fail("Failure is not eligible for automatic reporting");
    } else if (report.consent.mode !== "manual") fail("Manual report approval required");
    if (utf8Size(report.narrative) > REPORT_POLICY.narrativeBytes)
      fail("Narrative exceeds 128 KiB");
    if (utf8Size(report.evidence) > REPORT_POLICY.evidenceBytes) fail("Evidence exceeds 256 KiB");
    if (report.attachments.reduce((n, a) => n + a.size, 0) > REPORT_POLICY.attachmentBytes)
      fail("Attachments exceed 7 MiB");
    for (const sections of [
      report.references,
      report.narrative,
      report.evidence,
      report.attachments,
    ])
      if (new Set(sections.map((s) => s.id)).size !== sections.length)
        fail("Section identities must be unique");
    for (const attachment of report.attachments) {
      const padding = attachment.base64.endsWith("==")
        ? 2
        : attachment.base64.endsWith("=")
          ? 1
          : 0;
      if ((attachment.base64.length / 4) * 3 - padding !== attachment.size)
        fail("Attachment size mismatch");
    }
    const evidenceIds = new Set(report.evidence.map((e) => e.id));
    if (report.narrative.some((n) => n.evidenceIds.some((e) => !evidenceIds.has(e))))
      fail("Narrative references missing evidence");
  });
export type ProblemReportBundle = z.infer<typeof ProblemReportBundleSchema>;
export type ReportProblem = z.infer<typeof ReportProblemSchema>;
export function utf8Size(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value)).length;
}
export function encodeReport(value: unknown): string {
  const report = ProblemReportBundleSchema.parse(value);
  const encoded = canonicalJson(report);
  if (
    utf8Size(encoded) >
    (report.intent === "automatic-diagnostic"
      ? REPORT_POLICY.automaticBytes
      : REPORT_POLICY.bundleBytes)
  )
    throw new Error("Report exceeds encoded byte budget");
  return encoded;
}
export async function reportDigest(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Only user-editable content crosses the draft update boundary. The host owns identity, revisions, consent and environment. */
export const ReportDraftContentSchema = ProblemReportBundleSchema.innerType()
  .pick({
    problem: true,
    references: true,
    narrative: true,
    evidence: true,
    attachments: true,
  })
  .strict();
export type ReportDraftContent = z.infer<typeof ReportDraftContentSchema>;
export function reportDraftContent(value: ReportDraftContent): ReportDraftContent {
  const { problem, references, narrative, evidence, attachments } = value;
  return { problem, references, narrative, evidence, attachments };
}
export async function decodeReport(bytes: Uint8Array): Promise<ProblemReportBundle> {
  if (bytes.byteLength > REPORT_POLICY.bundleBytes)
    throw new Error("Report exceeds encoded byte budget");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  const report = ProblemReportBundleSchema.parse(value);
  if (encodeReport(report) !== text) throw new Error("Canonical JSON required");
  for (const attachment of report.attachments) {
    const decoded = Uint8Array.from(atob(attachment.base64), (character) =>
      character.charCodeAt(0)
    );
    if (decoded.length !== attachment.size) throw new Error("Attachment size mismatch");
    if ((await reportDigest(decoded)) !== attachment.digest)
      throw new Error("Attachment digest mismatch");
    // atob accepts nonzero padding bits: ensure one canonical base64 spelling.
    if (attachment.base64.length && btoa(atob(attachment.base64)) !== attachment.base64)
      throw new Error("Canonical base64 required");
  }
  return report;
}
export async function problemFingerprint(problem: ReportProblem): Promise<string> {
  return reportDigest(
    canonicalJson({
      version: 1,
      component: problem.component,
      operation: problem.operation,
      code: problem.code,
      kind: problem.kind,
      frames: problem.frames,
    })
  );
}

export const ProblemReportReceiptSchema = z
  .object({
    submissionId: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    receiptId: z.string().uuid(),
    receivedAt: z.string().datetime(),
    status: z.enum(["available", "deleted", "expired"]),
    deletionCompleted: z.boolean().optional(),
    resolution: z
      .object({
        status: z.enum([
          "new",
          "investigating",
          "fixed-awaiting-verification",
          "resolved",
          "unreproduced",
          "wont-fix",
          "duplicate",
        ]),
        fixedVersion: z.string().max(128).nullable(),
        updatedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Domain-separated detached signature. Receipt capability binding prevents a relay substituting deletion access. */
export function reportSignaturePayload(
  submissionId: string,
  digest: string,
  receiptSecretDigest: string
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    new TextEncoder().encode(
      `vibestudio.problem-report-signature.v1\n${REPORT_POLICY.destination}\n${submissionId}\n${digest}\n${receiptSecretDigest}`
    )
  );
}
export const ReportSignatureSchema = z
  .object({
    publicKey: z.string().regex(/^[a-f0-9]{64}$/),
    signature: z.string().regex(/^[a-f0-9]{128}$/),
  })
  .strict();
export type ReportSignature = z.infer<typeof ReportSignatureSchema>;
