import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TurnTracker,
  mapHookEvent,
  startHookSocketServer,
  type BridgeHookEvent,
  type EmittedHookLine,
} from "./hookSocket.js";
import { hookFailureExitCode, writeToHookSocket } from "./index.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hook-socket-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function map(
  event: string,
  payload: unknown,
  turns: TurnTracker,
  pending = new Map<string, string>()
) {
  return mapHookEvent({ event, payload }, turns, pending);
}

describe("mapHookEvent + TurnTracker", () => {
  it("frames a prompt-driven turn: UserPromptSubmit and Stop share a turnKey", () => {
    const turns = new TurnTracker();
    const prompt = map("UserPromptSubmit", { prompt: "do it" }, turns) as Extract<
      BridgeHookEvent,
      { hook: "UserPromptSubmit" }
    >;
    map(
      "PreToolUse",
      { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tu1" },
      turns
    );
    const stop = map("Stop", {}, turns) as Extract<BridgeHookEvent, { hook: "Stop" }>;
    expect(prompt.promptText).toBe("do it");
    expect(prompt.turnKey).toBe("t1");
    expect(stop.turnKey).toBe("t1");
    // The next prompt opens a fresh turn.
    const next = map("UserPromptSubmit", { prompt: "again" }, turns) as Extract<
      BridgeHookEvent,
      { hook: "UserPromptSubmit" }
    >;
    expect(next.turnKey).toBe("t2");
  });

  it("opens an implicit turn for channel-driven activity (no UserPromptSubmit)", () => {
    const turns = new TurnTracker();
    const pre = map(
      "PreToolUse",
      { tool_name: "Bash", tool_input: {}, tool_use_id: "tu9" },
      turns
    ) as Extract<BridgeHookEvent, { hook: "PreToolUse" }>;
    expect(pre.hook).toBe("PreToolUse");
    const stop = map("Stop", {}, turns) as Extract<BridgeHookEvent, { hook: "Stop" }>;
    expect(stop.turnKey).toBe("t1");
    // A bare Stop after close still gets its own key (retroactive open server-side).
    const stop2 = map("Stop", {}, turns) as Extract<BridgeHookEvent, { hook: "Stop" }>;
    expect(stop2.turnKey).toBe("t2");
  });

  it("maps successful and failed tool hooks as distinct official events", () => {
    const turns = new TurnTracker();
    const long = "x".repeat(600);
    const pre = map(
      "PreToolUse",
      { tool_name: "Write", tool_input: { content: long }, tool_use_id: "tu2" },
      turns
    ) as Extract<BridgeHookEvent, { hook: "PreToolUse" }>;
    expect(pre.toolName).toBe("Write");
    expect(pre.toolUseId).toBe("tu2");
    expect(pre.request).toEqual({ content: long });

    const post = map(
      "PostToolUse",
      {
        tool_name: "Write",
        tool_use_id: "tu2",
        tool_response: { message: "done" },
      },
      turns
    ) as Extract<BridgeHookEvent, { hook: "PostToolUse" }>;
    expect(post.toolUseId).toBe("tu2");
    const failure = map(
      "PostToolUseFailure",
      { tool_name: "Write", tool_use_id: "tu2", error: "denied", is_interrupt: true },
      turns
    ) as Extract<BridgeHookEvent, { hook: "PostToolUseFailure" }>;
    expect(failure).toMatchObject({
      toolUseId: "tu2",
      error: "denied",
      interrupted: true,
    });
    const stopFailure = map(
      "StopFailure",
      { error: "authentication_failed", error_details: "expired" },
      turns
    ) as Extract<BridgeHookEvent, { hook: "StopFailure" }>;
    expect(stopFailure).toMatchObject({
      error: "authentication_failed",
      errorDetails: "expired",
    });
  });

  it("pairs Pre/Post via synthetic ids when tool_use_id is absent", () => {
    const turns = new TurnTracker();
    const pending = new Map<string, string>();
    const pre = map("PreToolUse", { tool_name: "Bash", tool_input: {} }, turns, pending) as Extract<
      BridgeHookEvent,
      { hook: "PreToolUse" }
    >;
    const post = map(
      "PostToolUse",
      { tool_name: "Bash", tool_response: {} },
      turns,
      pending
    ) as Extract<BridgeHookEvent, { hook: "PostToolUse" }>;
    expect(pre.toolUseId).toBe(post.toolUseId);
  });

  it("maps SessionStart model shapes and ignores unknown events", () => {
    const turns = new TurnTracker();
    const flat = map("SessionStart", { model: "claude-opus-4-8", cwd: "/x" }, turns) as Extract<
      BridgeHookEvent,
      { hook: "SessionStart" }
    >;
    expect(flat.model).toBe("claude-opus-4-8");
    const nested = map("SessionStart", { model: { display_name: "Opus" } }, turns) as Extract<
      BridgeHookEvent,
      { hook: "SessionStart" }
    >;
    expect(nested.model).toBe("Opus");
    expect(map("SomeFutureHook", {}, turns)).toBeNull();
  });
});

describe("startHookSocketServer", () => {
  it("receives emitted lines end-to-end and survives garbage", async () => {
    const socketPath = path.join(tmpRoot, "hook.sock");
    const received: EmittedHookLine[] = [];
    const server = startHookSocketServer(
      [socketPath],
      async (line) => {
        received.push(line);
      },
      () => {}
    );
    await server.ready;
    expect(server.paths).toEqual([socketPath]);

    await writeToHookSocket(socketPath, JSON.stringify({ event: "Stop", payload: { a: 1 } }));
    await expect(writeToHookSocket(socketPath, "not json at all")).rejects.toThrow(
      /hook ingestion was rejected/
    );
    await writeToHookSocket(socketPath, JSON.stringify({ event: "SessionEnd", payload: null }));

    expect(received.map((l) => l.event)).toEqual(["Stop", "SessionEnd"]);
    await server.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("unlinks a stale socket file before binding", async () => {
    const socketPath = path.join(tmpRoot, "stale.sock");
    fs.writeFileSync(socketPath, "");
    const server = startHookSocketServer(
      [socketPath],
      async () => {},
      () => {}
    );
    await server.ready;
    expect(server.paths).toEqual([socketPath]);
    await server.close();
  });

  it("acknowledges only after ordered durable ingestion and drains on close", async () => {
    const socketPath = path.join(tmpRoot, "ordered.sock");
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = startHookSocketServer(
      [socketPath],
      async (line) => {
        order.push(`start:${line.event}`);
        await blocked;
        order.push(`done:${line.event}`);
      },
      () => {}
    );
    await server.ready;
    const write = writeToHookSocket(
      socketPath,
      JSON.stringify({ event: "PostToolUse", payload: {} })
    ).then(() => order.push("ack"));
    await vi.waitFor(() => expect(order).toEqual(["start:PostToolUse"]));
    const close = server.close().then(() => order.push("closed"));
    release();
    await Promise.all([write, close]);
    expect(order).toEqual(["start:PostToolUse", "done:PostToolUse", "ack", "closed"]);
  });

  it("rejects the emitter when durable ingestion fails", async () => {
    const socketPath = path.join(tmpRoot, "reject.sock");
    const server = startHookSocketServer(
      [socketPath],
      async () => {
        throw new Error("durable write failed");
      },
      () => {}
    );
    await server.ready;
    await expect(
      writeToHookSocket(socketPath, JSON.stringify({ event: "Stop", payload: {} }))
    ).rejects.toThrow(/hook ingestion was rejected/);
    await server.close();
  });
});

describe("hook failure exit semantics", () => {
  it("fails blocking semantic hooks loudly but never recursively blocks terminal cleanup hooks", () => {
    expect(hookFailureExitCode("UserPromptSubmit")).toBe(2);
    expect(hookFailureExitCode("PreToolUse")).toBe(2);
    expect(hookFailureExitCode("PostToolUseFailure")).toBe(2);
    expect(hookFailureExitCode("SessionStart")).toBe(1);
    expect(hookFailureExitCode("Stop")).toBe(1);
    expect(hookFailureExitCode("StopFailure")).toBe(1);
    expect(hookFailureExitCode("SessionEnd")).toBe(1);
  });
});
