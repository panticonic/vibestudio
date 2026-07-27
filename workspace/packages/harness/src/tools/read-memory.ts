import type {
  VcsReadMemoryEpisode,
  VcsReadMemoryResult,
} from "@vibestudio/service-schemas/vcs";

type AttachedReadMemory = Extract<VcsReadMemoryResult, { status: "attached" }>;

const compact = (value: string, limit = 280): string => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
};

const quoted = (value: string): string => JSON.stringify(compact(value));

const root = (value: object): string => JSON.stringify(value);

function episodeLine(episode: VcsReadMemoryEpisode): string[] {
  const ranges = episode.ranges.map(({ start, end }) => `${start}-${end}`).join(", ");
  const semantic =
    episode.intentSummary ??
    episode.commit?.message ??
    episode.cause?.turnSummary ??
    episode.cause?.triggerText;
  const fields = [
    `● UTF-16 ${ranges}`,
    episode.stop === "import-boundary" ? "imported from outside workspace history" : "authored here",
    semantic ? `why ${quoted(semantic)}` : null,
    episode.cause?.triggerText && episode.cause.triggerText !== semantic
      ? `original request ${quoted(episode.cause.triggerText)}`
      : null,
    episode.commit?.message && episode.commit.message !== semantic
      ? `committed as ${quoted(episode.commit.message)}`
      : null,
    episode.counteractsChangeIds.length > 0
      ? `counteracts ${episode.counteractsChangeIds.join(", ")}`
      : null,
  ].filter((value): value is string => value !== null);
  const lines = [fields.join(" · ")];
  for (const decision of episode.decisions) {
    lines.push(
      `  decision ${decision.kind} ${root(decision.decision)}` +
        (decision.rationale ? ` · ${quoted(decision.rationale)}` : "")
    );
  }
  if (episode.externalSnapshot) {
    lines.push(
      `  external source ${episode.externalSnapshot.sourceKind} ${episode.externalSnapshot.sourceUri} ` +
        `@ ${episode.externalSnapshot.snapshotRevision}`
    );
  }
  lines.push(`  inspect deeper with provenance({ target: ${root(episode.change)} })`);
  return lines;
}

export function renderReadMemoryBlock(input: {
  label: string;
  startLine: number;
  endLine: number;
  result: AttachedReadMemory;
}): string | null {
  if (input.result.episodes.length === 0 && input.result.history.length === 0) return null;
  const lines = [
    `workspace memory · why ${input.label} lines ${input.startLine}-${input.endLine} exist · ` +
      `verified against this exact file content`,
  ];
  for (const episode of input.result.episodes) lines.push(...episodeLine(episode));
  if (input.result.history.length > 0) {
    lines.push("  earlier file history");
    for (const entry of input.result.history) {
      lines.push(`  - ${quoted(entry.summary)} · ${root(entry.node)}`);
    }
  }
  if (input.result.truncated) {
    lines.push("  more history exists; continue from an exact target above with provenance");
  }
  return lines.join("\n");
}
