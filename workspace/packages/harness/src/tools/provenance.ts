/**
 * `provenance` tool — the §7.1 drill-down / paging surface over the gad-store
 * DO's provenance pipeline. Read-only; the per-file read attachment (read.ts)
 * is the PUSH surface, this is the PULL one the agent reaches for by handle.
 *
 * Target grammar (from the handles the attachment renders):
 *   · "<path>" / "file:<path>" → provenanceForFile (deep, skipSuppression) — the
 *      full ranked tail for one file, paged unbounded via `after`.
 *   · "claim#<id>"             → provenanceForClaim — the claim neighborhood
 *      (relations, anchoring commit, touching sessions); writes a `cited` touch.
 *   · "session" / "session:*"  → provenanceForSession — §7.6 orientation over the
 *      whole session touch-set (exceptions first, then density).
 *   · "commit:<id>"            → no dedicated DO endpoint; see below.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type {
  VcsProvenanceForFileResult,
  VcsProvenanceForSessionResult,
} from "@vibestudio/service-schemas/vcs";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import { toVcsPath } from "./tool-vcs.js";
import { renderProvenanceBlock } from "./provenance-format.js";

const provenanceSchema = Type.Object({
  target: Type.Optional(Type.String({
    description:
      'What to trace (default: "session"): a file path ("packages/x/y.ts"), a claim ("claim#42"), a commit ("commit:9f2e"), or "session" for whole-session orientation. Use the handles the read attachment renders.',
  })),
  after: Type.Optional(
    Type.String({
      description: "Paging cursor from a prior result's `nextCursor` — fetch the next page.",
    })
  ),
});

export type ProvenanceToolInput = Static<typeof provenanceSchema>;

export interface ProvenanceToolDetails {
  target: string;
  shown: number;
  total: number;
  nextCursor?: string;
}

/** The gad-store DO provenance surface + session identity threaded into the
 *  tool (mirrors {@link ReadProvenanceDeps} but with the drill-down methods). */
export interface ProvenanceToolDeps {
  provenanceForFile(input: {
    repoPath: string;
    path: string;
    head: string;
    tier: "none" | "moderate" | "deep";
    sessionLogId: string;
    sessionHead: string;
    invocationId?: string | null;
    after?: string | null;
    skipSuppression?: boolean | null;
  }): Promise<VcsProvenanceForFileResult>;
  provenanceForClaim(input: {
    claimId: string;
    sessionLogId: string;
    sessionHead: string;
    invocationId?: string | null;
    after?: string | null;
  }): Promise<VcsProvenanceForFileResult>;
  provenanceForSession(input: {
    sessionLogId: string;
    sessionHead: string;
    after?: string | null;
  }): Promise<VcsProvenanceForSessionResult>;
  /** The vcs head where file targets resolve (`ctx:<contextId>`), resolved lazily. */
  head: string | (() => string);
  sessionLogId: string;
  sessionHead: string;
}

function textResult(
  text: string,
  details: ProvenanceToolDetails
): { content: [{ type: "text"; text: string }]; details: ProvenanceToolDetails } {
  return { content: [{ type: "text", text }], details };
}

export function createProvenanceTool(
  cwd: string,
  deps: ProvenanceToolDeps
): AgentTool<typeof provenanceSchema, ProvenanceToolDetails> {
  return {
    name: "provenance",
    label: "provenance",
    description:
      'Trace provenance by handle: pass a file path, "claim#<id>", "commit:<id>", or "session" (whole-session orientation — what to know before you act). Returns the ranked items with follow-on handles; page the tail with `after`.',
    parameters: provenanceSchema,
    execute: async (toolCallId, input) => {
      const target = String(input.target ?? "session").trim() || "session";
      const after = typeof input.after === "string" && input.after.length > 0 ? input.after : null;

      const render = (
        label: string,
        result: {
          items: VcsProvenanceForFileResult["items"];
          shown: number;
          total: number;
          nextCursor?: string;
        }
      ) => {
        const details: ProvenanceToolDetails = {
          target: label,
          shown: result.shown,
          total: result.total,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
        const block = renderProvenanceBlock({
          label,
          items: result.items,
          shown: result.shown,
          total: result.total,
          nextCursor: result.nextCursor,
          pageable: true,
        });
        return textResult(block ?? `prov · ${label} · no provenance items`, details);
      };

      // "session" / "session:<head>" — whole-session orientation (§7.6). A
      // `session:<head>` handle names another session, but the DO orients over
      // the CALLER's touch-set, so both forms orient the current session.
      if (target === "session" || target.startsWith("session:")) {
        const result = await deps.provenanceForSession({
          sessionLogId: deps.sessionLogId,
          sessionHead: deps.sessionHead,
          after,
        });
        return render("session", result);
      }

      // "claim#<id>" — claim drill-down (writes a `cited` touch DO-side).
      if (target.startsWith("claim#")) {
        const claimId = target.slice("claim#".length);
        if (!claimId) throw new Error("provenance claim target requires an id (claim#<id>)");
        const result = await deps.provenanceForClaim({
          claimId,
          sessionLogId: deps.sessionLogId,
          sessionHead: deps.sessionHead,
          invocationId: toolCallId || null,
          after,
        });
        return render(`claim#${claimId}`, result);
      }

      // "commit:<id>" — no dedicated drill endpoint exists. Commit provenance is
      // reachable through the files a commit touched or gad.query; point there
      // rather than fail, so a rendered commit handle is never a dead end.
      if (target.startsWith("commit:")) {
        return textResult(
          `commit provenance is not independently drillable — read a file the commit touched (with provenance:"deep") or use gad.query on the commit event.`,
          { target, shown: 0, total: 0 }
        );
      }

      // Otherwise a file path (bare or "file:<path>").
      const rawPath = target.startsWith("file:") ? target.slice("file:".length) : target;
      let vcsPath: string;
      try {
        vcsPath = toVcsPath(rawPath, cwd);
      } catch {
        return textResult(`provenance: ${rawPath} escapes the workspace root`, {
          target,
          shown: 0,
          total: 0,
        });
      }
      const repo = splitRepoPath(vcsPath);
      if (!repo) {
        return textResult(`provenance: ${rawPath} is not inside any repo`, {
          target,
          shown: 0,
          total: 0,
        });
      }
      const head = typeof deps.head === "function" ? deps.head() : deps.head;
      if (!head || head.endsWith(":") || head.includes("undefined")) {
        return textResult(`provenance: no context head available for ${vcsPath}`, {
          target,
          shown: 0,
          total: 0,
        });
      }
      const result = await deps.provenanceForFile({
        repoPath: repo.repoPath,
        path: vcsPath,
        head,
        tier: "deep",
        sessionLogId: deps.sessionLogId,
        sessionHead: deps.sessionHead,
        invocationId: toolCallId || null,
        after,
        skipSuppression: true,
      });
      return render(vcsPath, result);
    },
  };
}
