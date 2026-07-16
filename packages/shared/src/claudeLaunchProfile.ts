import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/**
 * The launch protocol is deliberately small: semantic preparation produces
 * identity and duty, while the machine that executes Claude owns local paths
 * and transport reach. Nothing in this value is a host filesystem location.
 */
export const CLAUDE_LAUNCH_PROTOCOL = "vibestudio.claude-launch.v1" as const;

export const MIN_CLAUDE_CODE_VERSION = "2.1.81";

const environmentSchema = z
  .object({
    VIBESTUDIO_AGENT_TOKEN: z.string().min(1),
    VIBESTUDIO_ENTITY_ID: z.string().min(1),
    VIBESTUDIO_CONTEXT_ID: z.string().min(1),
    VIBESTUDIO_CHANNEL_ID: z.string().min(1),
    VIBESTUDIO_VESSEL_REF: z.string().min(1),
    VIBESTUDIO_SUBAGENT_RUN_ID: z.string().min(1).optional(),
    VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID: z.string().min(1).optional(),
    VIBESTUDIO_SUBAGENT_CONTRACT: z.string().min(1).optional(),
  })
  .strict();

export const claudeLaunchProfileSchema = z
  .object({
    protocol: z.literal(CLAUDE_LAUNCH_PROTOCOL),
    launchId: z.string().min(1),
    executable: z.literal("claude"),
    environment: environmentSchema,
  })
  .strict();

export type ClaudeLaunchEnvironment = z.infer<typeof environmentSchema>;
export type ClaudeLaunchProfile = z.infer<typeof claudeLaunchProfileSchema>;

export interface MaterializedClaudeLaunch {
  profileDir: string;
  argv: string[];
  env: ClaudeLaunchEnvironment & {
    VIBESTUDIO_SERVER_URL: string;
    VIBESTUDIO_LAUNCH_PROFILE: string;
  };
}

export function claudeLaunchProfile(input: {
  launchId: string;
  environment: ClaudeLaunchEnvironment;
}): ClaudeLaunchProfile {
  return claudeLaunchProfileSchema.parse({
    protocol: CLAUDE_LAUNCH_PROTOCOL,
    launchId: input.launchId,
    executable: "claude",
    environment: input.environment,
  });
}

export function parseClaudeLaunchProfile(value: unknown): ClaudeLaunchProfile {
  return claudeLaunchProfileSchema.parse(value);
}

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const;

/**
 * Materialize a portable declaration on the machine that will execute Claude.
 * All paths and transport coordinates are supplied here, never by the server.
 */
export async function materializeClaudeLaunch(input: {
  profile: ClaudeLaunchProfile;
  profilesRoot: string;
  serverUrl: string;
}): Promise<MaterializedClaudeLaunch> {
  const profile = parseClaudeLaunchProfile(input.profile);
  if (!input.serverUrl) throw new Error("Claude launch materialization requires a serverUrl");

  const name = Buffer.from(profile.launchId, "utf8").toString("base64url");
  const materializationId = randomUUID();
  const profileDir = path.join(path.resolve(input.profilesRoot), `${name}.${materializationId}`);
  const stageDir = path.join(path.resolve(input.profilesRoot), `.${name}.${materializationId}.tmp`);
  await mkdir(input.profilesRoot, { recursive: true, mode: 0o700 });
  await mkdir(stageDir, { mode: 0o700 });

  try {
    const mcpPath = path.join(stageDir, "mcp.json");
    const settingsPath = path.join(stageDir, "settings.json");
    const envPath = path.join(stageDir, "env.json");
    const finalMcpPath = path.join(profileDir, "mcp.json");
    const finalSettingsPath = path.join(profileDir, "settings.json");

    const hooks: Record<string, unknown> = {};
    for (const event of HOOK_EVENTS) {
      hooks[event] = [{ hooks: [{ type: "command", command: `vibestudio claude emit ${event}` }] }];
    }
    const mcp = {
      mcpServers: {
        vibestudio: { command: "vibestudio", args: ["claude", "channel-host"] },
      },
    };
    const settings = { hooks };
    const argv = [
      profile.executable,
      "--channels",
      "server:vibestudio",
      "--dangerously-load-development-channels",
      "--mcp-config",
      finalMcpPath,
      "--settings",
      finalSettingsPath,
    ];
    const env: MaterializedClaudeLaunch["env"] = {
      ...profile.environment,
      VIBESTUDIO_SERVER_URL: input.serverUrl,
      VIBESTUDIO_LAUNCH_PROFILE: profileDir,
    };

    await Promise.all([
      writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 }),
      writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 }),
      writeFile(envPath, `${JSON.stringify({ ...env, argv }, null, 2)}\n`, { mode: 0o600 }),
    ]);
    await rename(stageDir, profileDir);
    return { profileDir, argv, env };
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });
    throw error;
  }
}

/** Release exactly one materialization. Parallel materializations of the same
 * semantic launch remain independent, so an older owner cannot delete a newer
 * owner's profile. */
export async function removeMaterializedClaudeLaunch(
  launch: Pick<MaterializedClaudeLaunch, "profileDir">
): Promise<void> {
  await rm(launch.profileDir, { recursive: true, force: true });
}

function parseSemver(raw: string): [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Validate the Claude binary on the machine that will actually execute it. */
export async function assertClaudeCodeVersion(
  runVersion: () => Promise<string> = defaultClaudeVersion
): Promise<string> {
  let output: string;
  try {
    output = await runVersion();
  } catch (error) {
    throw Object.assign(
      new Error(
        `Claude Code CLI not found on PATH (\`claude --version\` failed): ${
          error instanceof Error ? error.message : String(error)
        }. Install Claude Code >= ${MIN_CLAUDE_CODE_VERSION}.`
      ),
      { code: "ENOENT" }
    );
  }
  const found = parseSemver(output);
  if (!found)
    throw new Error(`Could not parse Claude Code version from: ${JSON.stringify(output)}`);
  const minimum = parseSemver(MIN_CLAUDE_CODE_VERSION)!;
  if (compareSemver(found, minimum) < 0) {
    throw new Error(
      `Claude Code ${found.join(".")} is too old — this workspace requires >= ${MIN_CLAUDE_CODE_VERSION}. Update Claude Code and retry.`
    );
  }
  return found.join(".");
}

async function defaultClaudeVersion(): Promise<string> {
  const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 15_000 });
  return stdout.trim();
}
