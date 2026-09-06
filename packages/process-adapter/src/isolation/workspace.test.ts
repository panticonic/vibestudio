import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSandbox } from "./workspace.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("./prerequisites.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prerequisites.js")>()),
  assertMxcPrerequisites: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", () => ({
  realpath: async (value: string) => value,
  open: async () => ({ writeFile: async () => {}, sync: async () => {}, close: async () => {} }),
}));

afterEach(() => vi.useRealTimers());

// This tests the HOST's response to an untrusted control peer; native resource
// enforcement is covered separately by workspace.integration.test.ts.
it.each([false, true])(
  "bounds post-exit retention (launcher pipes retained: %s)",
  async (retainPipes) => {
    vi.useFakeTimers();
    const peer = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const frames: Array<Record<string, unknown>> = [];
    peer.stdin.on("data", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame["type"] === "shutdown" && !retainPipes) peer.emit("close", 0);
    });
    vi.mocked(spawn).mockImplementation(() => {
      Promise.resolve().then(() => peer.stdout.write('{"type":"ready"}\n'));
      return peer as unknown as ReturnType<typeof spawn>;
    });
    const root = path.resolve("fixture");
    const runtime = path.join(root, "runtime");
    const home = path.join(root, "state");
    const sandbox = await WorkspaceSandbox.start(
      {
        version: 1,
        owner: {
          workspaceId: "fixture",
          contextId: null,
          runtimeId: "fixture",
          incarnation: "fixture",
          executionDigest: "fixture",
        },
        privateRoot: root,
        executable: path.join(runtime, "node"),
        args: [],
        cwd: home,
        home,
        environment: {},
        read: [runtime],
        write: [home],
        sockets: [],
      },
      {
        platform: process.platform as "linux" | "darwin" | "win32",
        launcher: path.join(root, "launcher"),
        workspaceEntry: path.join(runtime, "workspaceChild.js"),
      }
    );
    try {
      const command = sandbox.fork(path.join(runtime, "command.js"), {});
      const id = frames[0]!["id"];
      const send = (type: string, values: Record<string, unknown> = {}) => {
        peer.stdout.write(JSON.stringify({ type, id, ...values }) + "\n");
      };
      const received = vi.fn();
      const exited = vi.fn();
      command.on("message", received);
      command.on("exit", exited);
      const ended = vi.fn();
      command.stdout!.on("end", ended);
      let output = "";
      command.stdout!.on("data", (data) => {
        output += String(data);
      });
      send("exit", { code: 0 });
      send("stdout", { data: Buffer.from("tail").toString("base64") });
      send("message", { value: "post-exit forged message" });
      await vi.advanceTimersByTimeAsync(500);
      send("exit", { code: 1 }); // Cannot extend the drain deadline.
      await vi.advanceTimersByTimeAsync(501);
      send("stdout", { data: Buffer.from("late").toString("base64") });
      expect(output).toBe("tail");
      expect(ended).toHaveBeenCalledOnce();
      expect(received).not.toHaveBeenCalled();
      expect(exited).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      if (retainPipes) peer.emit("exit", 0);
      const stopping = sandbox.stop();
      await vi.advanceTimersByTimeAsync(4001);
      expect((await stopping).launcherExited).toBe(true);
      expect(peer.stdin.destroyed).toBe(true);
      expect(peer.stdout.destroyed).toBe(true);
      expect(peer.stderr.destroyed).toBe(true);
    }
  }
);

it.each([false, true])(
  "retains late native diagnostics after startup stdout closes (executor hangs: %s)",
  async (hangs) => {
    vi.useFakeTimers();
    const peer = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        peer.emit("close", null, "SIGKILL");
        return true;
      }),
      unref: vi.fn(),
    });
    vi.mocked(spawn).mockImplementation(() => {
      setTimeout(() => peer.stdout.end(), 1);
      setTimeout(() => {
        peer.stderr.write("native policy rejected: precise diagnostic");
        if (!hangs) peer.emit("close", 1, null);
      }, 20);
      return peer as unknown as ReturnType<typeof spawn>;
    });
    const root = path.resolve("fixture");
    const runtime = path.join(root, "runtime");
    const home = path.join(root, "state");
    const pending = WorkspaceSandbox.start(
      {
        version: 1,
        owner: {
          workspaceId: "fixture",
          contextId: null,
          runtimeId: "fixture",
          incarnation: "fixture",
          executionDigest: "fixture",
        },
        privateRoot: root,
        executable: path.join(runtime, "node"),
        args: [],
        cwd: home,
        home,
        environment: {},
        read: [runtime],
        write: [home],
        sockets: [],
      },
      {
        platform: process.platform as "linux" | "darwin" | "win32",
        launcher: path.join(root, "launcher"),
        workspaceEntry: path.join(runtime, "workspaceChild.js"),
      }
    );
    const rejection = expect(pending).rejects.toThrow("native policy rejected: precise diagnostic");
    await vi.advanceTimersByTimeAsync(10);
    expect(peer.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(hangs ? 14001 : 50);
    await rejection;
    expect(peer.stdin.destroyed).toBe(true);
    expect(peer.stdout.destroyed).toBe(true);
    expect(peer.stderr.destroyed).toBe(true);
  }
);
