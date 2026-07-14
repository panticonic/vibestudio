import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, stat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionInfo } from "./types.js";
import {
  parseTerminalControlRequest,
  type TerminalControlOperation,
  type TerminalControlResponse,
} from "@vibestudio/shared/terminalControlProtocol";

export interface TerminalControlSessionOps {
  list(ownerCallerId: string): SessionInfo[];
  setMeta(sessionId: string, key: string, value: unknown): void;
  getMeta(sessionId: string, key?: string): unknown;
  deleteMeta(sessionId: string, key: string): void;
  setLabel(sessionId: string, label: string): void;
  write(sessionId: string, text: string): void;
  ownerOf(sessionId: string): string | undefined;
  openSplit(sessionId: string, direction: "row" | "column", command?: string): Promise<string>;
  openUrl(sessionId: string, url: string): Promise<void>;
}

export interface TerminalControlServerOptions {
  platform?: NodeJS.Platform;
  hostBuildId?: string;
}

export class TerminalControlServer {
  private dir?: string;
  private readonly platform: NodeJS.Platform;
  private readonly hostBuildId: string;
  private readonly pending = new Map<string, { server: Server; socketPath: string }>();
  private readonly sessions = new Map<string, { token: string; server: Server; socketPath: string }>();
  private readonly tokens = new Map<string, string>();
  private readonly notificationBuckets = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly ops: TerminalControlSessionOps,
    opts: TerminalControlServerOptions = {}
  ) {
    this.platform = opts.platform ?? process.platform;
    this.hostBuildId = opts.hostBuildId ?? process.env["VIBESTUDIO_HOST_BUILD_ID"] ?? "";
    if (!this.hostBuildId) throw new Error("terminal-control requires an exact host build identity");
  }

  async start(): Promise<void> {
    if (this.dir) return;
    if (this.platform === "win32") {
      this.dir = "windows-named-pipe";
      return;
    }
    this.dir = path.join(tmpdir(), `vibestudio-terminal-${randomBytes(16).toString("hex")}`);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
    await assertPrivateDir(this.dir, this.platform);
  }

  envForSession(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; token: string } {
    if (!this.dir) throw new Error("terminal-control server has not started");
    const token = randomBytes(24).toString("hex");
    const socketPath =
      this.platform === "win32"
        ? `\\\\.\\pipe\\vibestudio-terminal-${randomBytes(24).toString("hex")}`
        : path.join(this.dir, `${randomBytes(16).toString("hex")}.sock`);
    const server = createServer((socket) => this.handleSocket(socket, token));
    server.listen(socketPath, () => {
      void chmod(socketPath, 0o600).catch(() => {});
    });
    this.pending.set(token, { server, socketPath });
    return {
      token,
      env: {
        ...env,
        VIBESTUDIO_TERMINAL_ENDPOINT: socketPath,
      },
    };
  }

  register(token: string, sessionId: string): void {
    if (!token) return;
    this.tokens.set(token, sessionId);
    const pending = this.pending.get(token);
    if (!pending) return;
    this.pending.delete(token);
    this.sessions.set(sessionId, { token, ...pending });
  }

  discardPending(token: string): void {
    const pending = this.pending.get(token);
    if (!pending) return;
    this.pending.delete(token);
    closeAndUnlink(pending.server, pending.socketPath);
  }

  unregister(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.tokens.delete(session.token);
    this.notificationBuckets.delete(sessionId);
    closeAndUnlink(session.server, session.socketPath);
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) closeAndUnlink(session.server, session.socketPath);
    for (const pending of this.pending.values()) closeAndUnlink(pending.server, pending.socketPath);
    this.sessions.clear();
    this.pending.clear();
    this.tokens.clear();
    this.notificationBuckets.clear();
    if (this.dir && this.platform !== "win32") {
      await rm(this.dir, { recursive: true, force: true }).catch(() => {});
    }
    this.dir = undefined;
  }

  private handleSocket(socket: Socket, socketToken: string): void {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      const line = buffer.split("\n", 1)[0] ?? "";
      void this.handleRequest(line, socketToken).then((response) => {
        socket.end(JSON.stringify(response));
      });
    });
  }

  private async handleRequest(
    line: string,
    socketToken: string
  ): Promise<TerminalControlResponse> {
    try {
      const request = parseTerminalControlRequest(JSON.parse(line));
      if (request.hostBuildId !== this.hostBuildId) {
        return {
          ok: false,
          error: `terminal-control host mismatch: expected ${this.hostBuildId}, got ${request.hostBuildId}`,
        };
      }
      const sessionId = this.tokens.get(socketToken);
      if (!sessionId) return { ok: false, error: "invalid terminal-control session" };
      const ownerCallerId = this.ops.ownerOf(sessionId);
      if (!ownerCallerId) return { ok: false, error: "unknown terminal session owner" };
      return await this.dispatch(sessionId, ownerCallerId, request.operation);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async dispatch(
    sessionId: string,
    ownerCallerId: string,
    operation: TerminalControlOperation
  ): Promise<TerminalControlResponse> {
    switch (operation.kind) {
      case "list":
        return { ok: true, stdout: `${JSON.stringify(this.ops.list(ownerCallerId), null, 2)}\n` };
      case "badge": {
        if (operation.color && operation.text && !isBadgeColorName(operation.color)) {
          return { ok: false, error: `invalid terminal badge color: ${operation.color}` };
        }
        if (!operation.text || operation.text === "clear") this.ops.deleteMeta(sessionId, "badge");
        else {
          this.ops.setMeta(
            sessionId,
            "badge",
            operation.color
              ? { text: operation.text, color: operation.color }
              : { text: operation.text }
          );
        }
        return { ok: true };
      }
      case "label":
        this.ops.setLabel(sessionId, operation.label);
        return { ok: true };
      case "meta-set":
      case "meta-get":
      case "meta-delete": {
        if (!operation.key) return { ok: false, error: "terminal meta requires a key" };
        if (isReservedMetaKey(operation.key)) {
          return { ok: false, error: `reserved terminal metadata key: ${operation.key}` };
        }
        if (operation.kind === "meta-set") this.ops.setMeta(sessionId, operation.key, operation.value);
        else if (operation.kind === "meta-delete") this.ops.deleteMeta(sessionId, operation.key);
        else {
          return {
            ok: true,
            stdout: `${JSON.stringify(this.ops.getMeta(sessionId, operation.key))}\n`,
          };
        }
        return { ok: true };
      }
      case "notify":
        if (!isNotificationSeverityName(operation.severity)) {
          return { ok: false, error: `invalid terminal notification severity: ${operation.severity}` };
        }
        if (!this.consumeNotificationQuota(sessionId)) {
          return { ok: false, error: "terminal notification rate limit exceeded" };
        }
        return {
          ok: true,
          stdout: osc(operation.severity, operation.title, operation.message),
        };
      case "send":
        if (this.ops.ownerOf(operation.targetSessionId) !== ownerCallerId) {
          return { ok: false, error: "EACCES" };
        }
        this.ops.write(operation.targetSessionId, operation.text);
        return { ok: true };
      case "split": {
        const output = await this.ops.openSplit(
          sessionId,
          operation.direction,
          operation.command
        );
        return { ok: true, stdout: `${output}\n` };
      }
      case "open":
        await this.ops.openUrl(sessionId, operation.url);
        return { ok: true };
    }
  }

  private consumeNotificationQuota(sessionId: string): boolean {
    const now = Date.now();
    const current = this.notificationBuckets.get(sessionId);
    if (!current || now - current.startedAt >= 60_000) {
      this.notificationBuckets.set(sessionId, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= 50) return false;
    current.count += 1;
    return true;
  }

}

async function assertPrivateDir(dir: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  const mode = (await stat(dir)).mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`terminal-control directory must be private: ${dir} has mode ${mode.toString(8)}`);
  }
}

function osc(sev: string, title: string, msg: string): string {
  const params = new URLSearchParams();
  params.set("sev", sev || "info");
  if (title) params.set("title", title);
  params.set("msg", msg || "");
  return `\x1b]1337;vibestudio-terminal;${params.toString().replace(/&/g, ";")}\x07`;
}

type NotificationSeverityName = "info" | "done" | "waiting" | "approval" | "failure";

function isNotificationSeverityName(value: string): value is NotificationSeverityName {
  return value === "info" || value === "done" || value === "waiting" || value === "approval" || value === "failure";
}

const badgeColorNames = new Set([
  "gray", "gold", "bronze", "brown", "yellow", "amber", "orange", "tomato",
  "red", "ruby", "crimson", "pink", "plum", "purple", "violet", "iris",
  "indigo", "blue", "cyan", "teal", "jade", "green", "grass", "lime",
  "mint", "sky",
]);

function isBadgeColorName(value: string): boolean {
  return badgeColorNames.has(value);
}

function isReservedMetaKey(key: string): boolean {
  return key === "terminalOpenUrl" || key === "terminalSpawn";
}

function closeAndUnlink(server: Server, socketPath: string): void {
  server.close(() => {
    void unlink(socketPath).catch(() => {});
  });
}
