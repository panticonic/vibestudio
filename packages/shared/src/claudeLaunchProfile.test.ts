import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  assertClaudeCodeVersion,
  claudeLaunchProfile,
  materializeClaudeLaunch,
  parseClaudeLaunchProfile,
  reconcileClaudeLaunchCredential,
  removeMaterializedClaudeLaunch,
} from "./claudeLaunchProfile.js";

let root: string;
const execFileAsync = promisify(execFile);
const AGENT_ID = `agt_${"a".repeat(24)}`;
const AGENT_TOKEN = `agent:${AGENT_ID}:${"s".repeat(43)}`;
const SERVER_ID = `srv_${"s".repeat(24)}`;
const PAIRING = {
  room: "local-pairing",
  fp: "AA".repeat(32),
  sig: "wss://signal.example/",
  v: 2 as const,
  ice: "all" as const,
};

function directRoute(url: string) {
  return {
    url,
    serverId: SERVER_ID,
    workspaceId: "workspace-dev",
    workspaceName: "dev",
  };
}

const installedClaude = (process.env["PATH"] ?? "")
  .split(path.delimiter)
  .map((directory) => path.join(directory, "claude"))
  .find((candidate) => existsSync(candidate));

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
      VIBESTUDIO_AGENT_TOKEN: AGENT_TOKEN,
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
      cliRoute: {
        ...directRoute("webrtc://local-pairing/_workspace/dev"),
        workspacePairing: PAIRING,
      },
      hostClaudeConfigDirectory: path.join(root, "missing-host-config"),
    });

    expect(launch.profileDir.startsWith(profilesRoot)).toBe(true);
    expect(launch.argv).toEqual([
      "claude",
      "--dangerously-load-development-channels",
      "server:vibestudio",
      "--mcp-config",
      path.join(launch.profileDir, "mcp.json"),
      "--settings",
      path.join(launch.profileDir, "settings.json"),
    ]);
    expect(launch.env).toMatchObject({
      VIBESTUDIO_LAUNCH_PROFILE: launch.profileDir,
      VIBESTUDIO_ENTITY_ID: "entity-one",
      VIBESTUDIO_VESSEL_REF: "do:linked:one",
      CLAUDE_CONFIG_DIR: path.join(launch.profileDir, "claude-config"),
    });
    expect(launch.env).not.toHaveProperty("VIBESTUDIO_AGENT_TOKEN");
    expect(launch.env).not.toHaveProperty("VIBESTUDIO_SERVER_URL");
    const settings = JSON.parse(
      await readFile(path.join(launch.profileDir, "settings.json"), "utf8")
    );
    expect(settings).not.toHaveProperty("env");
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      "vibestudio claude emit SessionStart"
    );
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].command).toBe(
      "vibestudio claude emit PostToolUseFailure"
    );
    expect(settings.hooks.StopFailure[0].hooks[0].command).toBe(
      "vibestudio claude emit StopFailure"
    );
    const mcp = JSON.parse(await readFile(path.join(launch.profileDir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.vibestudio).toEqual({
      command: "vibestudio",
      args: ["claude", "channel-host"],
    });
    expect((await stat(launch.profileDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(launch.profileDir, "env.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(launch.cliCredentialPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(launch.cliCredentialPath, "utf8"))).toEqual({
      schemaVersion: 1,
      kind: "agent",
      url: "webrtc://local-pairing/_workspace/dev",
      workspaceId: "workspace-dev",
      workspaceName: "dev",
      serverId: SERVER_ID,
      entityId: "entity-one",
      contextId: "context-one",
      agentId: AGENT_ID,
      agentToken: AGENT_TOKEN,
      workspacePairing: PAIRING,
      signedInAt: expect.any(Number),
    });
    const diagnostic = await readFile(path.join(launch.profileDir, "env.json"), "utf8");
    expect(diagnostic).not.toContain(AGENT_TOKEN);
    expect(diagnostic).not.toContain("webrtc://local-pairing");
  });

  it.runIf(installedClaude !== undefined)(
    "confirms the installed Claude parser requires an entry for the development-channel flag",
    async () => {
      let failure: (Error & { stderr?: string }) | null = null;
      try {
        await execFileAsync(installedClaude!, ["--dangerously-load-development-channels"]);
      } catch (error) {
        failure = error as Error & { stderr?: string };
      }
      expect(failure?.stderr).toMatch(
        /--dangerously-load-development-channels <servers\.\.\.>.*argument missing/
      );
    }
  );

  it("releases one exact materialization without deleting a newer generation", async () => {
    const profilesRoot = path.join(root, "profiles");
    const first = await materializeClaudeLaunch({
      profile: profile(),
      profilesRoot,
      cliRoute: directRoute("http://first"),
      hostClaudeConfigDirectory: path.join(root, "missing-host-config"),
    });
    const second = await materializeClaudeLaunch({
      profile: profile(),
      profilesRoot,
      cliRoute: directRoute("http://second"),
      hostClaudeConfigDirectory: path.join(root, "missing-host-config"),
    });
    expect(second.profileDir).not.toBe(first.profileDir);
    const secondDiagnostic = await readFile(path.join(second.profileDir, "env.json"), "utf8");
    expect(secondDiagnostic).not.toContain("http://second");
    expect(secondDiagnostic).not.toContain(AGENT_TOKEN);
    await removeMaterializedClaudeLaunch(first);
    await expect(stat(first.profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(second.profileDir)).resolves.toBeDefined();
    await removeMaterializedClaudeLaunch(second);
  });

  it("refreshes a launch-local host login with compare-and-swap semantics", async () => {
    const profilesRoot = path.join(root, "profiles");
    const hostConfig = path.join(root, "host-claude");
    const hostCredential = path.join(hostConfig, ".credentials.json");
    await mkdir(hostConfig);
    await writeFile(hostCredential, '{"accessToken":"old","refreshToken":"shared"}', {
      mode: 0o600,
    });
    const launch = await materializeClaudeLaunch({
      profile: profile(),
      profilesRoot,
      cliRoute: directRoute("http://local"),
      hostClaudeConfigDirectory: hostConfig,
    });
    const isolatedCredential = path.join(launch.env.CLAUDE_CONFIG_DIR, ".credentials.json");
    expect(await readFile(isolatedCredential, "utf8")).toContain('"accessToken":"old"');

    await writeFile(isolatedCredential, '{"accessToken":"fresh","refreshToken":"rotated"}', {
      mode: 0o600,
    });
    await expect(reconcileClaudeLaunchCredential(launch)).resolves.toEqual({
      status: "updated",
    });
    expect(await readFile(hostCredential, "utf8")).toContain('"accessToken":"fresh"');
    expect((await stat(hostCredential)).mode & 0o777).toBe(0o600);

    const conflicting = await materializeClaudeLaunch({
      profile: profile(),
      profilesRoot,
      cliRoute: directRoute("http://local"),
      hostClaudeConfigDirectory: hostConfig,
    });
    await writeFile(
      path.join(conflicting.env.CLAUDE_CONFIG_DIR, ".credentials.json"),
      '{"accessToken":"launch-newer"}',
      { mode: 0o600 }
    );
    await writeFile(hostCredential, '{"accessToken":"host-newer"}', { mode: 0o600 });
    await expect(reconcileClaudeLaunchCredential(conflicting)).resolves.toMatchObject({
      status: "conflict",
    });
    expect(await readFile(hostCredential, "utf8")).toContain('"accessToken":"host-newer"');
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
