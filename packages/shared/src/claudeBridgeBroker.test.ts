import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeBridgeBrokerClient,
  startClaudeBridgeBroker,
  type ClaudeBridgeAuthority,
  type ClaudeBridgeJson,
} from "./claudeBridgeBroker.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-broker-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function authority(): ClaudeBridgeAuthority & { close: ReturnType<typeof vi.fn> } {
  return {
    async *openBridge(_input, signal) {
      yield { kind: "subscribed", result: { pendingCount: 1 } };
      yield {
        kind: "event",
        payload: { kind: "message", seq: 1, content: "hello", meta: { channel_id: "chan" } },
      };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
    },
    say: vi.fn(async ({ text }) => ({ messageId: "m1", channelId: text })),
    complete: vi.fn(async () => ({ ok: true })),
    requestPermission: vi.fn(async () => ({ ok: true })),
    ackDelivery: vi.fn(async () => ({ ok: true })),
    ingestHookEvent: vi.fn(async () => ({ ok: true })),
    listSkills: vi.fn(async () => [] as ClaudeBridgeJson),
    readSkill: vi.fn(async ({ name }) => `# ${name}`),
    linkedStatus: vi.fn(async () => ({ attached: true })),
    onRecovery: vi.fn(async () => () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("Claude bridge broker", () => {
  it("binds atomically with private permissions and unlinks on owner close", async () => {
    const socketPath = path.join(root, "generation", "bridge.sock");
    const auth = authority();
    const broker = await startClaudeBridgeBroker({
      socketPath,
      generation: "generation-1",
      authority: auth,
    });
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    const client = new ClaudeBridgeBrokerClient(socketPath, "generation-1");
    await expect(client.call("readSkill", { name: "review" })).resolves.toBe("# review");
    await client.close();
    await broker.close();
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(auth.close).toHaveBeenCalledOnce();
  });

  it("exposes exact operations and cancels the response-owned stream", async () => {
    const socketPath = path.join(root, "bridge.sock");
    const auth = authority();
    const broker = await startClaudeBridgeBroker({
      socketPath,
      generation: "generation-2",
      authority: auth,
    });
    const client = new ClaudeBridgeBrokerClient(socketPath, "generation-2");
    await expect(client.call("say", { text: "reply", idempotencyKey: "mcp:1" })).resolves.toEqual({
      messageId: "m1",
      channelId: "reply",
    });
    const controller = new AbortController();
    const records: unknown[] = [];
    for await (const record of client.openBridge(
      {
        sessionInfo: {
          bridge: "bridge:1",
          mode: "launched",
          pid: 10,
          agentKind: "claude-code",
          channelReadiness: {
            mcpTransport: "initialized",
            channelRegistration: "unconfirmed",
            reason: "claude-protocol-has-no-registration-ack",
          },
        },
      },
      controller.signal
    )) {
      records.push(record);
      if (records.length === 2) controller.abort();
    }
    expect(records).toHaveLength(2);
    await client.close();
    await broker.close();
  });

  it("keeps the channel stream owned by its client when a status client disconnects", async () => {
    const socketPath = path.join(root, "bridge.sock");
    const auth = authority();
    const broker = await startClaudeBridgeBroker({
      socketPath,
      generation: "multiplex",
      authority: auth,
    });
    const channelClient = new ClaudeBridgeBrokerClient(socketPath, "multiplex");
    const statusClient = new ClaudeBridgeBrokerClient(socketPath, "multiplex");
    const controller = new AbortController();
    const iterator = channelClient
      .openBridge(
        {
          sessionInfo: {
            bridge: "bridge:1",
            mode: "launched",
            pid: 10,
            agentKind: "claude-code",
            channelReadiness: {
              mcpTransport: "initialized",
              channelRegistration: "unconfirmed",
              reason: "claude-protocol-has-no-registration-ack",
            },
          },
        },
        controller.signal
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "subscribed" } });
    await expect(statusClient.call("linkedStatus", {})).resolves.toEqual({ attached: true });
    await statusClient.close();
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "event" } });
    controller.abort();
    await iterator.next();
    await channelClient.close();
    await broker.close();
  });

  it("aborts and joins an open stream before owner close returns", async () => {
    const socketPath = path.join(root, "bridge.sock");
    let streamAborted = false;
    const auth = authority();
    auth.openBridge = async function* (_input, signal) {
      yield { kind: "subscribed", result: { pendingCount: 0 } };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      streamAborted = signal.aborted;
    };
    const broker = await startClaudeBridgeBroker({
      socketPath,
      generation: "owner-close",
      authority: auth,
    });
    const client = new ClaudeBridgeBrokerClient(socketPath, "owner-close");
    const iterator = client
      .openBridge(
        {
          sessionInfo: {
            bridge: "bridge:1",
            mode: "launched",
            pid: 10,
            agentKind: "claude-code",
            channelReadiness: {
              mcpTransport: "initialized",
              channelRegistration: "unconfirmed",
              reason: "claude-protocol-has-no-registration-ack",
            },
          },
        },
        new AbortController().signal
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "subscribed" } });
    const waiting = iterator.next().catch(() => ({ done: true as const, value: undefined }));
    await broker.close();
    await waiting;
    expect(streamAborted).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("rolls back a bound endpoint when recovery registration fails", async () => {
    const socketPath = path.join(root, "bridge.sock");
    const auth = authority();
    auth.onRecovery = vi.fn(async () => {
      throw new Error("recovery registration failed");
    });
    await expect(
      startClaudeBridgeBroker({ socketPath, generation: "startup-failure", authority: auth })
    ).rejects.toThrow("recovery registration failed");
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(auth.close).toHaveBeenCalledOnce();
  });

  it("still unlinks the endpoint when authority close reports an error", async () => {
    const socketPath = path.join(root, "bridge.sock");
    const auth = authority();
    auth.close.mockRejectedValueOnce(new Error("authority close failed"));
    const broker = await startClaudeBridgeBroker({
      socketPath,
      generation: "close-failure",
      authority: auth,
    });
    await expect(broker.close()).rejects.toThrow("authority close failed");
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("lets a client owner close before a nonresponsive endpoint becomes ready", async () => {
    const socketPath = path.join(root, "unresponsive.sock");
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const client = new ClaudeBridgeBrokerClient(socketPath, "never-ready");
    await expect(client.close()).resolves.toBeUndefined();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects another generation without serving authority", async () => {
    const socketPath = path.join(root, "bridge.sock");
    const auth = authority();
    const broker = await startClaudeBridgeBroker({
      socketPath,
      generation: "correct",
      authority: auth,
    });
    const client = new ClaudeBridgeBrokerClient(socketPath, "wrong");
    await expect(client.call("linkedStatus", {})).rejects.toThrow(/generation|closed/i);
    expect(auth.linkedStatus).not.toHaveBeenCalled();
    await broker.close();
  });

  it("rejects strict payload drift before invoking authority", async () => {
    const socketPath = path.join(root, "bridge.sock");
    const auth = authority();
    const broker = await startClaudeBridgeBroker({
      socketPath,
      generation: "strict",
      authority: auth,
    });
    const client = new ClaudeBridgeBrokerClient(socketPath, "strict");
    await expect(
      client.call("say", { text: "reply", idempotencyKey: "mcp:1", secret: "escape" } as never)
    ).rejects.toThrow();
    expect(auth.say).not.toHaveBeenCalled();
    await expect(
      client.call("requestPermission", {
        requestId: "abclm",
        toolName: "Bash",
        description: "Run command",
        inputPreview: "npm test",
      })
    ).rejects.toThrow();
    expect(auth.requestPermission).not.toHaveBeenCalled();
    await expect(
      client.call("requestPermission", {
        requestId: "abcde",
        toolName: "Bash",
        description: "Run command",
        inputPreview: "npm test",
      })
    ).resolves.toEqual({ ok: true });
    await client.close();
    await broker.close();
  });
});
