import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { executePreparedClaudeLaunch, findContextBinding, writeToHookSocket } from "./index.js";
import { contextBinding } from "@vibestudio/shared/contextBinding";
import { claudeLaunchProfile } from "@vibestudio/shared/claudeLaunchProfile";
import type { MaterializedClaudeLaunch } from "@vibestudio/shared/claudeLaunchProfile";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("findContextBinding", () => {
  it("discovers the binding in a parent directory (cwd-upward search)", () => {
    const binding = contextBinding({ contextId: "ctx-42", workspaceId: "ws" });
    fs.writeFileSync(path.join(tmpRoot, ".vibestudio-context.json"), JSON.stringify(binding));
    const nested = path.join(tmpRoot, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    const found = findContextBinding(nested);
    expect(found).not.toBeNull();
    expect(found?.contextId).toBe("ctx-42");
    expect(found?.workspaceId).toBe("ws");
  });

  it("returns null when no binding exists in any ancestor", () => {
    const nested = path.join(tmpRoot, "x", "y");
    fs.mkdirSync(nested, { recursive: true });
    expect(findContextBinding(nested)).toBeNull();
  });

  it("rejects an invalid binding file", () => {
    fs.writeFileSync(path.join(tmpRoot, ".vibestudio-context.json"), "{ not json");
    expect(() => findContextBinding(tmpRoot)).toThrow(/invalid context binding/);
  });

  it("rejects fields outside the canonical schema", () => {
    fs.writeFileSync(
      path.join(tmpRoot, ".vibestudio-context.json"),
      JSON.stringify({
        ...contextBinding({ contextId: "ctx-1", workspaceId: "ws" }),
        serverUrl: "http://legacy",
      })
    );
    expect(() => findContextBinding(tmpRoot)).toThrow(/unknown field/);
  });
});

describe("remote Claude launch materialization", () => {
  function prepared(contextId = "ctx-remote") {
    const vesselRef = "do:workers/linked-agent:LinkedAgentWorker:linked:entity-remote";
    return {
      entityId: "entity-remote",
      contextId,
      channelId: "channel-remote",
      vesselRef,
      profile: claudeLaunchProfile({
        launchId: "entity-remote",
        environment: {
          VIBESTUDIO_AGENT_TOKEN: "agent:remote:secret",
          VIBESTUDIO_ENTITY_ID: "entity-remote",
          VIBESTUDIO_CONTEXT_ID: contextId,
          VIBESTUDIO_CHANNEL_ID: "channel-remote",
          VIBESTUDIO_VESSEL_REF: vesselRef,
        },
      }),
    };
  }

  it("uses only local cwd/profile paths and the selected paired route, then cleans both sides", async () => {
    const contextDirectory = path.join(tmpRoot, "local-context");
    const profilesRoot = path.join(tmpRoot, "local-cli-state", "claude-launches");
    fs.mkdirSync(contextDirectory, { recursive: true });
    const release = vi.fn(async () => {});
    const spawnLaunch = vi.fn(async (launch: MaterializedClaudeLaunch, cwd: string) => {
      expect(cwd).toBe(contextDirectory);
      expect(launch.profileDir.startsWith(profilesRoot)).toBe(true);
      expect(launch.argv.join(" ")).toContain(profilesRoot);
      expect(launch.env.VIBESTUDIO_SERVER_URL).toBe("webrtc://paired/_workspace/dev");
      expect(fs.existsSync(path.join(launch.profileDir, "mcp.json"))).toBe(true);
      return 7;
    });

    await expect(
      executePreparedClaudeLaunch({
        prepared: prepared(),
        expectedContextId: "ctx-remote",
        contextDirectory,
        profilesRoot,
        serverUrl: "webrtc://paired/_workspace/dev",
        release,
        spawnLaunch,
      })
    ).resolves.toBe(7);

    expect(release).toHaveBeenCalledExactlyOnceWith("entity-remote", "entity-remote");
    expect(fs.readdirSync(profilesRoot)).toEqual([]);
  });

  it("releases a minted credential when local and prepared context identities diverge", async () => {
    const release = vi.fn(async () => {});
    const spawnLaunch = vi.fn(async () => 0);
    await expect(
      executePreparedClaudeLaunch({
        prepared: prepared("ctx-server"),
        expectedContextId: "ctx-local",
        contextDirectory: tmpRoot,
        profilesRoot: path.join(tmpRoot, "profiles"),
        serverUrl: "http://local",
        release,
        spawnLaunch,
      })
    ).rejects.toThrow(/local tree is ctx-local/);
    expect(spawnLaunch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith("entity-remote", "entity-remote");
  });

  it("preserves the launch failure when credential cleanup also fails", async () => {
    const launchError = new Error("claude process failed");
    const cleanupError = new Error("credential release failed");
    const contextDirectory = path.join(tmpRoot, "local-context");
    fs.mkdirSync(contextDirectory, { recursive: true });

    await expect(
      executePreparedClaudeLaunch({
        prepared: prepared(),
        expectedContextId: "ctx-remote",
        contextDirectory,
        profilesRoot: path.join(tmpRoot, "profiles"),
        serverUrl: "http://local",
        release: vi.fn(async () => {
          throw cleanupError;
        }),
        spawnLaunch: vi.fn(async () => {
          throw launchError;
        }),
      })
    ).rejects.toBe(launchError);
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
