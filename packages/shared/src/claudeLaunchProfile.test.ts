import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertClaudeCodeVersion,
  claudeLaunchProfile,
  materializeClaudeLaunch,
  parseClaudeLaunchProfile,
  removeMaterializedClaudeLaunch,
} from "./claudeLaunchProfile.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "claude-launch-profile-"));
});

afterEach(async () => {
  await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
});

function profile() {
  return claudeLaunchProfile({
    launchId: "session:channel/one",
    environment: {
      VIBESTUDIO_AGENT_TOKEN: "agent:one:secret",
      VIBESTUDIO_ENTITY_ID: "entity-one",
      VIBESTUDIO_CONTEXT_ID: "context-one",
      VIBESTUDIO_CHANNEL_ID: "channel-one",
      VIBESTUDIO_VESSEL_REF: "do:linked:one",
    },
  });
}

describe("ClaudeLaunchProfile", () => {
  it("contains semantic identity only and rejects legacy host fields", () => {
    const declaration = profile();
    expect(JSON.stringify(declaration)).not.toMatch(/SERVER_URL|LAUNCH_PROFILE|SKILLS_DIR/);
    expect(() =>
      parseClaudeLaunchProfile({ ...declaration, contextFolder: "/server/context" })
    ).toThrow();
    expect(() =>
      parseClaudeLaunchProfile({
        ...declaration,
        environment: {
          ...declaration.environment,
          VIBESTUDIO_SERVER_URL: "http://server-only",
        },
      })
    ).toThrow();
  });

  it("materializes exact local paths, reach, permissions, and hook configuration", async () => {
    const profilesRoot = path.join(root, "profiles");
    const launch = await materializeClaudeLaunch({
      profile: profile(),
      profilesRoot,
      serverUrl: "webrtc://local-pairing/_workspace/dev",
    });

    expect(launch.profileDir.startsWith(profilesRoot)).toBe(true);
    expect(launch.argv).toEqual([
      "claude",
      "--channels",
      "server:vibestudio",
      "--dangerously-load-development-channels",
      "--mcp-config",
      path.join(launch.profileDir, "mcp.json"),
      "--settings",
      path.join(launch.profileDir, "settings.json"),
    ]);
    expect(launch.env).toMatchObject({
      VIBESTUDIO_SERVER_URL: "webrtc://local-pairing/_workspace/dev",
      VIBESTUDIO_LAUNCH_PROFILE: launch.profileDir,
    });
    const settings = JSON.parse(
      await readFile(path.join(launch.profileDir, "settings.json"), "utf8")
    );
    expect(settings).not.toHaveProperty("env");
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      "vibestudio claude emit SessionStart"
    );
    const mcp = JSON.parse(await readFile(path.join(launch.profileDir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.vibestudio).toEqual({
      command: "vibestudio",
      args: ["claude", "channel-host"],
    });
    expect((await stat(launch.profileDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(launch.profileDir, "env.json"))).mode & 0o777).toBe(0o600);
  });

  it("releases one exact materialization without deleting a newer generation", async () => {
    const profilesRoot = path.join(root, "profiles");
    const first = await materializeClaudeLaunch({
      profile: profile(),
      profilesRoot,
      serverUrl: "http://first",
    });
    const second = await materializeClaudeLaunch({
      profile: profile(),
      profilesRoot,
      serverUrl: "http://second",
    });
    expect(second.profileDir).not.toBe(first.profileDir);
    expect(
      JSON.parse(await readFile(path.join(second.profileDir, "env.json"), "utf8"))
    ).toMatchObject({
      VIBESTUDIO_SERVER_URL: "http://second",
    });
    await removeMaterializedClaudeLaunch(first);
    await expect(stat(first.profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(second.profileDir)).resolves.toBeDefined();
    await removeMaterializedClaudeLaunch(second);
  });

  it("validates the binary version on the caller-selected host", async () => {
    await expect(assertClaudeCodeVersion(async () => "2.1.81 (Claude Code)")).resolves.toBe(
      "2.1.81"
    );
    await expect(assertClaudeCodeVersion(async () => "2.1.80")).rejects.toThrow(/too old/);
    await expect(
      assertClaudeCodeVersion(async () => {
        throw new Error("missing");
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
