import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
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

// These tests cover materialization and compare-and-swap semantics. Real MXC
// extraction/host-file denial is exercised by claudeCredentialExtraction.integration.test.ts.
vi.mock("./claudeCredentialExtraction.js", () => ({
  extractClaudeCredential: ({ profileDir }: { profileDir: string }) =>
    readFile(path.join(profileDir, "claude-config", ".credentials.json")),
}));
vi.mock("./nativeWorkspaceCleanup.js", () => ({
  nativeWorkspaceCleanup: () => (receipt: string) => rmSync(receipt, { recursive: true }),
}));

let root: string;
const execFileAsync = promisify(execFile);
const AGENT_ID = `agt_${"a".repeat(24)}`;
const AGENT_TOKEN = `agent:${AGENT_ID}:${"s".repeat(43)}`;
const SERVER_ID = `srv_${"s".repeat(24)}`;
const PAIRING = {
  endpointId: "aa".repeat(32),
  relays: ["https://relay.example/"],
  v: 4 as const,
};
const ENDPOINT_SECRET = "E".repeat(43);

function directRoute(url: string) {
  return {
    url,
    serverId: SERVER_ID,
    workspaceId: "workspace-dev",
    workspaceName: "dev",
    transport: "local" as const,
  };
}

const installedClaude = (process.env["PATH"] ?? "")
  .split(path.delimiter)
  .map((directory) => path.join(directory, "claude"))
  .find((candidate) => existsSync(candidate));

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-launch-profile-")));
});

afterEach(async () => {
  await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
});

function fixtureCli() {
  return {
    command: process.execPath,
    args: [path.join(root, "installed app & tools", "cli.mjs")],
    environment: { VIBESTUDIO_APP_ROOT: path.join(root, "installed app & tools") },
  };
}

function oauth(accessToken: string, refreshToken = "shared") {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt: 2000000000000,
      scopes: ["user:inference"],
    },
  });
}

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
      cli: fixtureCli(),
      profile: profile(),
      profilesRoot,
      cliRoute: {
        ...directRoute(`iroh://${PAIRING.endpointId}/_workspace/dev`),
        transport: "iroh",
        endpointSecret: ENDPOINT_SECRET,
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
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(process.execPath);
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].command).toBe(process.execPath);
    expect(settings.hooks.StopFailure[0].hooks[0].command).toBe(process.execPath);
    for (const [event, matchers] of Object.entries(settings.hooks)) {
      expect((matchers as Array<{ hooks: unknown[] }>)[0]!.hooks).toEqual([
        {
          type: "command",
          command: process.execPath,
          args: [...fixtureCli().args, "claude", "emit", event],
        },
      ]);
    }
    const mcp = JSON.parse(await readFile(path.join(launch.profileDir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.vibestudio).toEqual({
      command: process.execPath,
      args: [...fixtureCli().args, "claude", "channel-host"],
    });
    expect((await stat(launch.profileDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(launch.profileDir, "env.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(launch.cliCredentialPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(launch.cliCredentialPath, "utf8"))).toEqual({
      schemaVersion: 2,
      kind: "agent",
      url: `iroh://${PAIRING.endpointId}/_workspace/dev`,
      workspaceId: "workspace-dev",
      workspaceName: "dev",
      serverId: SERVER_ID,
      entityId: "entity-one",
      contextId: "context-one",
      agentId: AGENT_ID,
      agentToken: AGENT_TOKEN,
      transport: "iroh",
      endpointSecret: ENDPOINT_SECRET,
      workspacePairing: PAIRING,
      signedInAt: expect.any(Number),
    });
    const diagnostic = await readFile(path.join(launch.profileDir, "env.json"), "utf8");
    expect(diagnostic).not.toContain(AGENT_TOKEN);
    expect(diagnostic).not.toContain(`iroh://${PAIRING.endpointId}`);
  });

  it("materializes executable MCP and hook argv without shell interpretation", async () => {
    const cli = fixtureCli();
    await mkdir(path.dirname(cli.args[0]!), { recursive: true });
    await writeFile(cli.args[0]!, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const literal = [
      "space & ampersand",
      "%PATH%",
      "$(echo injected)",
      'quote"value',
      "trailing\\",
    ];
    const launch = await materializeClaudeLaunch({
      cli: { ...cli, args: [...cli.args, ...literal] },
      profile: profile(),
      profilesRoot: path.join(root, "profiles"),
      cliRoute: directRoute("http://fixture.invalid"),
      hostClaudeConfigDirectory: path.join(root, "absent-host-config"),
    });
    const settings = JSON.parse(
      await readFile(path.join(launch.profileDir, "settings.json"), "utf8")
    );
    const mcp = JSON.parse(await readFile(path.join(launch.profileDir, "mcp.json"), "utf8"));
    for (const [command, expected] of [
      [settings.hooks.SessionStart[0].hooks[0], [...literal, "claude", "emit", "SessionStart"]],
      [mcp.mcpServers.vibestudio, [...literal, "claude", "channel-host"]],
    ] as const) {
      const result = await execFileAsync(command.command, command.args);
      expect(JSON.parse(result.stdout)).toEqual(expected);
    }
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
      cli: fixtureCli(),
      profile: profile(),
      profilesRoot,
      cliRoute: directRoute("http://first"),
      hostClaudeConfigDirectory: path.join(root, "missing-host-config"),
    });
    const second = await materializeClaudeLaunch({
      cli: fixtureCli(),
      profile: profile(),
      profilesRoot,
      cliRoute: directRoute("http://second"),
      hostClaudeConfigDirectory: path.join(root, "missing-host-config"),
    });
    expect(second.profileDir).not.toBe(first.profileDir);
    const secondDiagnostic = await readFile(path.join(second.profileDir, "env.json"), "utf8");
    expect(secondDiagnostic).not.toContain("http://second");
    expect(secondDiagnostic).not.toContain(AGENT_TOKEN);
    await removeMaterializedClaudeLaunch(first, root);
    await expect(stat(first.profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(second.profileDir)).resolves.toBeDefined();
    await removeMaterializedClaudeLaunch(second, root);
  });

  it("refreshes a launch-local host login with compare-and-swap semantics", async () => {
    const profilesRoot = path.join(root, "profiles");
    const hostConfig = path.join(root, "host-claude");
    const hostCredential = path.join(hostConfig, ".credentials.json");
    await mkdir(hostConfig);
    await writeFile(hostCredential, oauth("old"), {
      mode: 0o600,
    });
    const launch = await materializeClaudeLaunch({
      cli: fixtureCli(),
      profile: profile(),
      profilesRoot,
      cliRoute: directRoute("http://local"),
      hostClaudeConfigDirectory: hostConfig,
    });
    const isolatedCredential = path.join(launch.env.CLAUDE_CONFIG_DIR, ".credentials.json");
    expect(await readFile(isolatedCredential, "utf8")).toContain('"accessToken":"old"');

    await writeFile(isolatedCredential, '{"unexpected":"synthetic-secret-canary"}');
    await expect(reconcileClaudeLaunchCredential(launch, root)).rejects.toThrow(
      "Confined Claude credential is not a valid OAuth credential"
    );
    expect(await readFile(hostCredential, "utf8")).toBe(oauth("old"));

    await writeFile(isolatedCredential, oauth("fresh", "rotated"), {
      mode: 0o600,
    });
    await expect(reconcileClaudeLaunchCredential(launch, root)).resolves.toEqual({
      status: "updated",
    });
    expect(await readFile(hostCredential, "utf8")).toContain('"accessToken":"fresh"');
    expect((await stat(hostCredential)).mode & 0o777).toBe(0o600);

    const conflicting = await materializeClaudeLaunch({
      cli: fixtureCli(),
      profile: profile(),
      profilesRoot,
      cliRoute: directRoute("http://local"),
      hostClaudeConfigDirectory: hostConfig,
    });
    await writeFile(
      path.join(conflicting.env.CLAUDE_CONFIG_DIR, ".credentials.json"),
      oauth("launch-newer"),
      { mode: 0o600 }
    );
    await writeFile(hostCredential, oauth("host-newer"), { mode: 0o600 });
    await expect(reconcileClaudeLaunchCredential(conflicting, root)).resolves.toMatchObject({
      status: "conflict",
    });
    expect(await readFile(hostCredential, "utf8")).toContain('"accessToken":"host-newer"');
  });

  it("validates the binary version on the caller-selected host", async () => {
    await expect(assertClaudeCodeVersion(async () => "2.1.139 (Claude Code)")).resolves.toBe(
      "2.1.139"
    );
    await expect(assertClaudeCodeVersion(async () => "2.1.138")).rejects.toThrow(/too old/);
    await expect(
      assertClaudeCodeVersion(async () => {
        throw new Error("missing");
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
