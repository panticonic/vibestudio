import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  CHANNEL_NOTIFICATION,
  McpStdioServer,
  PERMISSION_REQUEST_NOTIFICATION,
  PERMISSION_VERDICT_NOTIFICATION,
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

describe("McpStdioServer", () => {
  it("answers initialize with channel capabilities and instructions", async () => {
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
    expect(result["protocolVersion"]).toBe("2025-01-01");
    const caps = result["capabilities"] as Record<string, Record<string, unknown>>;
    expect(caps["experimental"]).toHaveProperty(["claude/channel"]);
    expect(caps["experimental"]).toHaveProperty(["claude/channel/permission"]);
    expect(result["instructions"]).toBe("test instructions");
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

  it("relays permission requests in and verdicts out", async () => {
    const requests: string[] = [];
    const { server, sent, send, flush } = harness({
      onPermissionRequest: (params) => requests.push(params.request_id),
    });
    send({
      jsonrpc: "2.0",
      method: PERMISSION_REQUEST_NOTIFICATION,
      params: { request_id: "pr-1", tool_name: "Bash", input_preview: "npm install" },
    });
    await flush();
    expect(requests).toEqual(["pr-1"]);

    server.notifyPermission("pr-1", "allow");
    await flush();
    const verdict = sent.find((m) => m.method === PERMISSION_VERDICT_NOTIFICATION);
    expect(verdict?.params).toEqual({ request_id: "pr-1", behavior: "allow" });
  });

  it("pushes channel notifications with content + meta", async () => {
    const { server, sent, flush } = harness();
    server.notifyChannel("hello", { channel_id: "chan", seq: 7 });
    await flush();
    const note = sent.find((m) => m.method === CHANNEL_NOTIFICATION);
    expect(note?.params).toEqual({ content: "hello", meta: { channel_id: "chan", seq: 7 } });
  });

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
});
