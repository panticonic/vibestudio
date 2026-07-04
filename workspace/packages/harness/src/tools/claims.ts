/**
 * Knowledge-capture tools (§8 / C2) — the standalone claim surface that rides
 * alongside the commit tool's `claims:`. Each tool calls ONE gad-store DO
 * knowledge @rpc (`knowledgeRecordClaim` / `knowledgeRelateClaims` /
 * `knowledgeReviseClaim` / `knowledgeRetractClaim`) on the agent's OWN
 * trajectory (logId/head). The DO does the durable ledger write AND appends the
 * `knowledge.*` causality event itself — so a claim is not one of the tool's own
 * `invocation.completed` outcomes (the tool→trajectory emit runs DO-side, out of
 * band). Claim content NEVER travels through `vcsService` (strict §8 layering).
 *
 * Dedup-on-write is a soft signal: `record_claim` returns near-duplicate
 * candidates WITHOUT recording (unless `force`) so the agent revises/relates
 * instead of forking a near-identical node — it never blocks anything.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";

/** A record_claim / commit-`claims:` payload (one node's content). Provide
 *  `text` OR the `subject`/`predicate`/`object` triple; `kind` is a free label
 *  (invariant | ownership | gotcha | decision | …). */
export interface ClaimPayload {
  text?: string | null;
  subject?: string | null;
  predicate?: string | null;
  object?: string | null;
  kind?: string | null;
}

/** One FTS near-duplicate surfaced by the dedup-on-write probe. */
export interface ClaimDuplicate {
  claimId: string;
  text: string;
  score: number;
}

export interface RecordClaimResult {
  /** Absent when a near-duplicate blocked the write (`!force`). */
  claimId?: string;
  ledgerEntryId?: string;
  duplicates: ClaimDuplicate[];
}

/** The four gad-store DO knowledge @rpc methods + the agent's trajectory
 *  identity (logId === head for the loop). The tools inject logId/head and the
 *  authoring `invocationId` (toolCallId) into every call. */
export interface KnowledgeToolDeps {
  recordClaim(input: {
    logId: string;
    head: string;
    invocationId?: string | null;
    claim: ClaimPayload;
    anchor?: { commitEventId?: string | null; repoPath?: string | null } | null;
    force?: boolean | null;
  }): Promise<RecordClaimResult>;
  relateClaims(input: {
    logId: string;
    head: string;
    invocationId?: string | null;
    relations: Array<{ src: string; relation: string; dst: string; weight?: number | null }>;
  }): Promise<{ ledgerEntryId: string; related: number }>;
  reviseClaim(input: {
    logId: string;
    head: string;
    invocationId?: string | null;
    claimId: string;
    patch: ClaimPayload;
  }): Promise<{ claimId: string; ledgerEntryId: string }>;
  retractClaim(input: {
    logId: string;
    head: string;
    invocationId?: string | null;
    claimId: string;
  }): Promise<{ claimId: string; ledgerEntryId: string }>;
  /** The agent's own trajectory branch — where the `knowledge.*` events land.
   *  logId === head for the loop (distinct from the vcs `ctx:*` head). */
  logId: string;
  head: string;
}

/** A rendered claim handle is `claim#<id>`; the raw claim id is what the RPC
 *  wants. Accept either form (the agent copies the handle) and strip the
 *  prefix. */
export function stripClaimHandle(value: unknown): string {
  const trimmed = String(value ?? "").trim();
  return trimmed.startsWith("claim#") ? trimmed.slice("claim#".length) : trimmed;
}

function truncate(text: string, max = 80): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** One line per near-duplicate — the agent revises/relates or forces. Shared by
 *  `record_claim` and the commit tool's `claims:` path. */
export function formatDuplicates(duplicates: ClaimDuplicate[]): string[] {
  return duplicates.map(
    (d) => `  · claim#${d.claimId} (${d.score.toFixed(2)}) "${truncate(d.text)}"`
  );
}

const recordClaimSchema = Type.Object(
  {
    text: Type.Optional(
      Type.String({
        description:
          "The claim as one durable sentence (an invariant, ownership boundary, gotcha, or decision + reason). Provide this OR subject/predicate/object.",
      })
    ),
    subject: Type.Optional(Type.String({ description: "Structured claim subject (with predicate/object)." })),
    predicate: Type.Optional(Type.String({ description: "Structured claim predicate." })),
    object: Type.Optional(Type.String({ description: "Structured claim object." })),
    kind: Type.Optional(
      Type.String({ description: "Optional claim kind label: invariant | ownership | gotcha | decision | …" })
    ),
    force: Type.Optional(
      Type.Boolean({
        description:
          "Record even when a near-duplicate exists (default false). Prefer revise_claim/relate_claims over a forced second copy — fragmented memory is weaker than one claim that accretes.",
      })
    ),
  },
  { additionalProperties: false }
);

export type RecordClaimInput = Static<typeof recordClaimSchema>;

export interface RecordClaimDetails {
  claimId?: string;
  ledgerEntryId?: string;
  duplicates: number;
  recorded: boolean;
}

export function createRecordClaimTool(
  deps: KnowledgeToolDeps
): AgentTool<typeof recordClaimSchema, RecordClaimDetails> {
  return {
    name: "record_claim",
    label: "record_claim",
    description:
      "Record a durable insight (invariant, ownership boundary, gotcha, decision+reason) as a claim on your trajectory. Prefer folding claims into commit `claims:`; use this when insight lands mid-task and won't keep. Dedup: a near-duplicate comes back as candidates WITHOUT recording — revise_claim/relate_claims instead, or pass force:true.",
    parameters: recordClaimSchema,
    execute: async (toolCallId, input): Promise<AgentToolResult<RecordClaimDetails>> => {
      const claim: ClaimPayload = {
        ...(typeof input.text === "string" ? { text: input.text } : {}),
        ...(typeof input.subject === "string" ? { subject: input.subject } : {}),
        ...(typeof input.predicate === "string" ? { predicate: input.predicate } : {}),
        ...(typeof input.object === "string" ? { object: input.object } : {}),
        ...(typeof input.kind === "string" ? { kind: input.kind } : {}),
      };
      const result = await deps.recordClaim({
        logId: deps.logId,
        head: deps.head,
        invocationId: toolCallId || null,
        claim,
        force: input.force === true,
      });
      if (!result.claimId) {
        // Blocked by dedup — surface candidates, never record a second copy.
        const lines = [
          "Not recorded — near-duplicate of an existing claim:",
          ...formatDuplicates(result.duplicates),
          "Revise or relate one of these, or call record_claim again with force:true.",
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { duplicates: result.duplicates.length, recorded: false },
        };
      }
      const lines = [`Recorded claim#${result.claimId}.`];
      if (result.duplicates.length > 0) {
        lines.push("Similar existing claims (consider relating them):", ...formatDuplicates(result.duplicates));
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          claimId: result.claimId,
          ...(result.ledgerEntryId ? { ledgerEntryId: result.ledgerEntryId } : {}),
          duplicates: result.duplicates.length,
          recorded: true,
        },
      };
    },
  };
}

const relateClaimsSchema = Type.Object(
  {
    src: Type.String({ description: "Source claim (claim#<id> or the bare id)." }),
    // An explicit literal tuple (NOT a mapped array) so TypeBox `Static` infers
    // the union rather than collapsing the field to `undefined`.
    relation: Type.Union(
      [
        Type.Literal("supports"),
        Type.Literal("contradicts"),
        Type.Literal("about"),
        Type.Literal("refines"),
        Type.Literal("depends_on"),
      ],
      {
        description:
          "How src relates to dst: supports | contradicts | about | refines | depends_on. Relations are agent-asserted — a 'contradicts' is what the read attachment surfaces as ⚠.",
      }
    ),
    dst: Type.String({ description: "Destination claim (claim#<id> or the bare id)." }),
    weight: Type.Optional(Type.Number({ description: "Optional relation weight." })),
  },
  { additionalProperties: false }
);

export type RelateClaimsInput = Static<typeof relateClaimsSchema>;

export interface RelateClaimsDetails {
  ledgerEntryId: string;
  related: number;
}

export function createRelateClaimsTool(
  deps: KnowledgeToolDeps
): AgentTool<typeof relateClaimsSchema, RelateClaimsDetails> {
  return {
    name: "relate_claims",
    label: "relate_claims",
    description:
      "Assert a relation between two claims (supports | contradicts | about | refines | depends_on). Relations are never auto-detected — this is how a contradiction becomes the ⚠ line future reads see. Use it to reconcile near-duplicates instead of recording a second claim.",
    parameters: relateClaimsSchema,
    execute: async (toolCallId, input): Promise<AgentToolResult<RelateClaimsDetails>> => {
      const src = stripClaimHandle(input.src);
      const dst = stripClaimHandle(input.dst);
      const relation = String(input.relation ?? "");
      if (!src || !dst) throw new Error("relate_claims requires src and dst claim ids");
      const result = await deps.relateClaims({
        logId: deps.logId,
        head: deps.head,
        invocationId: toolCallId || null,
        relations: [
          {
            src,
            relation,
            dst,
            ...(typeof input.weight === "number" ? { weight: input.weight } : {}),
          },
        ],
      });
      return {
        content: [{ type: "text", text: `Related claim#${src} ·${relation}· claim#${dst}.` }],
        details: { ledgerEntryId: result.ledgerEntryId, related: result.related },
      };
    },
  };
}

const reviseClaimSchema = Type.Object(
  {
    claimId: Type.String({ description: "The claim to revise (claim#<id> or the bare id)." }),
    text: Type.Optional(Type.String({ description: "New claim text (replaces the sentence)." })),
    subject: Type.Optional(Type.String({ description: "New structured subject." })),
    predicate: Type.Optional(Type.String({ description: "New structured predicate." })),
    object: Type.Optional(Type.String({ description: "New structured object." })),
    kind: Type.Optional(Type.String({ description: "New claim kind label." })),
  },
  { additionalProperties: false }
);

export type ReviseClaimInput = Static<typeof reviseClaimSchema>;

export interface ReviseClaimDetails {
  claimId: string;
  ledgerEntryId: string;
}

export function createReviseClaimTool(
  deps: KnowledgeToolDeps
): AgentTool<typeof reviseClaimSchema, ReviseClaimDetails> {
  return {
    name: "revise_claim",
    label: "revise_claim",
    description:
      "Revise an existing claim in place (a claim accretes rather than fragmenting). Pass only the fields that change. Prefer this over recording a near-duplicate.",
    parameters: reviseClaimSchema,
    execute: async (toolCallId, input): Promise<AgentToolResult<ReviseClaimDetails>> => {
      const claimId = stripClaimHandle(input.claimId);
      if (!claimId) throw new Error("revise_claim requires a claimId");
      const patch: ClaimPayload = {
        ...(typeof input.text === "string" ? { text: input.text } : {}),
        ...(typeof input.subject === "string" ? { subject: input.subject } : {}),
        ...(typeof input.predicate === "string" ? { predicate: input.predicate } : {}),
        ...(typeof input.object === "string" ? { object: input.object } : {}),
        ...(typeof input.kind === "string" ? { kind: input.kind } : {}),
      };
      const result = await deps.reviseClaim({
        logId: deps.logId,
        head: deps.head,
        invocationId: toolCallId || null,
        claimId,
        patch,
      });
      return {
        content: [{ type: "text", text: `Revised claim#${result.claimId}.` }],
        details: { claimId: result.claimId, ledgerEntryId: result.ledgerEntryId },
      };
    },
  };
}

const retractClaimSchema = Type.Object(
  { claimId: Type.String({ description: "The claim to retract (claim#<id> or the bare id)." }) },
  { additionalProperties: false }
);

export type RetractClaimInput = Static<typeof retractClaimSchema>;

export interface RetractClaimDetails {
  claimId: string;
  ledgerEntryId: string;
}

export function createRetractClaimTool(
  deps: KnowledgeToolDeps
): AgentTool<typeof retractClaimSchema, RetractClaimDetails> {
  return {
    name: "retract_claim",
    label: "retract_claim",
    description:
      "Retract a claim that is no longer true (the ledger keeps the history; the claim stops surfacing in provenance).",
    parameters: retractClaimSchema,
    execute: async (toolCallId, input): Promise<AgentToolResult<RetractClaimDetails>> => {
      const claimId = stripClaimHandle(input.claimId);
      if (!claimId) throw new Error("retract_claim requires a claimId");
      const result = await deps.retractClaim({
        logId: deps.logId,
        head: deps.head,
        invocationId: toolCallId || null,
        claimId,
      });
      return {
        content: [{ type: "text", text: `Retracted claim#${result.claimId}.` }],
        details: { claimId: result.claimId, ledgerEntryId: result.ledgerEntryId },
      };
    },
  };
}
