/**
 * Hook ingestion for the channel bridge (plan §7.4).
 *
 * Claude Code hooks run `vibestudio claude emit <event>`, which writes one JSON
 * line `{ event, payload, ts }` to a unix socket the bridge listens on:
 * `$VIBESTUDIO_LAUNCH_PROFILE/hook.sock` inside the controlled launch profile.
 * This module owns the socket server and the
 * mapping from raw Claude Code hook payloads to the vessel's `LinkedHookEvent`
 * shapes — including the turnKey scheme that frames turns.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** Structural mirror of the vessel's LinkedHookEvent (no workspace import). */
export type BridgeHookEvent =
  | { hook: "SessionStart"; claudeSessionId?: string; model?: string; cwd?: string }
  | { hook: "UserPromptSubmit"; promptText: string; turnKey: string; promptId?: string }
  | {
      hook: "PreToolUse";
      toolName: string;
      toolUseId: string;
      request?: unknown;
      promptId?: string;
      turnSource: "local" | "channel";
    }
  | {
      hook: "PostToolUse";
      toolUseId: string;
      toolName?: string;
      outputSummary?: string;
      promptId?: string;
      turnSource: "local" | "channel";
    }
  | {
      hook: "PostToolUseFailure";
      toolUseId: string;
      toolName?: string;
      error: string;
      interrupted?: boolean;
      promptId?: string;
      turnSource: "local" | "channel";
    }
  | {
      hook: "Stop";
      finalText?: string;
      turnKey: string;
      promptId?: string;
      turnSource: "local" | "channel";
    }
  | {
      hook: "StopFailure";
      error: string;
      errorDetails?: string;
      finalText?: string;
      turnKey: string;
      promptId?: string;
      turnSource: "local" | "channel";
    }
  | { hook: "SessionEnd"; claudeSessionId?: string; reason?: string };

export interface EmittedHookLine {
  event: string;
  payload: unknown;
  ts?: number;
}

const SUMMARY_BOUND = 500;

/** Fallback socket path for sessions we didn't launch (no profile env). */
export function agentSocketPath(contextId: string): string {
  const safe = contextId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(os.homedir(), ".config", "vibestudio", "agent-sockets", `${safe}.sock`);
}

/**
 * Turn framing for hook events (bridge-minted; the vessel derives turn ids
 * from these keys deterministically).
 *
 * Scheme: a per-run monotonically increasing counter. `UserPromptSubmit`
 * always opens a fresh turn. Tool activity or a `Stop` with no open turn means
 * the turn was opened by channel input (no local prompt) — open one implicitly
 * so the Stop closes a well-formed pair. Keys look like `t3`.
 */
export class TurnTracker {
  private n = 0;
  private open: "local" | "channel" | null = null;

  onUserPrompt(): string {
    this.n += 1;
    this.open = "local";
    return this.key();
  }

  /** Tool use (or any mid-turn activity): join the open turn or open one. */
  onActivity(): { turnKey: string; source: "local" | "channel" } {
    if (!this.open) {
      this.n += 1;
      this.open = "channel";
    }
    return { turnKey: this.key(), source: this.open };
  }

  onStop(): { turnKey: string; source: "local" | "channel" } {
    if (!this.open) {
      this.n += 1;
      this.open = "channel";
    }
    const result = { turnKey: this.key(), source: this.open };
    this.open = null;
    return result;
  }

  key(): string {
    return `t${this.n}`;
  }
}

function summarize(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (!text) return undefined;
  return text.length > SUMMARY_BOUND ? `${text.slice(0, SUMMARY_BOUND)}…` : text;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  return typeof payload[key] === "string" ? (payload[key] as string) : undefined;
}

let syntheticToolUse = 0;

/**
 * Map an emitted hook line to a vessel hook event. Returns null for unknown
 * events (forward-compatible: new hooks are ignored, never fatal).
 *
 * Field names follow the Claude Code hook stdin payloads: common fields
 * `session_id`/`cwd`/`hook_event_name`; `UserPromptSubmit.prompt`;
 * `PreToolUse`/`PostToolUse` `tool_name`/`tool_input`/`tool_use_id` (+
 * `tool_response` on Post); `SessionStart.model`/`source`. Older builds omit
 * `tool_use_id` — a per-run synthetic id keeps Pre/Post pairing best-effort.
 * Tool input is retained structurally and unabridged because it is the
 * canonical request on `invocation.started`; only terminal output is a bounded
 * diagnostic summary.
 */
export function mapHookEvent(
  line: EmittedHookLine,
  turns: TurnTracker,
  pendingToolIds: Map<string, string>
): BridgeHookEvent | null {
  const payload = rec(line.payload);
  switch (line.event) {
    case "SessionStart": {
      const model = payload["model"];
      return {
        hook: "SessionStart",
        claudeSessionId: optionalString(payload, "session_id"),
        model:
          typeof model === "string"
            ? model
            : typeof rec(model)["display_name"] === "string"
              ? (rec(model)["display_name"] as string)
              : undefined,
        cwd: typeof payload["cwd"] === "string" ? payload["cwd"] : undefined,
      };
    }
    case "UserPromptSubmit": {
      const prompt = payload["prompt"];
      return {
        hook: "UserPromptSubmit",
        promptText: typeof prompt === "string" ? prompt : "",
        turnKey: turns.onUserPrompt(),
        ...(optionalString(payload, "prompt_id")
          ? { promptId: optionalString(payload, "prompt_id") }
          : {}),
      };
    }
    case "PreToolUse": {
      const turn = turns.onActivity();
      const toolName = typeof payload["tool_name"] === "string" ? payload["tool_name"] : "unknown";
      let toolUseId =
        typeof payload["tool_use_id"] === "string" ? payload["tool_use_id"] : undefined;
      if (!toolUseId) {
        toolUseId = `synthetic:${++syntheticToolUse}`;
        pendingToolIds.set(toolName, toolUseId);
      }
      return {
        hook: "PreToolUse",
        toolName,
        toolUseId,
        turnSource: turn.source,
        ...(optionalString(payload, "prompt_id")
          ? { promptId: optionalString(payload, "prompt_id") }
          : {}),
        ...(payload["tool_input"] !== undefined ? { request: payload["tool_input"] } : {}),
      };
    }
    case "PostToolUse": {
      const turn = turns.onActivity();
      const toolName = typeof payload["tool_name"] === "string" ? payload["tool_name"] : undefined;
      let toolUseId =
        typeof payload["tool_use_id"] === "string" ? payload["tool_use_id"] : undefined;
      if (!toolUseId && toolName) {
        toolUseId = pendingToolIds.get(toolName);
        pendingToolIds.delete(toolName);
      }
      if (!toolUseId) toolUseId = `synthetic:${++syntheticToolUse}`;
      const response = payload["tool_response"];
      return {
        hook: "PostToolUse",
        toolUseId,
        toolName,
        turnSource: turn.source,
        outputSummary: summarize(response),
        ...(optionalString(payload, "prompt_id")
          ? { promptId: optionalString(payload, "prompt_id") }
          : {}),
      };
    }
    case "PostToolUseFailure": {
      const turn = turns.onActivity();
      const toolName = optionalString(payload, "tool_name");
      let toolUseId = optionalString(payload, "tool_use_id");
      if (!toolUseId && toolName) {
        toolUseId = pendingToolIds.get(toolName);
        pendingToolIds.delete(toolName);
      }
      if (!toolUseId) toolUseId = `synthetic:${++syntheticToolUse}`;
      return {
        hook: "PostToolUseFailure",
        toolUseId,
        toolName,
        error: optionalString(payload, "error") ?? "tool failed",
        ...(payload["is_interrupt"] === true ? { interrupted: true } : {}),
        ...(optionalString(payload, "prompt_id")
          ? { promptId: optionalString(payload, "prompt_id") }
          : {}),
        turnSource: turn.source,
      };
    }
    case "Stop": {
      // The final assistant text is not in the Stop payload; the vessel accepts
      // an omitted finalText (mirror is best-effort at hook granularity).
      const finalText =
        typeof payload["last_assistant_message"] === "string"
          ? payload["last_assistant_message"]
          : typeof payload["final_message"] === "string"
            ? payload["final_message"]
            : undefined;
      const turn = turns.onStop();
      return {
        hook: "Stop",
        finalText,
        turnKey: turn.turnKey,
        turnSource: turn.source,
        ...(optionalString(payload, "prompt_id")
          ? { promptId: optionalString(payload, "prompt_id") }
          : {}),
      };
    }
    case "StopFailure": {
      const turn = turns.onStop();
      return {
        hook: "StopFailure",
        error: optionalString(payload, "error") ?? "unknown",
        errorDetails: summarize(payload["error_details"]),
        finalText: optionalString(payload, "last_assistant_message"),
        turnKey: turn.turnKey,
        turnSource: turn.source,
        ...(optionalString(payload, "prompt_id")
          ? { promptId: optionalString(payload, "prompt_id") }
          : {}),
      };
    }
    case "SessionEnd":
      return {
        hook: "SessionEnd",
        claudeSessionId: optionalString(payload, "session_id"),
        reason: optionalString(payload, "reason"),
      };
    default:
      return null;
  }
}

export interface HookSocketServer {
  paths: string[];
  ready: Promise<void>;
  close(): Promise<void>;
}

/**
 * Listen on one or more unix socket paths for emitted hook lines. Stale socket
 * files are unlinked before bind (single active bridge per profile/context by
 * construction). Errors on individual lines/paths are logged, never fatal.
 */
export function startHookSocketServer(
  socketPaths: string[],
  onLine: (line: EmittedHookLine) => Promise<void>,
  log: (message: string) => void
): HookSocketServer {
  const servers: net.Server[] = [];
  const bound = [...socketPaths];
  const pending = new Set<Promise<void>>();
  let closing = false;
  const readiness: Promise<void>[] = [];
  for (const socketPath of socketPaths) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    fs.rmSync(socketPath, { force: true });
    const server = net.createServer((socket) => {
      if (closing) {
        socket.destroy();
        return;
      }
      let buffer = "";
      let received = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        if (received) return;
        buffer += chunk;
        const idx = buffer.indexOf("\n");
        if (idx === -1) return;
        received = true;
        const raw = buffer.slice(0, idx).trim();
        const task = (async () => {
          try {
            const parsed = JSON.parse(raw) as EmittedHookLine;
            if (!parsed || typeof parsed.event !== "string") {
              throw new Error("invalid hook envelope");
            }
            await onLine(parsed);
            socket.end('{"ok":true}\n');
          } catch (error) {
            log(
              `hook socket: ingestion failed (${error instanceof Error ? error.message : error})`
            );
            socket.end('{"ok":false,"error":"hook-ingest-failed"}\n');
          }
        })();
        pending.add(task);
        void task.finally(() => pending.delete(task));
      });
      socket.on("error", () => socket.destroy());
    });
    const ready = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        server.on("error", (error) => log(`hook socket ${socketPath}: ${error.message}`));
        resolve();
      });
    });
    readiness.push(ready);
    servers.push(server);
  }
  return {
    paths: bound,
    ready: Promise.all(readiness).then(() => undefined),
    close: async () => {
      closing = true;
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              if (!server.listening) {
                resolve();
                return;
              }
              server.close(() => resolve());
            })
        )
      );
      await Promise.allSettled([...pending]);
      for (const socketPath of bound) fs.rmSync(socketPath, { force: true });
    },
  };
}
