import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { TerminalControlOperation } from "@vibestudio/shared/terminalControlProtocol";
import { TerminalControlServer } from "./terminalControlServer.js";

const TEST_HOST_BUILD_ID = "a".repeat(64);

describe("TerminalControlServer", () => {
  it.skipIf(process.platform === "win32")("creates the socket directory with private permissions", async () => {
    const server = new TerminalControlServer(makeOps(), { hostBuildId: TEST_HOST_BUILD_ID });
    await server.start();
    const { env, token } = server.envForSession({});
    const socketPath = env["VIBESTUDIO_TERMINAL_ENDPOINT"];
    if (!socketPath) throw new Error("missing VIBESTUDIO_TERMINAL_ENDPOINT");
    await waitForStat(socketPath);

    expect((await stat(dirname(socketPath))).mode & 0o777).toBe(0o700);

    server.discardPending(token);
    await server.dispose();
  });

  it("discards pending session sockets that never register", async () => {
    const server = new TerminalControlServer(makeOps(), { hostBuildId: TEST_HOST_BUILD_ID });
    await server.start();
    const { env, token } = server.envForSession({});
    const socketPath = env["VIBESTUDIO_TERMINAL_ENDPOINT"];
    if (!socketPath) throw new Error("missing VIBESTUDIO_TERMINAL_ENDPOINT");
    await waitForStat(socketPath);

    server.discardPending(token);

    await waitForMissing(socketPath);
    await server.dispose();
  });

  it("creates a Windows named-pipe endpoint", async () => {
    const env = { PATH: "existing" };
    const server = new TerminalControlServer(makeOps(), {
      platform: "win32",
      hostBuildId: TEST_HOST_BUILD_ID,
    });

    await server.start();
    const result = server.envForSession(env);
    server.register(result.token, "session");
    server.discardPending(result.token);

    expect(result.token).not.toBe("");
    expect(result.env["VIBESTUDIO_TERMINAL_ENDPOINT"]).toMatch(
      /^\\\\\.\\pipe\\vibestudio-terminal-/
    );
    await server.dispose();
  });

  it("rejects terminal send to sessions owned by another caller", async () => {
    const writes: Array<{ sessionId: string; text: string }> = [];
    const owners = new Map([
      ["source", "panel:a"],
      ["same-owner", "panel:a"],
      ["other-owner", "panel:b"],
    ]);
    const server = new TerminalControlServer({
      list: () => [],
      setMeta: () => {},
      getMeta: () => undefined,
      deleteMeta: () => {},
      setLabel: () => {},
      write: (sessionId, text) => writes.push({ sessionId, text }),
      ownerOf: (sessionId) => owners.get(sessionId),
      openSplit: async () => "unused",
      openUrl: async () => {},
    }, { hostBuildId: TEST_HOST_BUILD_ID });
    await server.start();
    const { env, token } = server.envForSession({});
    const socketPath = env["VIBESTUDIO_TERMINAL_ENDPOINT"];
    if (!socketPath) throw new Error("missing VIBESTUDIO_TERMINAL_ENDPOINT");
    await waitForStat(socketPath);
    server.register(token, "source");

    await expect(sendTerminal(socketPath, { kind: "send", targetSessionId: "same-owner", text: "hello" })).resolves.toEqual({ ok: true });
    await expect(sendTerminal(socketPath, { kind: "send", targetSessionId: "other-owner", text: "secret" })).resolves.toMatchObject({
      ok: false,
      error: "EACCES",
    });

    expect(writes).toEqual([{ sessionId: "same-owner", text: "hello" }]);
    await server.dispose();
  });

  it("rate-limits notifications per session", async () => {
    const server = new TerminalControlServer(makeOps({ ownerOf: () => "panel:a" }), {
      hostBuildId: TEST_HOST_BUILD_ID,
    });
    await server.start();
    const { env, token } = server.envForSession({});
    const socketPath = env["VIBESTUDIO_TERMINAL_ENDPOINT"];
    if (!socketPath) throw new Error("missing VIBESTUDIO_TERMINAL_ENDPOINT");
    await waitForStat(socketPath);
    server.register(token, "source");

    const responses: unknown[] = [];
    for (let i = 1; i <= 51; i += 1) {
      responses.push(
        await sendTerminal(socketPath, {
          kind: "notify",
          severity: "info",
          title: "",
          message: `n${i}`,
        })
      );
    }

    const okResponses = responses.filter((item) => (item as { ok?: unknown }).ok === true);
    expect(okResponses).toHaveLength(50);
    expect(okResponses.every((item) => String((item as { stdout?: unknown }).stdout ?? "").includes("1337;vibestudio-terminal"))).toBe(true);
    expect(responses[50]).toMatchObject({
      ok: false,
      error: "terminal notification rate limit exceeded",
    });
    await server.dispose();
  });
});

function makeOps(overrides: Partial<ConstructorParameters<typeof TerminalControlServer>[0]> = {}): ConstructorParameters<typeof TerminalControlServer>[0] {
  return {
    list: () => [],
    setMeta: () => {},
    getMeta: () => undefined,
    deleteMeta: () => {},
    setLabel: () => {},
    write: () => {},
    ownerOf: () => undefined,
    openSplit: async () => "unused",
    openUrl: async () => {},
    ...overrides,
  };
}

async function waitForStat(path: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForMissing(path: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      await stat(path);
    } catch {
      return;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path} removal`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendTerminal(socketPath: string, operation: TerminalControlOperation): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({
          protocolVersion: 1,
          hostBuildId: TEST_HOST_BUILD_ID,
          pid: process.pid,
          operation,
        }) + "\n"
      );
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", reject);
  });
}
