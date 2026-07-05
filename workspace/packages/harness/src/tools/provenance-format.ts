/**
 * Shared renderer for the §7.5 provenance block — used by BOTH the read-time
 * attachment (appended after file content) and the `provenance` drill-down tool.
 *
 * The gad-store DO does all the semantic work: each `ProvItem.line` is already a
 * fully-rendered `insight + handle` line (exception marker `⚠`, `→ provenance(…)`
 * follow-on handles, density dots — see the DO's `renderDensityItem` /
 * `fileExceptionItems`). This module only frames those verbatim lines with the
 * `prov · <label> · K of M items` header and the `+N more → provenance(…)` tail
 * (§7.1: the low-ranked tail is withheld but advertised).
 */

import type { VcsProvItem } from "@vibestudio/shared/serviceSchemas/vcs";

export interface ProvenanceBlockInput {
  /** Header label + drill handle target — the workspace-relative path, a
   *  `claim#<id>`, a `commit:<id>`, or `session`. `provenance("<label>")` must
   *  re-resolve it, so pass the canonical (workspace-relative) form. */
  label: string;
  items: VcsProvItem[];
  shown: number;
  total: number;
  /** Present when a ranked tail remains (DO sets it iff more items follow). */
  nextCursor?: string | undefined;
  /** When paging/drilling, thread the cursor into the advertised follow-on so
   *  the agent can fetch the NEXT page; the read attachment omits it (the agent
   *  drills page one with a bare `provenance("<path>")`). */
  pageable?: boolean;
}

/** Render the block, or `null` when there is nothing worth pushing (no items).
 *  Silence preserves salience (§7): an empty block is never emitted. */
export function renderProvenanceBlock(input: ProvenanceBlockInput): string | null {
  if (input.items.length === 0) return null;
  const lines: string[] = [`prov · ${input.label} · ${input.shown} of ${input.total} items`];
  for (const item of input.items) {
    lines.push(`● ${item.line}`);
  }
  if (input.nextCursor !== undefined) {
    const remaining = Math.max(0, input.total - Number(input.nextCursor));
    if (remaining > 0) {
      const handle = input.pageable
        ? `provenance("${input.label}", after "${input.nextCursor}")`
        : `provenance("${input.label}")`;
      lines.push(`  +${remaining} more → ${handle}`);
    }
  }
  return lines.join("\n");
}
