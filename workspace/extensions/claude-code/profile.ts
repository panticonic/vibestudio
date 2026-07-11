import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Minimum Claude Code version the launch orchestrator supports. The channel
 * permission-relay capability (`claude/channel/permission`) lands in 2.1.81; a
 * session older than this connects but silently drops permission events, so we
 * fail the launch loudly instead. See docs/claude-code-channels-plan.md §11.
 */
export const MIN_CLAUDE_CODE_VERSION = "2.1.81";

/** The five injected env vars (plus profile/skills bookkeeping) — plan §4.2. */
export interface LaunchEnv {
  VIBESTUDIO_SERVER_URL: string;
  VIBESTUDIO_AGENT_TOKEN: string;
  VIBESTUDIO_ENTITY_ID: string;
  VIBESTUDIO_CONTEXT_ID: string;
  VIBESTUDIO_CHANNEL_ID: string;
  /** Vessel DO target id (`do:<source>:<class>:<key>`) the bridge attaches to. */
  VIBESTUDIO_VESSEL_REF: string;
  /** Absolute path to this launch profile dir; the bridge listens on its hook.sock. */
  VIBESTUDIO_LAUNCH_PROFILE: string;
  /** Absolute path to the bundled `vibestudio-agent` skill dir, when resolvable. */
  VIBESTUDIO_SKILLS_DIR?: string;
  /** Set for subagent launches: the run id of the parent's spawn. Its presence
   *  tells the bridge this session IS a subagent (no hedging in instructions). */
  VIBESTUDIO_SUBAGENT_RUN_ID?: string;
  /** Set for subagent launches: the parent's home channel id. */
  VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID?: string;
  /** Set for subagent launches: the rendered subagent operating contract
   *  (`subagentRuntimePrompt` from @workspace/agentic-core — the same text Pi
   *  children get as their immediate prompt), surfaced by the bridge as MCP
   *  server instructions. */
  VIBESTUDIO_SUBAGENT_CONTRACT?: string;
}

/** The Claude Code lifecycle hooks we mirror into the trajectory (§7.4). */
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const;

function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Verify the locally-installed `claude` binary is new enough. Throws a loud,
 * actionable error when the binary is missing or below {@link MIN_CLAUDE_CODE_VERSION}.
 */
export async function assertClaudeCodeVersion(
  runVersion: () => Promise<string> = defaultClaudeVersion
): Promise<string> {
  let out: string;
  try {
    out = await runVersion();
  } catch (err) {
    throw Object.assign(
      new Error(
        `Claude Code CLI not found on PATH (\`claude --version\` failed): ${
          err instanceof Error ? err.message : String(err)
        }. Install Claude Code >= ${MIN_CLAUDE_CODE_VERSION}.`
      ),
      { code: "ENOENT" }
    );
  }
  const found = parseSemver(out);
  if (!found) {
    throw new Error(`Could not parse Claude Code version from: ${JSON.stringify(out)}`);
  }
  const min = parseSemver(MIN_CLAUDE_CODE_VERSION)!;
  if (compareSemver(found, min) < 0) {
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

export interface WrittenProfile {
  profileDir: string;
  argv: string[];
  env: LaunchEnv;
}

/**
 * Materialize the launch profile directory under
 * `<statePath>/agent-launch/<entityId>/` and return the exact Claude Code argv
 * plus the env the caller injects. Idempotent: re-preparing overwrites the
 * profile in place. The context working tree is never touched — all config
 * lives here (plan §4.2 step 4).
 */
export async function writeLaunchProfile(input: {
  statePath: string;
  entityId: string;
  env: Omit<LaunchEnv, "VIBESTUDIO_LAUNCH_PROFILE">;
}): Promise<WrittenProfile> {
  const profileDir = path.join(input.statePath, "agent-launch", input.entityId);
  await mkdir(profileDir, { recursive: true });

  const mcpPath = path.join(profileDir, "mcp.json");
  const settingsPath = path.join(profileDir, "settings.json");
  const envPath = path.join(profileDir, "env.json");

  const env: LaunchEnv = { ...input.env, VIBESTUDIO_LAUNCH_PROFILE: profileDir };

  const mcp = {
    mcpServers: {
      vibestudio: { command: "vibestudio", args: ["claude", "channel-host"] },
    },
  };

  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: "command", command: `vibestudio claude emit ${event}` }] }];
  }
  const settings: Record<string, unknown> = {
    // Env injected into the Claude Code session: surfaces the bundled skill dir
    // (env-expanded absolute path) and the launch profile to in-session tools.
    env: {
      ...(env.VIBESTUDIO_SKILLS_DIR ? { VIBESTUDIO_SKILLS_DIR: env.VIBESTUDIO_SKILLS_DIR } : {}),
      VIBESTUDIO_LAUNCH_PROFILE: profileDir,
    },
    hooks,
  };

  const argv = [
    "claude",
    "--channels",
    "server:vibestudio",
    "--dangerously-load-development-channels",
    "--mcp-config",
    mcpPath,
    "--settings",
    settingsPath,
  ];

  await Promise.all([
    writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`),
    writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`),
    writeFile(envPath, `${JSON.stringify({ ...env, argv }, null, 2)}\n`),
  ]);

  return { profileDir, argv, env };
}

/** Remove a launch profile dir (release path). Best-effort. */
export async function removeLaunchProfile(statePath: string, entityId: string): Promise<void> {
  const profileDir = path.join(statePath, "agent-launch", entityId);
  await rm(profileDir, { recursive: true, force: true });
}

/** Normalize marker values into the HTTP(S) base URL expected by RpcClient. */
export function toServerBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  url.hash = "";
  url.search = "";
  if (url.pathname === "/rpc") {
    url.pathname = "/";
  } else if (url.pathname.endsWith("/rpc")) {
    const withoutSuffix = url.pathname.slice(0, -"/rpc".length) || "/";
    if (withoutSuffix !== "/_workspace") url.pathname = withoutSuffix;
  }
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}
