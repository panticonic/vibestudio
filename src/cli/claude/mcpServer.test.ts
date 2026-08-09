import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  CHANNEL_NOTIFICATION,
  McpStdioServer,
  toolText,
  type McpServerOptions,
} from "./mcpServer.js";

interface Sent {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function harness(overrides: Partial<McpServerOptions> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: Sent[] = [];
  output.setEncoding("utf8");
  let buffer = "";
  output.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      sent.push(JSON.parse(buffer.slice(0, idx)) as Sent);
      buffer = buffer.slice(idx + 1);
    }
  });
  const server = new McpStdioServer(input, output, {
    serverName: "vibestudio",
    serverVersion: "0.0.0",
    instructions: "test instructions",
    tools: [{ name: "say", description: "d", inputSchema: { type: "object" } }],
    onToolCall: async () => toolText("ok"),
    ...overrides,
  });
  server.start();
  const send = (message: Record<string, unknown>): void => {
    input.write(`${JSON.stringify(message)}\n`);
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { server, sent, send, flush };
}

class ControlledWritable extends Writable {
  readonly chunks: string[] = [];
  private readonly completions: Array<() => void> = [];

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(chunk.toString("utf8"));
    this.completions.push(() => callback());
  }

  completeOne(): void {
    const complete = this.completions.shift();
    if (!complete) throw new Error("no controlled write is pending");
    complete();
  }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("McpStdioServer", () => {
  it("answers initialize with exactly the channel capability", async () => {
    const { sent, send, flush } = harness();
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-01-01" },
    });
    await flush();
    expect(sent).toHaveLength(1);
    const result = sent[0]!.result!;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    const caps = result["capabilities"] as Record<string, Record<string, unknown>>;
    expect(caps["experimental"]).toEqual({ "claude/channel": {} });
    expect(result["instructions"]).toBe("test instructions");
  });

  it("does not report MCP initialization until Claude sends initialized", async () => {
    const { server, send, flush } = harness();
    let initialized = false;
    void server.whenInitialized().then(() => {
      initialized = true;
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await flush();
    expect(initialized).toBe(false);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await server.whenInitialized();
    expect(initialized).toBe(true);
  });

  it("round-trips tools/list and tools/call, splitting coalesced lines", async () => {
    const calls: Array<{ name: string; requestId: string }> = [];
    const { sent, send, flush } = harness({
      onToolCall: async (name, _args, requestId) => {
        calls.push({ name, requestId });
        return toolText(`ran ${name}`);
      },
    });
    // Two messages in one chunk exercises newline framing.
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "say", arguments: { text: "hi" } },
    });
    await flush();
    expect((sent[0]!.result!["tools"] as unknown[]).length).toBe(1);
    expect(calls).toEqual([{ name: "say", requestId: "3" }]);
    expect((sent[1]!.result!["content"] as Array<{ text: string }>)[0]!.text).toBe("ran say");
  });

  it("pushes channel notifications with content + meta", async () => {
    const { server, sent } = harness();
    await server.notifyChannel("hello", { channel_id: "chan", seq: "7" });
    const note = sent.find((m) => m.method === CHANNEL_NOTIFICATION);
    expect(note?.params).toEqual({ content: "hello", meta: { channel_id: "chan", seq: "7" } });
  });

  it("rejects non-string content, non-identifier keys, and non-string meta values", () => {
    const { server } = harness();
    expect(() => server.notifyChannel(42 as never, {})).toThrow(/content must be a string/);
    expect(() => server.notifyChannel("hello", { "not-valid": "x" })).toThrow(
      /key is not an identifier/
    );
    expect(() => server.notifyChannel("hello", { seq: 7 } as never)).toThrow(
      /value must be a string/
    );
  });

  it("serializes notifications and waits for callback plus drain before the next write", async () => {
    const input = new PassThrough();
    const output = new ControlledWritable();
    const server = new McpStdioServer(input, output, {
      serverName: "vibestudio",
      serverVersion: "0.0.0",
      instructions: "test",
      tools: [],
      onToolCall: async () => toolText("ok"),
    });
    server.start();

    let firstSettled = false;
    const first = server.notifyChannel("first", { seq: "1" }).then(() => {
      firstSettled = true;
    });
    const second = server.notifyChannel("second", { seq: "2" });
    await turn();
    expect(output.chunks).toHaveLength(1);
    expect(firstSettled).toBe(false);

    output.completeOne();
    await first;
    await turn();
    expect(output.chunks).toHaveLength(2);
    expect(output.chunks[0]).toContain('"content":"first"');
    expect(output.chunks[1]).toContain('"content":"second"');
    output.completeOne();
    await second;
  });

  it("handles a synchronous write callback without losing acceptance", async () => {
    const events = new EventEmitter();
    const chunks: string[] = [];
    const output = Object.assign(events, {
      write(chunk: string, callback: (error?: Error | null) => void): boolean {
        chunks.push(chunk);
        callback();
        return true;
      },
    }) as unknown as Writable;
    const server = new McpStdioServer(new PassThrough(), output, {
      serverName: "vibestudio",
      serverVersion: "0.0.0",
      instructions: "test",
      tools: [],
      onToolCall: async () => toolText("ok"),
    });
    server.start();
    await server.notifyChannel("one", { seq: "1" });
    expect(chunks).toHaveLength(1);
  });

  it.each(["error", "close"] as const)(
    "rejects active and queued writes when stdout emits %s",
    async (terminal) => {
      const output = new ControlledWritable();
      const server = new McpStdioServer(new PassThrough(), output, {
        serverName: "vibestudio",
        serverVersion: "0.0.0",
        instructions: "test",
        tools: [],
        onToolCall: async () => toolText("ok"),
      });
      server.start();
      void server.whenInitialized().catch(() => undefined);
      const first = server.notifyChannel("first", { seq: "1" });
      const second = server.notifyChannel("second", { seq: "2" });
      await turn();
      if (terminal === "error") output.emit("error", new Error("stdout exploded"));
      else output.emit("close");
      await expect(first).rejects.toThrow(terminal === "error" ? /stdout exploded/ : /closed/);
      await expect(second).rejects.toThrow(terminal === "error" ? /stdout exploded/ : /closed/);
    }
  );

  it("errors unknown methods and surfaces tool errors as isError results", async () => {
    const { sent, send, flush } = harness({
      onToolCall: async () => {
        throw new Error("boom");
      },
    });
    send({ jsonrpc: "2.0", id: 9, method: "nope" });
    send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "say", arguments: {} } });
    await flush();
    expect(sent[0]!.error?.code).toBe(-32601);
    expect(sent[1]!.result!["isError"]).toBe(true);
  });

  it("declares and serves resources when the hooks are provided", async () => {
    const { sent, send, flush } = harness({
      resources: {
        list: async () => [
          { uri: "vibestudio-skill://subagents", name: "subagents", mimeType: "text/markdown" },
        ],
        read: async (uri) => ({
          contents: [{ uri, mimeType: "text/markdown", text: "# Subagents" }],
        }),
      },
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "resources/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "vibestudio-skill://subagents" },
    });
    send({ jsonrpc: "2.0", id: 4, method: "resources/read", params: {} });
    await flush();

    // Async handlers may respond out of submission order — index by request id.
    const byId = new Map(sent.map((message) => [message.id, message]));
    const caps = byId.get(1)!.result!["capabilities"] as Record<string, unknown>;
    expect(caps["resources"]).toEqual({});
    expect(byId.get(2)!.result!["resources"]).toEqual([
      { uri: "vibestudio-skill://subagents", name: "subagents", mimeType: "text/markdown" },
    ]);
    expect(byId.get(3)!.result!["contents"]).toEqual([
      { uri: "vibestudio-skill://subagents", mimeType: "text/markdown", text: "# Subagents" },
    ]);
    expect(byId.get(4)!.error?.code).toBe(-32602);
  });

  it("rejects resource methods when no resources are configured", async () => {
    const { sent, send, flush } = harness();
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "resources/list" });
    await flush();
    const caps = sent[0]!.result!["capabilities"] as Record<string, unknown>;
    expect(caps["resources"]).toBeUndefined();
    expect(sent[1]!.error?.code).toBe(-32601);
  });
});
