import { createHash } from "node:crypto";
import type { UserlandApprovalRequest } from "@vibestudio/extension";
import type { ExecIntent, SealedExecPlan } from "./types.js";

const options = [
  { value: "allow", label: "Allow", tone: "primary" as const },
  { value: "deny", label: "Deny", tone: "danger" as const },
];

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
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
  const inputSummary =
    plan.stdin === undefined
      ? "No standard input."
      : `Standard input: ${Buffer.byteLength(plan.stdin, "utf8").toLocaleString()} bytes · sha256:${execPlanDigest(plan.stdin)}`;
  const authorityDigest = execAuthorityDigest(plan);
  return {
    subject: {
      id: `user.exec.${authorityDigest.slice(0, 48)}`,
      label: subjectLabel(presentation.label),
    },
    title: "Run a command",
    summary: summaryValue(["Run this command:", inputSummary, "", presentation.summary].join("\n")),
    warning:
      plan.intent.kind === "script"
        ? "Runs the sealed script with /bin/sh. Shell operators and expansions will be acted on."
        : plan.stdin !== undefined
          ? "The command will receive sealed standard input. Reveal it before approving if its contents are unfamiliar."
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
              label: "Environment overrides",
              value: detailValue(
                `${overrideEntries.map(([key]) => key).join(", ")} · values sealed, not displayed`
              ),
              format: "code" as const,
            },
          ]
        : []),
      ...(plan.stdin !== undefined
        ? [
            {
              label: "Standard input",
              value: `${Buffer.byteLength(plan.stdin, "utf8").toLocaleString()} bytes · sha256:${execPlanDigest(plan.stdin)} · reveal on demand`,
              format: "code" as const,
            },
          ]
        : []),
    ],
    sealedDetails: [
      {
        label: "Command and input",
        content: buildExecReviewProjection(plan),
        format: "code",
        disclosure: "review",
      },
      {
        label: "Exact execution seal",
        content,
        format: "code",
        disclosure: "sealed-only",
      },
    ],
    options,
  };
}

/**
 * Reusable authority follows behavior-changing inputs, not transient resource
 * limits or a snapshot of the inherited host environment. The exact snapshot
 * remains sealed per invocation and is what execution consumes.
 */
function execAuthorityDigest(plan: SealedExecPlan): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        intent: plan.intent,
        cwd: plan.cwd,
        environmentProfile: plan.environment.profile.id,
        overrides: plan.environment.overrides,
        ...(plan.stdin !== undefined ? { stdin: plan.stdin } : {}),
      }),
      "utf8"
    )
    .digest("hex");
}

function buildExecReviewProjection(plan: SealedExecPlan): string {
  const intent = boundedReviewText(
    plan.intent.kind === "script"
      ? `Script executed by /bin/sh:\n${plan.intent.script}`
      : `Direct argv execution (no shell):\n${[plan.intent.executable, ...plan.intent.args]
          .map((value) => JSON.stringify(value))
          .join("\n")}`,
    56 * 1024
  );
  const stdin =
    plan.stdin === undefined
      ? "Standard input: none"
      : boundedReviewText(
          [
            `Standard input (${Buffer.byteLength(plan.stdin, "utf8")} bytes, may contain sensitive data):`,
            plan.stdin,
          ].join("\n"),
          32 * 1024
        );
  const context = [
    `Working folder: ${plan.cwd}`,
    `Environment profile: ${plan.environment.profile.label} (${plan.environment.profile.id})`,
    `Environment override names: ${
      plan.environment.overrides.map(([key]) => key).join(", ") || "none"
    }`,
    "Environment values are bound into the exact seal but intentionally not displayed.",
    `Timeout: ${plan.timeoutMs} ms`,
    `Maximum captured output: ${plan.maxOutputBytes} bytes`,
  ].join("\n");
  return [intent, stdin, context].join("\n\n");
}

function boundedReviewText(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  const notice =
    "\n\n… content omitted from the interactive review …\n" +
    "For very large programs, execute a content-addressed or otherwise reviewed immutable file.\n\n";
  const noticeBytes = Buffer.byteLength(notice, "utf8");
  const remaining = maxBytes - noticeBytes;
  const tailBytes = Math.min(16 * 1024, Math.floor(remaining / 3));
  return `${encoded.subarray(0, remaining - tailBytes).toString("utf8")}${notice}${encoded
    .subarray(encoded.byteLength - tailBytes)
    .toString("utf8")}`;
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
  const truncated = value.length > 500;
  const preview = truncate(value, 500).replace(/```/g, "'''");
  return `\`\`\`sh\n${preview}\n\`\`\`${
    truncated ? "\nPreview truncated — inspect command and input for the reviewed projection." : ""
  }`;
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
