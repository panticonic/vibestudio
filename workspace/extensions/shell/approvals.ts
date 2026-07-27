import { createHash } from "node:crypto";
import type { UserlandApprovalRequest } from "@vibestudio/extension";
import type { ExecIntent, SealedExecPlan } from "./types.js";

const options = [
  { value: "allow", label: "Allow", tone: "primary" as const },
  { value: "deny", label: "Deny", tone: "danger" as const },
];

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

function subjectLabel(value: string): string {
  return truncate(value, 80);
}

function detailValue(value: string): string {
  return truncate(value, 1000);
}

function summaryValue(value: string): string {
  return truncate(value, 1000);
}

function digest(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex").slice(0, 48);
}

export interface ExecApprovalEnvironment {
  /** Exact environment passed to spawn, captured before approval. */
  effective: Record<string, string>;
  /** Caller-authored entries that survived the shell's environment policy. */
  overrides: Record<string, string>;
  /** Visible identity for the exact inherited values captured in effective. */
  profile: SealedExecPlan["environment"]["profile"];
}

export function buildExecPlan(req: {
  intent: ExecIntent;
  cwd: string;
  environment: ExecApprovalEnvironment;
  timeoutMs: number;
  stdin?: string;
  maxOutputBytes: number;
}): SealedExecPlan {
  return {
    version: 1,
    intent: req.intent,
    cwd: req.cwd,
    environment: {
      profile: req.environment.profile,
      effective: sortedEntries(req.environment.effective),
      overrides: sortedEntries(req.environment.overrides),
    },
    timeoutMs: req.timeoutMs,
    ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
    maxOutputBytes: req.maxOutputBytes,
  };
}

export function serializeExecPlan(plan: SealedExecPlan): string {
  return JSON.stringify(plan, null, 2);
}

export function execPlanDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function buildExecApproval(plan: SealedExecPlan): UserlandApprovalRequest {
  const presentation = presentExecIntent(plan.intent);
  const content = serializeExecPlan(plan);
  const planDigest = execPlanDigest(content);
  const overrideEntries = plan.environment.overrides;
  return {
    subject: {
      id: `user.exec.${planDigest.slice(0, 48)}`,
      label: subjectLabel(presentation.label),
    },
    title: "Run a command",
    summary: summaryValue(["Run this command:", "", presentation.summary].join("\n")),
    warning:
      plan.intent.kind === "script"
        ? "Runs the complete sealed script with /bin/sh. Shell operators and expansions will be acted on."
        : undefined,
    details: [
      {
        label: "Plan digest",
        value: `sha256:${planDigest}`,
        format: "code",
      },
      { label: "Folder", value: detailValue(plan.cwd) },
      {
        label: "Environment profile",
        value: `${plan.environment.profile.label} · ${plan.environment.profile.id} · revision ${plan.environment.profile.revision}`,
        format: "code",
      },
      ...(overrideEntries.length > 0
        ? [
            {
              label: "Overrides preview",
              value: detailValue(renderEnvironment(overrideEntries)),
              format: "code" as const,
            },
          ]
        : []),
    ],
    sealedDetails: [{ label: "Complete execution plan", content, format: "code" }],
    options,
  };
}

function sortedEntries(values: Record<string, string>): Array<[string, string]> {
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
}

function presentExecIntent(intent: ExecIntent): {
  label: string;
  summary: string;
} {
  if (intent.kind === "script") {
    const visibleScript = visibleControlCharacters(intent.script);
    return {
      label: singleLine(`/bin/sh script: ${visibleScript}`),
      summary: markdownShellBlock(visibleScript),
    };
  }
  const argv = [intent.executable, ...intent.args];
  const command = argv.map(shellQuoteForDisplay).join(" ");
  return {
    label: singleLine(visibleControlCharacters(command)),
    summary: markdownShellBlock(visibleControlCharacters(command)),
  };
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function renderEnvironment(entries: Array<[string, string]>): string {
  return entries
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join("\n");
}

function visibleControlCharacters(value: string): string {
  return value.replace(
    /[\u0000-\u0009\u000B-\u001F\u007F]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

export function buildOpenApproval(req: {
  command: string;
  args: string[];
  cwd: string;
  label?: string;
}): UserlandApprovalRequest {
  const argv = [req.command, ...req.args];
  const command = argv.map(shellQuoteForDisplay).join(" ");
  return {
    subject: {
      id: `user.open.${digest([req.command, ...req.args, req.cwd])}`,
      label: subjectLabel(req.label ?? command),
    },
    title: "Open a terminal",
    summary: summaryValue(
      [
        req.label ? `Open ${req.label} running:` : "Open a terminal running:",
        "",
        markdownShellBlock(command),
      ].join("\n")
    ),
    details: [
      { label: "Command", value: detailValue(markdownShellBlock(command)), format: "markdown" },
      { label: "Folder", value: detailValue(req.cwd) },
    ],
    options,
  };
}

export function buildContextAttachApproval(req: {
  contextId: string;
  callerId: string;
  operation: "exec" | "open";
}): UserlandApprovalRequest {
  return {
    subject: {
      id: `user.context-attach.${digest([req.contextId])}`,
      label: subjectLabel(req.contextId),
    },
    title: "Work with files from another part of your project",
    summary: summaryValue(
      `Let this ${req.operation === "exec" ? "command" : "terminal"} access files in ${req.contextId}.`
    ),
    details: [{ label: "Project area", value: detailValue(req.contextId) }],
    warning: "The command will be able to read and change files from that part of your project.",
    defaultAction: "deny",
    promptOptions: "scoped",
  };
}

function markdownShellBlock(value: string): string {
  return `\`\`\`sh\n${truncate(value, 500).replace(/```/g, "'''")}\n\`\`\``;
}

function shellQuoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildUrlOpenApproval(req: { url: string }): UserlandApprovalRequest {
  const parsed = new URL(req.url);
  return {
    subject: {
      id: `user.open-url.${digest([parsed.origin])}`,
      label: subjectLabel(parsed.origin),
    },
    title: "Open a link",
    summary: summaryValue(`Open this in your browser:\n${req.url}`),
    details: [
      { label: "Address", value: detailValue(req.url) },
      { label: "Site", value: detailValue(parsed.origin) },
    ],
    options,
  };
}

export function buildDangerousActionApproval(req: {
  idParts: string[];
  label: string;
  title: string;
  summary?: string;
  warning?: string;
  details?: Array<{ label: string; value: string; format?: "plain" | "markdown" | "code" }>;
  positiveEvidence?: Array<{
    label: string;
    value: string;
    format?: "plain" | "markdown" | "code";
  }>;
}): UserlandApprovalRequest {
  return {
    subject: {
      id: `user.danger.${digest(req.idParts)}`,
      label: subjectLabel(req.label),
    },
    title: req.title,
    summary: req.summary ? summaryValue(req.summary) : undefined,
    warning: req.warning ? detailValue(req.warning) : undefined,
    details: req.details?.map((detail) => ({
      label: detail.label,
      value: detailValue(detail.value),
      ...(detail.format ? { format: detail.format } : {}),
    })),
    positiveEvidence: req.positiveEvidence?.map((detail) => ({
      label: detail.label,
      value: detailValue(detail.value),
      ...(detail.format ? { format: detail.format } : {}),
    })),
    severity: "dangerous",
    defaultAction: "deny",
    promptOptions: "scoped",
  };
}
