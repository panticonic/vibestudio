/**
 * Commit tool (§8 / T4) — seals the caller's uncommitted working edits into a
 * messaged snapshot per repo via `vcs.commit`, then (optionally) records the
 * agent's durable insight as claims anchored to the commit event.
 *
 * Capture rides the commit flow because voluntary bookkeeping loses: the one
 * moment an agent reliably verbalizes "what I did and why" is the mandatory
 * commit message, so `claims:` costs zero extra tool calls at maximal clarity
 * and the claims are born linked to the commit event.
 *
 * Strict §8 layering: `vcs.commit` writes only the per-repo VCS log; claim
 * content + causality go through the agent's OWN knowledge path
 * (`knowledgeRecordClaim` → durable ledger + `knowledge.claim_recorded` on the
 * trajectory). vcsService NEVER writes claims. Dedup never blocks the commit —
 * near-duplicate candidates come back in the result for the agent to revise or
 * relate on the next call. When the diff is non-trivial and no claims were
 * passed, the result carries a one-line nudge.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import { withInvocationId, type ToolVcs } from "./tool-vcs.js";
import { formatDuplicates, type ClaimPayload, type KnowledgeToolDeps } from "./claims.js";

/** Nudge when the diff is non-trivial and no claims were passed (T4). "Files"
 *  is exact (distinct committed paths); the design's "≥50 changed lines" leg is
 *  approximated by committed edit-op count — the harness commit result exposes
 *  no per-op line delta (the DO's editOps/hunks are stripped by
 *  `vcsCommitResultSchema`), and edit-op count is the only change-volume signal
 *  it does receive. */
const NUDGE_MIN_FILES = 3;
const NUDGE_MIN_EDIT_OPS = 8;
const NUDGE_LINE = 'Anything durable to record? (`claims:` on commit, or `record_claim`)';

const claimPayloadSchema = Type.Object(
  {
    text: Type.Optional(
      Type.String({ description: "The claim as one durable sentence. Provide this OR subject/predicate/object." })
    ),
    subject: Type.Optional(Type.String()),
    predicate: Type.Optional(Type.String()),
    object: Type.Optional(Type.String()),
    kind: Type.Optional(
      Type.String({ description: "Optional claim kind: invariant | ownership | gotcha | decision | …" })
    ),
  },
  { additionalProperties: false }
);

const commitSchema = Type.Object(
  {
    message: Type.String({
      description:
        "The commit message — recalled VERBATIM by future sessions touching these files. Write the one-line insight they should see, not a changelog.",
    }),
    repoPaths: Type.Optional(
      Type.Array(Type.String(), {
        description: "Repos to commit (default: every repo with uncommitted edits on your head).",
      })
    ),
    claims: Type.Optional(
      Type.Array(claimPayloadSchema, {
        description:
          "Durable insight this work taught you (invariants, ownership boundaries, gotchas, decisions + reasons), recorded as claims anchored to this commit — costs no extra tool call. Dedup candidates come back in the result; the commit stands regardless.",
      })
    ),
  },
  { additionalProperties: false }
);

export type CommitToolInput = Static<typeof commitSchema>;

export interface CommitToolDetails {
  committed: number;
  unchanged: number;
  changedFiles: number;
  editOps: number;
  claimsRecorded: string[];
  claimDuplicates: number;
  nudged: boolean;
}

/** The commit tool's claim-write dependency: the agent's `recordClaim` path +
 *  trajectory identity. A subset of {@link KnowledgeToolDeps}. Omit for agent
 *  classes without a gad-store DO — `claims:` is then accepted and ignored (the
 *  commit still runs), keeping the schema uniform across agent classes. */
export type CommitClaimsDeps = Pick<KnowledgeToolDeps, "recordClaim" | "logId" | "head">;

export function createCommitTool(
  vcs: ToolVcs,
  knowledge?: CommitClaimsDeps
): AgentTool<typeof commitSchema, CommitToolDetails> {
  return {
    name: "commit",
    label: "commit",
    description:
      "Seal your uncommitted working edits into a messaged snapshot per repo. Commit time is memory time: put durable insight in `claims:` here — it is anchored to the commit and recalled by future sessions. Does not advance main (that is push).",
    parameters: commitSchema,
    execute: async (toolCallId, input, signal): Promise<AgentToolResult<CommitToolDetails>> => {
      const message = typeof input.message === "string" ? input.message.trim() : "";
      if (!message) throw new Error("commit requires a non-empty message");
      if (signal?.aborted) throw new Error("Operation aborted");

      // T2: invocationId (the commit event's causality edge) is stamped by the
      // shared adapter seam — the tool does not hand-pass it.
      const results = await withInvocationId(vcs, toolCallId).commit({
        message,
        ...(Array.isArray(input.repoPaths) && input.repoPaths.length > 0
          ? { repoPaths: input.repoPaths }
          : {}),
      });
      if (signal?.aborted) throw new Error("Operation aborted");

      const committed = results.filter((r) => r.status === "committed");
      const unchanged = results.filter((r) => r.status === "unchanged");
      const changedFiles = new Set<string>();
      let editOps = 0;
      for (const r of committed) {
        for (const p of r.changedPaths) changedFiles.add(`${r.repoPath}/${p}`);
        editOps += r.editCount;
      }

      const lines: string[] = [];
      if (committed.length === 0) {
        lines.push("Nothing to commit — no uncommitted edits on your head.");
      } else {
        for (const r of committed) {
          lines.push(`committed ${r.repoPath} (${r.editCount} edit${r.editCount === 1 ? "" : "s"}).`);
        }
      }

      // Claims ride the commit: record each on the agent's own trajectory, anchored
      // to the commit event. Dedup surfaces candidates but never blocks the commit.
      const claimsRecorded: string[] = [];
      let claimDuplicates = 0;
      const claims = Array.isArray(input.claims) ? input.claims : [];
      const anchorResult = committed.find((r) => r.eventId);
      if (claims.length > 0 && knowledge) {
        const anchor = anchorResult
          ? { commitEventId: anchorResult.eventId, repoPath: anchorResult.repoPath }
          : undefined;
        for (const raw of claims) {
          const claim = normalizeClaim(raw);
          if (!claim) continue;
          const res = await knowledge.recordClaim({
            logId: knowledge.logId,
            head: knowledge.head,
            invocationId: toolCallId || null,
            claim,
            ...(anchor ? { anchor } : {}),
          });
          if (res.claimId) {
            claimsRecorded.push(res.claimId);
            lines.push(`recorded claim#${res.claimId}.`);
            if (res.duplicates.length > 0) {
              lines.push("  similar existing claims (consider relating):", ...formatDuplicates(res.duplicates));
            }
          } else {
            claimDuplicates += res.duplicates.length;
            lines.push("claim not recorded — near-duplicate of:", ...formatDuplicates(res.duplicates));
            lines.push("  revise/relate one of these, or record_claim(force:true).");
          }
        }
      }

      // Nudge: non-trivial diff, no claims passed. A nudge at the right moment
      // moves behavior more than a paragraph of prompt.
      const nudged =
        claims.length === 0 &&
        committed.length > 0 &&
        (changedFiles.size >= NUDGE_MIN_FILES || editOps >= NUDGE_MIN_EDIT_OPS);
      if (nudged) lines.push(NUDGE_LINE);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          committed: committed.length,
          unchanged: unchanged.length,
          changedFiles: changedFiles.size,
          editOps,
          claimsRecorded,
          claimDuplicates,
          nudged,
        },
      };
    },
  };
}

function normalizeClaim(raw: {
  text?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  kind?: string;
}): ClaimPayload | null {
  const claim: ClaimPayload = {
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
    ...(typeof raw.subject === "string" ? { subject: raw.subject } : {}),
    ...(typeof raw.predicate === "string" ? { predicate: raw.predicate } : {}),
    ...(typeof raw.object === "string" ? { object: raw.object } : {}),
    ...(typeof raw.kind === "string" ? { kind: raw.kind } : {}),
  };
  const hasContent = claim.text || (claim.subject && claim.predicate && claim.object);
  return hasContent ? claim : null;
}
