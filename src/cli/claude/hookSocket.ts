/**
 * Hook ingestion for the channel bridge (plan §7.4).
 *
 * Claude Code hooks run `vibestudio claude emit <event>`, which writes one JSON
 * line `{ event, payload, ts }` to a unix socket the bridge listens on:
 * `$VIBESTUDIO_LAUNCH_PROFILE/hook.sock` for launched sessions, or the
 * per-context fallback under the user config dir for adopted sessions (whose
 * hooks have no launch-profile env). This module owns the socket server and the
 * mapping from raw Claude Code hook payloads to the vessel's `LinkedHookEvent`
 * shapes — including the turnKey scheme that frames turns.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** Structural mirror of the vessel's LinkedHookEvent (no workspace import). */
export type BridgeHookEvent =
  | { hook: "SessionStart"; model?: string; cwd?: string }
  | { hook: "UserPromptSubmit"; promptText: string; turnKey: string }
  | { hook: "PreToolUse"; toolName: string; toolUseId: string; inputSummary?: string }
  | {
      hook: "PostToolUse";
      toolUseId: string;
      toolName?: string;
      ok: boolean;
      outputSummary?: string;
    }
  | { hook: "Stop"; finalText?: string; turnKey: string }
  | { hook: "SessionEnd" };

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
  private open = false;

  onUserPrompt(): string {
    this.n += 1;
    this.open = true;
    return this.key();
  }

  /** Tool use (or any mid-turn activity): join the open turn or open one. */
  onActivity(): string {
    if (!this.open) {
      this.n += 1;
      this.open = true;
    }
    return this.key();
  }

  onStop(): string {
    if (!this.open) this.n += 1;
    this.open = false;
    return this.key();
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
      };
    }
    case "PreToolUse": {
      turns.onActivity();
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
        inputSummary: summarize(payload["tool_input"]),
      };
    }
    case "PostToolUse": {
      const toolName = typeof payload["tool_name"] === "string" ? payload["tool_name"] : undefined;
      let toolUseId =
        typeof payload["tool_use_id"] === "string" ? payload["tool_use_id"] : undefined;
      if (!toolUseId && toolName) {
        toolUseId = pendingToolIds.get(toolName);
        pendingToolIds.delete(toolName);
      }
      if (!toolUseId) toolUseId = `synthetic:${++syntheticToolUse}`;
      const response = payload["tool_response"];
      const responseRec = rec(response);
      const ok = !(
        responseRec["is_error"] === true ||
        responseRec["isError"] === true ||
        responseRec["success"] === false
      );
      return {
        hook: "PostToolUse",
        toolUseId,
        toolName,
        ok,
        outputSummary: summarize(response),
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
      return { hook: "Stop", finalText, turnKey: turns.onStop() };
    }
    case "SessionEnd":
      return { hook: "SessionEnd" };
    default:
      return null;
  }
}

export interface HookSocketServer {
  paths: string[];
  close(): Promise<void>;
}

/**
 * Listen on one or more unix socket paths for emitted hook lines. Stale socket
 * files are unlinked before bind (single active bridge per profile/context by
 * construction). Errors on individual lines/paths are logged, never fatal.
 */
export function startHookSocketServer(
  socketPaths: string[],
  onLine: (line: EmittedHookLine) => void,
  log: (message: string) => void
): HookSocketServer {
  const servers: net.Server[] = [];
  const bound: string[] = [];
  for (const socketPath of socketPaths) {
    try {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      fs.rmSync(socketPath, { force: true });
      const server = net.createServer((socket) => {
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\n");
            if (idx === -1) return;
            const raw = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!raw) continue;
            try {
              const parsed = JSON.parse(raw) as EmittedHookLine;
              if (parsed && typeof parsed.event === "string") onLine(parsed);
            } catch {
              log(`hook socket: dropping unparseable line (${raw.length} bytes)`);
            }
          }
        });
        socket.on("error", () => socket.destroy());
      });
      server.on("error", (err) => log(`hook socket ${socketPath}: ${err.message}`));
      server.listen(socketPath);
      servers.push(server);
      bound.push(socketPath);
    } catch (err) {
      log(
        `hook socket ${socketPath}: failed to bind (${err instanceof Error ? err.message : err})`
      );
    }
  }
  return {
    paths: bound,
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            })
        )
      );
      for (const socketPath of bound) fs.rmSync(socketPath, { force: true });
    },
  };
}
