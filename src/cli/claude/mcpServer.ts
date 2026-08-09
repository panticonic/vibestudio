/**
 * Minimal stdio MCP server for the Claude Code channel bridge (plan §7.1).
 *
 * Speaks JSON-RPC 2.0, newline-delimited (one message per line — the MCP stdio
 * transport framing; no Content-Length headers). Implements exactly the subset
 * the channel contract needs: `initialize` (declaring the experimental
 * `claude/channel` and, only with a configured relay, `claude/channel/permission`
 * capabilities), `tools/list`,
 * `tools/call`, `ping`, and the channel notification methods in both
 * directions. Transport-agnostic over Readable/Writable for tests.
 */

import type { Readable, Writable } from "node:stream";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const CHANNEL_NOTIFICATION = "notifications/claude/channel";
export const PERMISSION_REQUEST_NOTIFICATION = "notifications/claude/channel/permission_request";
export const PERMISSION_VERDICT_NOTIFICATION = "notifications/claude/channel/permission";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type ChannelNotificationMeta = Record<string, string>;

const CHANNEL_META_KEY = /^[A-Za-z0-9_]+$/;

export function toolText(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpServerOptions {
  serverName: string;
  serverVersion: string;
  instructions: string;
  tools: McpToolDef[];
  /** Optional MCP resources (declares the `resources` capability when set). */
  resources?: {
    list(): Promise<McpResourceDef[]>;
    read(uri: string): Promise<McpResourceContents>;
  };
  /** Handle a tools/call; `requestId` is the JSON-RPC id (idempotency seed). */
  onToolCall: (
    name: string,
    args: Record<string, unknown>,
    requestId: string
  ) => Promise<McpToolResult>;
  /** Claude Code → bridge permission request (claude/channel/permission). */
  onPermissionRequest?: (params: {
    request_id: string;
    tool_name: string;
    description?: string;
    input_preview?: string;
  }) => void | Promise<void>;
  onInitialized?: () => void | Promise<void>;
  onTransportFailure?: (error: Error) => void;
  log?: (message: string) => void;
}

export class McpStdioServer {
  private buffer = "";
  private started = false;
  private writeTail: Promise<void> = Promise.resolve();
  private transportFailure: Error | null = null;
  private readonly activeWriteFailures = new Set<(error: Error) => void>();
  private initializedSettled = false;
  private readonly initializedPromise: Promise<void>;
  private resolveInitialized!: () => void;
  private rejectInitialized!: (error: Error) => void;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: McpServerOptions
  ) {
    this.initializedPromise = new Promise<void>((resolve, reject) => {
      this.resolveInitialized = resolve;
      this.rejectInitialized = reject;
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.input.setEncoding?.("utf8");
    this.input.on("data", (chunk: string | Buffer) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.drain();
    });
    this.input.once("error", (error) => this.failTransport(asError(error, "MCP stdin failed")));
    this.input.once("end", () =>
      this.failBeforeInitialized("MCP stdin ended before initialization")
    );
    this.input.once("close", () =>
      this.failBeforeInitialized("MCP stdin closed before initialization")
    );
    this.output.once("error", (error) => this.failTransport(asError(error, "MCP stdout failed")));
    this.output.once("close", () => this.failTransport(new Error("MCP stdout closed")));
  }

  /** Resolves only after Claude completes the MCP initialize handshake. */
  whenInitialized(): Promise<void> {
    return this.initializedPromise;
  }

  private drain(): void {
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.options.log?.(`mcp: dropping unparseable line (${line.length} bytes)`);
        continue;
      }
      void this.handle(message).catch((err) => {
        this.options.log?.(`mcp: handler error: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  private async handle(message: JsonRpcMessage): Promise<void> {
    const { id, method } = message;
    if (!method) return; // responses to server-initiated requests: none issued
    const params = message.params ?? {};

    // Notifications (no id): initialized + permission requests.
    if (id === undefined || id === null) {
      if (method === "notifications/initialized") {
        if (!this.initializedSettled) {
          this.initializedSettled = true;
          this.resolveInitialized();
        }
        await this.options.onInitialized?.();
        return;
      }
      if (method === PERMISSION_REQUEST_NOTIFICATION) {
        const requestId = str(params["request_id"]);
        const toolName = str(params["tool_name"]);
        if (requestId && toolName) {
          await this.options.onPermissionRequest?.({
            request_id: requestId,
            tool_name: toolName,
            description: optStr(params["description"]),
            input_preview: optStr(params["input_preview"]),
          });
        }
        return;
      }
      return; // other notifications ignored
    }

    switch (method) {
      case "initialize": {
        await this.respond(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            ...(this.options.resources ? { resources: {} } : {}),
            experimental: {
              "claude/channel": {},
              ...(this.options.onPermissionRequest ? { "claude/channel/permission": {} } : {}),
            },
          },
          serverInfo: { name: this.options.serverName, version: this.options.serverVersion },
          instructions: this.options.instructions,
        });
        return;
      }
      case "ping":
        await this.respond(id, {});
        return;
      case "tools/list":
        await this.respond(id, { tools: this.options.tools });
        return;
      case "resources/list": {
        if (!this.options.resources) {
          await this.respondError(id, -32601, "resources are not supported");
          return;
        }
        try {
          await this.respond(id, { resources: await this.options.resources.list() });
        } catch (err) {
          await this.respondError(id, -32603, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      case "resources/read": {
        if (!this.options.resources) {
          await this.respondError(id, -32601, "resources are not supported");
          return;
        }
        const uri = str(params["uri"]);
        if (!uri) {
          await this.respondError(id, -32602, "resources/read requires a uri");
          return;
        }
        try {
          await this.respond(id, await this.options.resources.read(uri));
        } catch (err) {
          await this.respondError(id, -32603, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      case "tools/call": {
        const name = str(params["name"]);
        const args = (params["arguments"] ?? {}) as Record<string, unknown>;
        if (!name) {
          await this.respondError(id, -32602, "tools/call requires a tool name");
          return;
        }
        try {
          const result = await this.options.onToolCall(name, args, String(id));
          await this.respond(id, result);
        } catch (err) {
          await this.respond(id, toolText(err instanceof Error ? err.message : String(err), true));
        }
        return;
      }
      default:
        await this.respondError(id, -32601, `method not found: ${method}`);
    }
  }

  /** Push a channel event into the session (queued to the next turn boundary). */
  notifyChannel(content: string, meta: ChannelNotificationMeta = {}): Promise<void> {
    assertChannelNotification(content, meta);
    return this.notify(CHANNEL_NOTIFICATION, { content, meta });
  }

  /** Deliver a permission verdict for a relayed request. */
  notifyPermission(requestId: string, behavior: "allow" | "deny"): Promise<void> {
    return this.notify(PERMISSION_VERDICT_NOTIFICATION, { request_id: requestId, behavior });
  }

  notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.write({ jsonrpc: "2.0", method, params });
  }

  private respond(id: number | string, result: unknown): Promise<void> {
    return this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: number | string, code: number, message: string): Promise<void> {
    return this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(message: Record<string, unknown>): Promise<void> {
    const frame = `${JSON.stringify(message)}\n`;
    const write = this.writeTail.then(() => this.writeFrame(frame));
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  private writeFrame(frame: string): Promise<void> {
    if (this.transportFailure) return Promise.reject(this.transportFailure);
    return new Promise<void>((resolve, reject) => {
      let writeReturned = false;
      let writeAccepted = false;
      let writeCallbackCompleted = false;
      let drainObserved = false;
      let settled = false;

      const dispose = (): void => {
        this.output.off("drain", onDrain);
        this.activeWriteFailures.delete(fail);
      };
      const succeedIfComplete = (): void => {
        if (
          settled ||
          !writeReturned ||
          !writeCallbackCompleted ||
          (!writeAccepted && !drainObserved)
        ) {
          return;
        }
        settled = true;
        dispose();
        resolve();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        dispose();
        reject(error);
      };
      const onDrain = (): void => {
        drainObserved = true;
        succeedIfComplete();
      };

      this.activeWriteFailures.add(fail);
      this.output.on("drain", onDrain);
      try {
        writeAccepted = this.output.write(frame, (error?: Error | null) => {
          if (error) {
            fail(error);
            return;
          }
          writeCallbackCompleted = true;
          succeedIfComplete();
        });
        writeReturned = true;
        if (writeAccepted) this.output.off("drain", onDrain);
        succeedIfComplete();
      } catch (error) {
        fail(asError(error, "MCP stdout write failed"));
      }
    });
  }

  private failBeforeInitialized(message: string): void {
    if (this.initializedSettled) return;
    this.failTransport(new Error(message));
  }

  private failTransport(error: Error): void {
    if (this.transportFailure) return;
    this.transportFailure = error;
    if (!this.initializedSettled) {
      this.initializedSettled = true;
      this.rejectInitialized(error);
    }
    for (const fail of [...this.activeWriteFailures]) fail(error);
    this.options.onTransportFailure?.(error);
  }
}

export function assertChannelNotification(
  content: unknown,
  meta: Record<string, unknown>
): asserts content is string {
  if (typeof content !== "string") {
    throw new TypeError("Claude channel notification content must be a string");
  }
  for (const [key, value] of Object.entries(meta)) {
    if (!CHANNEL_META_KEY.test(key)) {
      throw new TypeError(`Claude channel notification meta key is not an identifier: ${key}`);
    }
    if (typeof value !== "string") {
      throw new TypeError(`Claude channel notification meta value must be a string: ${key}`);
    }
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(error === undefined ? fallback : String(error));
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
