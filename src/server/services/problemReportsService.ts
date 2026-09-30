import type { UsageAnalytics } from "../problemReporting/usage";
import type { UsagePing } from "@vibestudio/service-schemas/usageAnalytics";
import type { RuntimeSupervisionEntityKey } from "@vibestudio/service-schemas/runtime";
import { collectReportEvidence, type EvidenceCollector } from "../problemReporting/collection";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { callerAccountUserId, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { problemReportsMethods } from "@vibestudio/service-schemas/problemReports";
import {
  REPORT_POLICY,
  reportDraftContent,
  ProblemReportReceiptSchema,
  decodeReport,
  encodeReport,
  type ProblemReportBundle,
} from "@vibestudio/service-schemas/problemReportBundle";
import { canonicalJson } from "@vibestudio/content-addressing";
import { ProblemReportingStore } from "../problemReporting/store";
import { sanitizeReportText } from "../problemReporting/sanitize";
function owner(ctx: ServiceContext): string {
  const user = callerAccountUserId(ctx.caller);
  if (!user) throw new Error("Authenticated reporting owner required");
  return user;
}
function human(ctx: ServiceContext): void {
  // Verified transport identity, not the agent's claimed initiator or a draft flag.
  if (!["shell"].includes(ctx.caller.runtime.kind))
    throw new Error(
      "Use the trusted reporting UI or CLI; agents cannot grant consent or bypass submission approval"
    );
  owner(ctx);
}
export function createProblemReportsService(deps: {
  store: ProblemReportingStore;
  forwardDraft?: (value: ProblemReportBundle) => Promise<{ reportId: string; revision: number }>;
  approveSend?: (
    ctx: ServiceContext,
    report: ProblemReportBundle,
    digest: string
  ) => Promise<boolean>;
  usage?: UsageAnalytics;
  connectedServer?: {
    consent: () => Promise<ReturnType<ProblemReportingStore["consent"]>>;
    decide: (
      revision: number,
      state: "off" | "on"
    ) => Promise<ReturnType<ProblemReportingStore["consent"]>>;
  };
  usageTransport?: (ctx: ServiceContext, ping: UsagePing) => Promise<{ accepted: boolean }>;
  workspaceId: string;
  redact: (text: string) => string;
  prepareRedactor?: () => Promise<(text: string) => string>;
  environment?: ProblemReportBundle["environment"];
  wake?: () => void;
  abort?: () => void;
  importPrepared?: (reference: {
    reportId: string;
    revision: number;
    digest: string;
  }) => Promise<ProblemReportBundle>;
  collect?: (
    ctx: ServiceContext,
    selection:
      | { source: "runtime"; entity: RuntimeSupervisionEntityKey }
      | { source: "server-log"; tag?: string }
      | { source: "startup" }
  ) => EvidenceCollector;
  resolveSubject?: () => Promise<{ userId: string; handle: string }>;
  isHuman?: (ctx: ServiceContext) => boolean;
  transport?: (
    ctx: ServiceContext,
    input: {
      action: "upload" | "status" | "delete";
      submissionId: string;
      digest: string;
      receiptSecret: string;
      bytes?: string;
      publicKey?: string;
      signature?: string;
    }
  ) => Promise<{ status: number; headerPairs: [string, string][]; body: string }>;
}): ServiceDefinition {
  const { store, workspaceId } = deps;
  const checkHuman = (ctx: ServiceContext) => {
    if (deps.isHuman) {
      if (!deps.isHuman(ctx)) throw new Error("Use trusted reporting UI");
      owner(ctx);
    } else human(ctx);
  };
  const remote = async (ctx: ServiceContext, id: string, action: "status" | "delete") => {
    checkHuman(ctx);
    if (!deps.transport) throw new Error("Reporting connection unavailable");
    const row = store.submission(owner(ctx), workspaceId, id);
    const result = await deps.transport(ctx, {
      action,
      submissionId: String(row["id"]),
      digest: String(row["digest"]),
      receiptSecret: String(row["receipt_secret"]),
    });
    if (result.status !== 200)
      throw new Error(
        `Remote status unavailable (HTTP ${result.status}); the report may already be accepted`
      );
    const receipt = ProblemReportReceiptSchema.parse(JSON.parse(result.body));
    if (receipt.submissionId !== row["id"] || receipt.digest !== row["digest"])
      throw new Error("Receipt integrity mismatch");
    store.recordRemote(owner(ctx), String(row["id"]), JSON.stringify(receipt));
    return receipt;
  };
  const definition: ServiceDefinition = {
    name: "problemReports",
    description: "Private local problem reporting and explicit sharing",
    authority: { principals: ["user", "code", "host"] },
    methods: problemReportsMethods,
    handler: defineServiceHandler("problemReports", problemReportsMethods, {
      usageTransport: (ctx, [ping]) => {
        checkHuman(ctx);
        if (!deps.usageTransport) throw new Error("Usage transport unavailable");
        return deps.usageTransport(ctx, ping);
      },
      transport: (ctx, [input]) => {
        checkHuman(ctx);
        if (!deps.transport) throw new Error("Reporting transport unavailable");
        return deps.transport(ctx, input);
      },
      importPrepared: async (ctx, [reference]) => {
        if (!deps.importPrepared)
          throw new Error("This capture installation has no connected report source");
        const imported = await deps.importPrepared(reference);
        const value = {
          ...imported,
          reportId: randomUUID(),
          submissionId: randomUUID(),
          reportRevision: 1,
          createdAt: new Date().toISOString(),
          references: [
            ...imported.references,
            {
              id: randomUUID(),
              kind: "report" as const,
              coordinate: `${reference.reportId}:${reference.revision}:${reference.digest}`,
            },
          ],
        };
        return store.importSnapshot(
          owner(ctx),
          workspaceId,
          `${reference.reportId}:${reference.revision}:${reference.digest}`,
          value
        );
      },
      forConversation: async (ctx, [id, revision]) => {
        const report = store.get(owner(ctx), workspaceId, id);
        if (report.revision !== revision) throw new Error("Report changed; refresh selection");
        return deps.forwardDraft ? deps.forwardDraft(report.value) : { reportId: id, revision };
      },
      collect: async (ctx, [id, revision, selections]) => {
        const current = store.get(owner(ctx), workspaceId, id);
        if (current.revision !== revision) throw new Error("Report changed; refresh selection");
        if (!deps.collect)
          throw new Error("Evidence collection unavailable in this capture installation");
        const evidence = await collectReportEvidence(
          selections.map((selection) => deps.collect!(ctx, selection)),
          ctx.signal
        );
        const value = {
          ...current.value,
          reportRevision: revision + 1,
          submissionId: randomUUID(),
          evidence: [...current.value.evidence, ...evidence],
        };
        store.update(owner(ctx), workspaceId, id, revision, reportDraftContent(value));
        return store.get(owner(ctx), workspaceId, id);
      },
      availability: (ctx) => store.availability(owner(ctx), workspaceId),
      incidents: (ctx) => store.incidents(owner(ctx), workspaceId),
      serverConsent: (ctx) => {
        checkHuman(ctx);
        return deps.connectedServer?.consent() ?? null;
      },
      decideServer: (ctx, [revision, state]) => {
        checkHuman(ctx);
        if (!deps.connectedServer)
          throw new Error("No connected server reporting choice is available");
        return deps.connectedServer.decide(revision, state);
      },
      consent: (ctx) => store.consent(owner(ctx)),
      decide: (ctx, [revision, state]) => {
        checkHuman(ctx);
        const value = store.decide(owner(ctx), revision, state, "shell");
        deps.usage?.changed(owner(ctx));
        if (state === "off") deps.abort?.();
        deps.wake?.();
        return value;
      },
      create: (ctx, [problem]) => {
        const now = new Date().toISOString();
        const reportId = randomUUID();
        const value: ProblemReportBundle = {
          schema: "vibestudio.problem-report.v1",
          submissionId: randomUUID(),
          reportId,
          reportRevision: 1,
          intent: "manual-problem",
          createdAt: now,
          observedAt: now,
          consent: {
            policyVersion: REPORT_POLICY.version,
            revision: 1,
            mode: "manual",
            approvedAt: now,
            destination: REPORT_POLICY.destination,
          },
          environment: deps.environment ?? {
            productVersion: null,
            buildVersion: null,
            templateVersion: null,
            platform: "unknown",
            architecture: "unknown",
            runtime: "server",
          },
          problem,
          occurrence: {
            origin: randomUUID(),
            fingerprint: createHash("sha256")
              .update(
                canonicalJson({
                  version: 1,
                  component: problem.component,
                  operation: problem.operation,
                  code: problem.code,
                  kind: problem.kind,
                  frames: problem.frames,
                })
              )
              .digest("hex"),
            fingerprintVersion: 1,
            count: 1,
            firstAt: now,
            lastAt: now,
            dropped: 0,
            sampled: false,
          },
          references: [],
          narrative: [],
          evidence: [],
          attachments: [],
        };
        store.create(owner(ctx), workspaceId, value);
        deps.usage?.record(owner(ctx), "report-draft");
        return store.get(owner(ctx), workspaceId, reportId);
      },
      get: (ctx, [id]) => store.get(owner(ctx), workspaceId, id),
      update: (ctx, [id, revision, value]) => {
        return store.update(owner(ctx), workspaceId, id, revision, value);
      },
      prepare: async (ctx, [id, revision]) => {
        const report = store.get(owner(ctx), workspaceId, id);
        if (report.revision !== revision) throw new Error("Report changed; refresh preview");
        const sanitized = structuredClone(report.value);
        const redactor = deps.prepareRedactor ? await deps.prepareRedactor() : deps.redact;
        const scrub = (text: string) => sanitizeReportText(redactor(text), [], homedir());
        if (sanitized.problem.symptom !== undefined)
          sanitized.problem.symptom = scrub(sanitized.problem.symptom).text;
        if (sanitized.problem.expected !== undefined)
          sanitized.problem.expected = scrub(sanitized.problem.expected).text;
        for (const section of sanitized.narrative) {
          section.markdown = scrub(section.markdown).text;
          section.authorLabel = scrub(section.authorLabel).text;
        }
        for (const section of sanitized.evidence) {
          const result = scrub(section.value);
          section.value = result.text;
          section.coordinate = scrub(section.coordinate).text;
          section.redactions = [...new Set([...section.redactions, ...result.redactions])];
        }
        for (const reference of sanitized.references)
          reference.coordinate = scrub(reference.coordinate).text;
        for (const attachment of sanitized.attachments) {
          attachment.name = Array.from(scrub(attachment.name).text, (character) =>
            character === "/" || character === "\\" || character.charCodeAt(0) < 32
              ? "_"
              : character
          ).join("");
          if (
            attachment.mimeType.startsWith("text/") ||
            attachment.mimeType === "application/json"
          ) {
            const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.from(attachment.base64, "base64")
            );
            const bytes = Buffer.from(scrub(decoded).text, "utf8");
            attachment.base64 = bytes.toString("base64");
            attachment.size = bytes.length;
            attachment.digest = createHash("sha256").update(bytes).digest("hex");
          }
        }
        await decodeReport(new TextEncoder().encode(encodeReport(sanitized)));
        // Sanitization creates the reviewed draft revision instead of changing frozen bytes behind the UI.
        if (canonicalJson(sanitized) !== canonicalJson(report.value)) {
          sanitized.reportRevision = revision + 1;
          sanitized.submissionId = randomUUID();
          store.update(owner(ctx), workspaceId, id, revision, reportDraftContent(sanitized));
          throw new Error(
            "Sensitive text was removed. Refresh the revised report and prepare its preview again."
          );
        }
        const result = store.prepare(owner(ctx), workspaceId, id, revision);
        deps.usage?.record(owner(ctx), "report-preview");
        return result;
      },
      send: async (ctx, [id, revision, digest]) => {
        const report = store.get(owner(ctx), workspaceId, id);
        if (report.revision !== revision) throw new Error("Report changed; prepare again");
        const frozen = store.submission(owner(ctx), workspaceId, report.value.submissionId);
        if (frozen["digest"] !== digest || frozen["state"] !== "prepared")
          throw new Error("Exact prepared report unavailable");
        const isHuman = deps.isHuman ? deps.isHuman(ctx) : ctx.caller.runtime.kind === "shell";
        if (!isHuman) {
          if (!deps.approveSend) throw new Error("Human reporting approval unavailable");
          if (!(await deps.approveSend(ctx, report.value, digest)))
            throw new Error("Report submission was not approved");
          ctx.signal?.throwIfAborted();
        }
        store.queue(owner(ctx), workspaceId, id, revision, digest);
        deps.usage?.record(owner(ctx), "report-queued");
        deps.wake?.();
        return { queued: true as const };
      },
      history: (ctx) => store.history(owner(ctx), workspaceId),
      cancel: (ctx, [id]) => {
        store.cancel(owner(ctx), workspaceId, id);
        return { cancelled: true as const };
      },
      resume: (ctx, [id]) => {
        checkHuman(ctx);
        store.resume(owner(ctx), workspaceId, id);
        deps.wake?.();
        return { resumed: true as const };
      },
      retainExport: (ctx, [id, retained]) => {
        checkHuman(ctx);
        store.retainExport(owner(ctx), workspaceId, id, retained);
        return { retained };
      },
      remoteStatus: (ctx, [id]) => remote(ctx, id, "status"),
      deleteRemote: (ctx, [id]) => remote(ctx, id, "delete"),
      deleteLocal: (ctx, [id, acknowledge]) => {
        checkHuman(ctx);
        store.deleteLocal(owner(ctx), workspaceId, id, acknowledge);
        return { deleted: true as const };
      },
    }),
  };
  const original = definition.handler;
  definition.handler = async (ctx, method, args) => {
    const subject = deps.resolveSubject ? await deps.resolveSubject() : ctx.caller.subject;
    if (!subject) throw new Error("Local reporting owner unavailable");
    if (ctx.caller.subject && ctx.caller.subject.userId !== subject.userId)
      throw new Error("Reporting owner mismatch");
    store.rememberOwner(subject.userId, subject.handle);
    return original({ ...ctx, caller: { ...ctx.caller, subject } }, method, args);
  };
  return definition;
}
