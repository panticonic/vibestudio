import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeMarker, writeState } from "./contextCommands.js";
import type { RpcClient } from "./rpcClient.js";

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-mirror-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A mock RpcClient whose `call` dispatches from a fixed method→result map. */
function mockClient(results: Record<string, (args: unknown[]) => unknown>): RpcClient {
  return {
    call: async (method: string, args: unknown[] = []) => {
      const fn = results[method];
      if (!fn) throw new Error(`unexpected call ${method}`);
      return fn(args);
    },
  } as unknown as RpcClient;
}

describe("context mirror write path", () => {
  it("writes every streamed file with its mode and decoded bytes", async () => {
    const dir = mkTemp();
    let pages = 0;
    const client = mockClient({
      "mirror.objects": ([arg]) => {
        const { cursor } = arg as { cursor?: string };
        if (!cursor) {
          pages++;
          return {
            files: [
              {
                path: "src/a.ts",
                mode: 33188,
                content: Buffer.from("A\n").toString("base64"),
                size: 2,
              },
            ],
            next: "1",
          };
        }
        pages++;
        return {
          files: [
            {
              path: "bin/run",
              mode: 33261,
              content: Buffer.from("#!/bin/sh\n").toString("base64"),
              size: 10,
            },
          ],
        };
      },
    });

    const written = await writeState(client, "state-x", path.join(dir, "packages/x"));
    expect(written).toBe(2);
    expect(pages).toBe(2); // paged via the `next` cursor
    expect(fs.readFileSync(path.join(dir, "packages/x/src/a.ts"), "utf8")).toBe("A\n");
    const runPath = path.join(dir, "packages/x/bin/run");
    expect(fs.readFileSync(runPath, "utf8")).toBe("#!/bin/sh\n");
    // Executable mode preserved from git-style 33261.
    expect(fs.statSync(runPath).mode & 0o111).not.toBe(0);
  });

  it("drops the .vibestudio-context.json marker with contextId + workspaceId + serverUrl", async () => {
    const dir = mkTemp();
    const client = mockClient({
      "auth.getConnectionInfo": () => ({ workspaceId: "ws_42" }),
    });
    await writeMarker(client, dir, "ctx_7", "https://server.example");
    const marker = JSON.parse(fs.readFileSync(path.join(dir, ".vibestudio-context.json"), "utf8"));
    expect(marker).toEqual({
      contextId: "ctx_7",
      workspaceId: "ws_42",
      serverUrl: "https://server.example",
    });
  });

  it("still writes a usable marker when workspaceId can't be resolved", async () => {
    const dir = mkTemp();
    const client = mockClient({
      "auth.getConnectionInfo": () => {
        throw new Error("offline");
      },
    });
    await writeMarker(client, dir, "ctx_7", "https://server.example");
    const marker = JSON.parse(fs.readFileSync(path.join(dir, ".vibestudio-context.json"), "utf8"));
    expect(marker).toEqual({ contextId: "ctx_7", serverUrl: "https://server.example" });
  });
});
