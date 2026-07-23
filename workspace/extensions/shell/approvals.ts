import { createHash } from "node:crypto";
import type { UserlandApprovalRequest } from "@vibestudio/extension";

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

export function buildExecApproval(req: {
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
}): UserlandApprovalRequest {
  const argv = [req.command, ...req.args];
  const command = argv.map(shellQuoteForDisplay).join(" ");
  return {
    subject: {
      id: `user.exec.${digest([req.command, ...req.args, req.cwd, req.shell ? "sh" : "argv"])}`,
      label: subjectLabel(command),
    },
    title: "Run a command",
    summary: summaryValue(["Run this command:", "", markdownShellBlock(command)].join("\n")),
    warning: req.shell ? "Runs as a shell command. Special characters like |, &, and * have meaning and will be acted on." : undefined,
    details: [
      { label: "Command", value: detailValue(markdownShellBlock(command)), format: "markdown" },
      { label: "Folder", value: detailValue(req.cwd) },
    ],
    options,
  };
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
    summary: summaryValue([
      req.label ? `Open ${req.label} running:` : "Open a terminal running:",
      "",
      markdownShellBlock(command),
    ].join("\n")),
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
    details: [
      { label: "Project area", value: detailValue(req.contextId) },
    ],
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
  positiveEvidence?: Array<{ label: string; value: string; format?: "plain" | "markdown" | "code" }>;
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
