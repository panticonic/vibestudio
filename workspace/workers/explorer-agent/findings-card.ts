import type { MessageTypeSpec } from "@workspace/agentic-do";

/**
 * Findings card — the custom chat message the explorer's `report_finding` tool
 * aggregates a run's findings into. The worker is the source of truth (a SQLite
 * table); both the durable findings file and this card are rebuilt from it, so
 * they never drift. The renderer lives at {@link FINDINGS_RENDERER_PATH}.
 */

export type FindingClass = "BUG" | "DOC-MISMATCH" | "SURPRISING";
export type FindingSeverity = "low" | "medium" | "high";

/** The compact per-finding row shown on the card (detail lives in the file). */
export interface FindingEntry {
  id: string;
  ts: string;
  cls: FindingClass;
  surface: string;
  title: string;
  severity: FindingSeverity;
}

/** Full finding as reported — drives the file section; the card shows a subset. */
export interface FindingDetail extends FindingEntry {
  expected: string;
  actual: string;
  repro?: string;
}

export interface FindingsCardState {
  runId: string;
  updatedAt: string;
  filePath: string;
  total: number;
  counts: Record<FindingClass, number>;
  /** Most-recent-first, capped to {@link FINDINGS_CARD_CAP}. */
  findings: FindingEntry[];
}

export const FINDINGS_TYPE_ID = "explorer.findings";
export const FINDINGS_RENDERER_PATH = "workers/explorer-agent/renderers/findings.tsx";
export const FINDINGS_UI_INSTALL_VERSION = 1;
export const FINDINGS_KEY_PREFIX = "explorer";
export const FINDINGS_CARD_CAP = 25;

export const FINDINGS_UI_IMPORTS: Record<string, string> = {
  react: "latest",
  "@radix-ui/themes": "npm:^3.2.1",
  "@radix-ui/react-icons": "npm:^1.3.2",
};

const CLASS_ENUM = ["BUG", "DOC-MISMATCH", "SURPRISING"];
const SEVERITY_ENUM = ["low", "medium", "high"];

export const FINDINGS_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    runId: { type: "string" },
    updatedAt: { type: "string" },
    filePath: { type: "string" },
    total: { type: "number" },
    counts: { type: "object" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          ts: { type: "string" },
          cls: { type: "string", enum: CLASS_ENUM },
          surface: { type: "string" },
          title: { type: "string" },
          severity: { type: "string", enum: SEVERITY_ENUM },
        },
        required: ["id", "cls", "surface", "title", "severity"],
      },
    },
  },
  required: ["runId", "total", "findings"],
};

export const FINDINGS_MESSAGE_TYPES: MessageTypeSpec[] = [
  {
    typeId: FINDINGS_TYPE_ID,
    displayMode: "inline",
    path: FINDINGS_RENDERER_PATH,
    stateSchema: FINDINGS_STATE_SCHEMA,
  },
];

/** Stable per-run card identity — one card per run, updated in place. */
export function findingsCardKey(runId: string): string {
  return `explorer:findings:${runId}`;
}

/** Sanitize a caller-supplied runId into a safe path segment. */
export function findingsFilePath(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  return `projects/explorer/findings/${safe}.md`;
}

export function buildCardState(
  runId: string,
  filePath: string,
  rows: FindingEntry[],
  updatedAt: string
): FindingsCardState {
  const counts: Record<FindingClass, number> = { BUG: 0, "DOC-MISMATCH": 0, SURPRISING: 0 };
  for (const row of rows) counts[row.cls] = (counts[row.cls] ?? 0) + 1;
  const findings = [...rows].reverse().slice(0, FINDINGS_CARD_CAP);
  return { runId, updatedAt, filePath, total: rows.length, counts, findings };
}

/** Rebuild the whole findings file markdown from all rows of a run. */
export function renderFindingsFile(runId: string, rows: FindingDetail[]): string {
  const out: string[] = [
    `# Explorer findings — ${runId}`,
    "",
    "Per-run findings log written by the explorer agent (one section per finding).",
  ];
  for (const f of rows) {
    out.push(
      "",
      `## [${f.cls}] ${f.title}`,
      "",
      `- **id:** ${f.id}`,
      `- **at:** ${f.ts}`,
      `- **surface:** \`${f.surface}\``,
      `- **severity:** ${f.severity}`,
      "",
      `**Expected:** ${f.expected}`,
      "",
      `**Actual:** ${f.actual}`
    );
    if (f.repro && f.repro.trim().length > 0) out.push("", "**Repro:**", "", f.repro.trim());
    out.push("", "---");
  }
  return out.join("\n") + "\n";
}
