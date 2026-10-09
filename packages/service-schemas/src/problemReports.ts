import { RuntimeSupervisionEntityKeySchema } from "./runtime/supervision.js";
import { z } from "zod";
import { UsagePingSchema } from "./usageAnalytics";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  ProblemReportReceiptSchema,
  ProblemReportBundleSchema,
  ReportDraftContentSchema,
  ReportNarrativeInputSchema,
  ReportNarrativePatchSchema,
  ReportProblemSchema,
} from "./problemReportBundle";
const id = z.string().uuid();
const local = {
  website: {
    kind: "closed",
    reason: "Reports contain private user-selected diagnostics.",
  } as const,
  tier: {
    tier: "open",
    session: "family",
    residency: "observability",
    family: "problemReports.local",
    rationale:
      "Host-enforced caller ownership; preparing drafts grants no external reporting authority.",
  } as const,
};
const consent = z.object({
  state: z.enum(["undecided", "off", "on"]),
  revision: z.number().int(),
  policy: z.string(),
  decidedAt: z.string().nullable(),
  pseudonym: z.string().nullable(),
});
const report = z.object({ id, revision: z.number().int(), value: ProblemReportBundleSchema });
export const problemReportsMethods = defineServiceMethods({
  usageTransport: {
    ...local,
    description:
      "Trusted native analytics transport: forward only identifier-free aggregate counters, never an error report or credentials.",
    args: z.tuple([UsagePingSchema]),
    returns: z.object({ accepted: z.boolean() }),
    access: { sensitivity: "write" },
    authority: { principals: ["user", "host", "code"] },
  },
  availability: {
    ...local,
    description:
      "Read reporting destination, limits, anonymous submission policy, and owned incident counts without exposing credentials.",
    args: z.tuple([]),
    returns: z.object({
      submissionAccess: z.literal("anonymous"),
      incidents: z.number().int(),
      destination: z.string(),
      policy: z.string(),
      limits: z.record(z.unknown()),
    }),
    access: { sensitivity: "read" },
  },
  incidents: {
    ...local,
    description:
      "Read up to 100 owned local incidents; grouping indicates similarity, not shared causality.",
    args: z.tuple([]),
    returns: z.array(
      z.object({
        id: z.string().uuid(),
        fingerprint: z.string(),
        value: z.string().max(16384),
        first_at: z.string().datetime(),
        last_at: z.string().datetime(),
        count: z.number().int().nonnegative(),
      })
    ),
    access: { sensitivity: "read" },
  },
  transport: {
    ...local,
    description:
      "Trusted native reporting uploader only: forward an exact approved bundle/status/deletion through the existing host credential broker. No secret is returned.",
    args: z.tuple([
      z
        .object({
          action: z.enum(["upload", "status", "delete"]),
          submissionId: id,
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          receiptSecret: z.string().regex(/^[a-f0-9]{64}$/),
          publicKey: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          signature: z
            .string()
            .regex(/^[a-f0-9]{128}$/)
            .optional(),
          bytes: z
            .string()
            .max(10 * 1024 * 1024)
            .optional(),
        })
        .strict(),
    ]),
    returns: z.object({
      status: z.number().int(),
      headerPairs: z.array(z.tuple([z.string(), z.string()])),
      body: z.string(),
    }),
    access: { sensitivity: "write" },
    authority: { principals: ["user", "host", "code"] },
  },
  importPrepared: {
    ...local,
    description:
      "Copy an explicitly selected frozen report prepared on the connected server into a new local review report. It is a snapshot with provenance, never an editable mirror or automatic submission.",
    args: z.tuple([
      z
        .object({
          reportId: id,
          revision: z.number().int().positive(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
    returns: report,
    access: { sensitivity: "write" },
  },
  forConversation: {
    ...local,
    description:
      "Make a selected owned draft available where the reporting agent runs. Returns its agent-side ID and revision, preserving full narrative and evidence without embedding them in a launch prompt. Never submits or changes consent.",
    args: z.tuple([id, z.number().int().positive()]),
    returns: z.object({ reportId: id, revision: z.number().int().positive() }),
    access: { sensitivity: "write" },
  },
  collect: {
    ...local,
    description:
      "Collect explicitly selected bounded runtime or server-log evidence into a revision-checked manual draft. Partial, denied, and expired sources remain visible.",
    args: z.tuple([
      id,
      z.number().int().positive(),
      z
        .array(
          z.discriminatedUnion("source", [
            z.object({ source: z.literal("startup") }).strict(),
            z
              .object({ source: z.literal("runtime"), entity: RuntimeSupervisionEntityKeySchema })
              .strict(),
            z
              .object({ source: z.literal("server-log"), tag: z.string().max(64).optional() })
              .strict(),
          ])
        )
        .max(8),
    ]),
    returns: report,
    access: { sensitivity: "write" },
  },
  serverConsent: {
    ...local,
    description:
      "Trusted desktop UI: read this user's independent reporting choice on the connected server, whether locally or remotely hosted. The choice applies across that user's workspaces on that server. Null means there is no separate connected-server choice.",
    args: z.tuple([]),
    returns: consent.nullable(),
    access: { sensitivity: "read" },
    authority: { principals: ["user", "host", "code"] },
  },
  decideServer: {
    ...local,
    description:
      "Trusted desktop UI: explicitly change this user's independent reporting choice on the connected server, whether locally or remotely hosted. This never changes the device choice or another user's choice; agents cannot consent.",
    args: z.tuple([z.number().int().nonnegative(), z.enum(["off", "on"])]),
    returns: consent,
    access: { sensitivity: "write" },
    authority: { principals: ["user", "host", "code"] },
  },
  consent: {
    ...local,
    description: "Read this user's reporting choice for this capture installation.",
    args: z.tuple([]),
    returns: consent,
    access: { sensitivity: "read" },
  },
  decide: {
    ...local,
    description:
      "Trusted human shell/CLI only: persist automatic reporting choice. Agents cannot consent.",
    args: z.tuple([z.number().int().nonnegative(), z.enum(["off", "on"])]),
    returns: consent,
    access: { sensitivity: "write" },
    authority: { principals: ["user", "host", "code"] },
  },
  create: {
    ...local,
    description: "Create a local manual problem report. Does not send or enroll reporting.",
    args: z.tuple([ReportProblemSchema]),
    returns: report,
    access: { sensitivity: "write" },
  },
  get: {
    ...local,
    description: "Read an owned report draft.",
    args: z.tuple([id]),
    returns: report,
    access: { sensitivity: "read" },
  },
  update: {
    ...local,
    description:
      "Revision-checked replacement of a manual draft's editable content. Narrative must match the current draft; add and edit it through appendNarrative and patchNarrative. The host assigns revisions and submission IDs.",
    args: z.tuple([id, z.number().int().positive(), ReportDraftContentSchema]),
    returns: z.object({ id, revision: z.number().int() }),
    access: { sensitivity: "write" },
  },
  appendNarrative: {
    ...local,
    description:
      "Revision-checked append of narrative sections to a manual draft. The host assigns each section ID (returned in order) and records the author from the verified caller: agents write agent sections.",
    args: z.tuple([
      id,
      z.number().int().positive(),
      z.array(ReportNarrativeInputSchema).min(1).max(100),
    ]),
    returns: z.object({ id, revision: z.number().int(), sectionIds: z.array(id) }),
    access: { sensitivity: "write" },
  },
  patchNarrative: {
    ...local,
    description:
      "Revision-checked edit of one narrative section by its host-assigned ID. Omitted fields are kept; the section's ID and author never change.",
    args: z.tuple([id, z.number().int().positive(), id, ReportNarrativePatchSchema]),
    returns: z.object({ id, revision: z.number().int() }),
    access: { sensitivity: "write" },
  },
  prepare: {
    ...local,
    description:
      "Sanitize and freeze a draft revision for preview, download, and send. When sanitization changes content, the host saves the sanitized draft as the next revision and freezes that. Returns the frozen revision with its exact canonical bytes, submission ID, and digest. Never sends.",
    args: z.tuple([id, z.number().int().positive()]),
    returns: z.object({
      revision: z.number().int().positive(),
      submissionId: id,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.string(),
    }),
    access: { sensitivity: "write" },
  },
  send: {
    ...local,
    description:
      "Request submission of an exact prepared revision/digest. Agents wait for a targeted one-time human approval; denial or a changed draft sends nothing. Trusted human callers approve directly. Never changes automatic reporting consent.",
    args: z.tuple([id, z.number().int().positive(), z.string().regex(/^[a-f0-9]{64}$/)]),
    returns: z.object({ queued: z.literal(true) }),
    access: { sensitivity: "write" },
    authority: { principals: ["user", "host", "code"] },
  },
  history: {
    ...local,
    description: "Bounded owned report history; no secrets or bundle bytes.",
    args: z.tuple([]),
    returns: z.array(
      z.object({
        id: z.string().uuid(),
        revision: z.number().int().positive(),
        updated_at: z.string().datetime(),
        submissionId: z.string().uuid().nullable(),
        state: z
          .enum([
            "prepared",
            "queued",
            "sending",
            "paused",
            "cancelled",
            "expired",
            "received",
            "rejected",
          ])
          .nullable(),
        reason: z.string().nullable(),
        receipt: z.string().nullable(),
        retained: z.number().int().nullable(),
      })
    ),
    access: { sensitivity: "read" },
  },
  cancel: {
    ...local,
    description:
      "Cancel pending delivery of an owned report; accepted reports require remote deletion.",
    args: z.tuple([id]),
    returns: z.object({ cancelled: z.literal(true) }),
    access: { sensitivity: "write" },
  },
  resume: {
    ...local,
    description:
      "Trusted human shell/CLI only: resume a paused owned submission after reporting access is restored.",
    args: z.tuple([id]),
    returns: z.object({ resumed: z.literal(true) }),
    access: { sensitivity: "write" },
    authority: { principals: ["user", "host", "code"] },
  },
  retainExport: {
    ...local,
    description:
      "Trusted human: retain or release the local received export beyond its default 30-day lifetime. Does not pin remote storage.",
    args: z.tuple([id, z.boolean()]),
    returns: z.object({ retained: z.boolean() }),
    access: { sensitivity: "write" },
  },
  remoteStatus: {
    ...local,
    description:
      "Trusted human reporting history: recover an exact owned submission ID's remote status using its protected receipt secret.",
    args: z.tuple([id]),
    returns: ProblemReportReceiptSchema,
    access: { sensitivity: "write" },
  },
  deleteRemote: {
    ...local,
    description:
      "Trusted human reporting history: request deletion of an exact owned submission ID's remote content while retaining its replay-protection tombstone.",
    args: z.tuple([id]),
    returns: ProblemReportReceiptSchema,
    access: { sensitivity: "write" },
  },
  deleteLocal: {
    ...local,
    description:
      "Trusted human shell/CLI only: delete a draft or local history. Explicit acknowledgement is required when discarding receipt access.",
    args: z.tuple([id, z.boolean()]),
    returns: z.object({ deleted: z.literal(true) }),
    access: { sensitivity: "write" },
    authority: { principals: ["user", "host", "code"] },
  },
});
