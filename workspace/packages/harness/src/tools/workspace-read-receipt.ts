import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalizeWorkspaceFilePath } from "@vibestudio/shared/runtime/entitySpec";
import { toVcsPath } from "./tool-vcs.js";

export const WORKSPACE_READ_RECEIPT_PROTOCOL = "workspace-read-receipt.v1" as const;

export const workspaceReadReceiptSchema = Type.Object(
  {
    protocol: Type.Literal(WORKSPACE_READ_RECEIPT_PROTOCOL),
    path: Type.String({ minLength: 1 }),
    contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    byteLength: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export type WorkspaceReadReceipt = Static<typeof workspaceReadReceiptSchema>;

export function canonicalReceiptPath(path: string, cwd: string): string {
  return canonicalizeWorkspaceFilePath(toVcsPath(path, cwd));
}

export function createWorkspaceReadReceipt(
  path: string,
  contentHash: string,
  byteLength: number
): WorkspaceReadReceipt {
  return {
    protocol: WORKSPACE_READ_RECEIPT_PROTOCOL,
    path,
    contentHash,
    byteLength,
  };
}

export function assertWorkspaceReadReceipt(
  candidate: unknown,
  current: {
    path: string;
    contentHash?: string;
    byteLength?: number;
    text?: string;
    anchors?: string[];
  }
): void {
  if (candidate === undefined) return;
  if (!Value.Check(workspaceReadReceiptSchema, candidate)) {
    throw Object.assign(new Error("Malformed workspace read receipt"), {
      code: "InvalidWorkspaceReadReceipt",
      errorData: {
        code: "InvalidWorkspaceReadReceipt",
        message: "Malformed workspace read receipt",
        recovery: {
          action: "correct-request",
          instruction: "Pass the receipt object returned by the read tool without rewriting it.",
        },
      },
    });
  }
  const receipt = candidate as WorkspaceReadReceipt;
  const currentReceipt =
    current.contentHash === undefined || current.byteLength === undefined
      ? null
      : createWorkspaceReadReceipt(current.path, current.contentHash, current.byteLength);
  if (
    receipt.path === current.path &&
    currentReceipt &&
    receipt.contentHash === currentReceipt.contentHash
  ) {
    return;
  }

  const reason =
    receipt.path !== current.path
      ? "path-mismatch"
      : currentReceipt
        ? "content-changed"
        : "file-missing";
  const message =
    reason === "path-mismatch"
      ? `Read receipt names ${receipt.path}, not ${current.path}`
      : reason === "file-missing"
        ? `File read as ${receipt.path} no longer exists`
        : `File changed after it was read: ${current.path}`;
  throw Object.assign(new Error(message), {
    code: "WorkspaceReadConflict",
    errorData: {
      code: "WorkspaceReadConflict",
      message,
      reason,
      path: current.path,
      suppliedReceipt: receipt,
      currentReceipt,
      ...(current.text !== undefined
        ? {
            closestCurrentExcerpts: closestCurrentExcerpts(current.text, current.anchors ?? []),
          }
        : {}),
      recovery: {
        action: "reobserve",
        instruction:
          "Use the returned current receipt and excerpts to form a new exact edit; do not retry the stale command unchanged.",
      },
    },
  });
}

function closestCurrentExcerpts(
  content: string,
  anchors: string[]
): Array<{ startLine: number; endLine: number; text: string }> {
  const tokens = new Set(
    anchors
      .flatMap((anchor) => anchor.match(/[A-Za-z0-9_-]{4,}/gu) ?? [])
      .map((token) => token.toLowerCase())
  );
  const lines = content.split("\n");
  if (tokens.size === 0) {
    return content.length === 0
      ? []
      : [
          {
            startLine: 1,
            endLine: Math.min(3, lines.length),
            text: boundedText(lines.slice(0, 3).join("\n"), 800),
          },
        ];
  }
  return lines
    .map((_line, index) => {
      const endIndex = Math.min(lines.length, index + 3);
      const text = lines.slice(index, endIndex).join("\n");
      const found = new Set(
        (text.match(/[A-Za-z0-9_-]{4,}/gu) ?? []).map((token) => token.toLowerCase())
      );
      const score = [...tokens].reduce((count, token) => count + (found.has(token) ? 1 : 0), 0);
      return { score, startLine: index + 1, endLine: endIndex, text: boundedText(text, 800) };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.startLine - right.startLine)
    .filter(
      (candidate, index, candidates) =>
        candidates.findIndex((other) => Math.abs(other.startLine - candidate.startLine) <= 2) ===
        index
    )
    .slice(0, 3)
    .map(({ startLine, endLine, text }) => ({ startLine, endLine, text }));
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
