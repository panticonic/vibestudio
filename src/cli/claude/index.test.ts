import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { findContextMarker, writeToHookSocket } from "./index.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("findContextMarker", () => {
  it("discovers the marker in a parent directory (cwd-upward search)", () => {
    const marker = {
      contextId: "ctx-42",
      workspaceId: "ws",
      serverUrl: "http://127.0.0.1:5000/rpc",
    };
    fs.writeFileSync(path.join(tmpRoot, ".vibestudio-context.json"), JSON.stringify(marker));
    const nested = path.join(tmpRoot, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    const found = findContextMarker(nested);
    expect(found).not.toBeNull();
    expect(found?.contextId).toBe("ctx-42");
    expect(found?.serverUrl).toBe("http://127.0.0.1:5000/rpc");
  });

  it("returns null when no marker exists in any ancestor", () => {
    const nested = path.join(tmpRoot, "x", "y");
    fs.mkdirSync(nested, { recursive: true });
    expect(findContextMarker(nested)).toBeNull();
  });

  it("returns null for an invalid marker file", () => {
    fs.writeFileSync(path.join(tmpRoot, ".vibestudio-context.json"), "{ not json");
    expect(findContextMarker(tmpRoot)).toBeNull();
  });
});

describe("writeToHookSocket", () => {
  it("writes one JSON line to the unix socket", async () => {
    const socketPath = path.join(tmpRoot, "hook.sock");
    const received: string[] = [];
    const server = net.createServer((sock) => {
      sock.setEncoding("utf8");
      sock.on("data", (chunk: Buffer | string) => received.push(chunk.toString()));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const line = JSON.stringify({ event: "SessionStart", payload: { a: 1 }, ts: 123 });
    await writeToHookSocket(socketPath, line);

    // Give the server a tick to flush the received data.
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.close();

    expect(received.join("")).toBe(`${line}\n`);
  });

  it("resolves without throwing when the socket does not exist", async () => {
    const missing = path.join(tmpRoot, "does-not-exist.sock");
    await expect(writeToHookSocket(missing, "x")).resolves.toBeUndefined();
  });
});
