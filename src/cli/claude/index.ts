import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertClaudeCodeVersion,
  materializeClaudeLaunch,
  removeMaterializedClaudeLaunch,
  type ClaudeLaunchProfile,
  type MaterializedClaudeLaunch,
} from "@vibestudio/shared/claudeLaunchProfile";
import { confineClaudeReadOnly } from "@vibestudio/shared/claudeReadOnlyLaunch";
import { cliConfigRoot } from "../configPaths.js";
import { loadCliCredentials } from "../credentialStore.js";
import { RpcClient } from "../rpcClient.js";
import { AuthError, CliError } from "../output.js";
import { printResult } from "../output.js";
import {
  CONTEXT_BINDING_FILE,
  assertBindingWorkspace,
  findContextBinding,
  findContextBindingLocation,
} from "../contextBinding.js";
import { bridgeRpcCredential, resolveBridgeConfig, runChannelHostLoop } from "./channelHost.js";

/**
 * `vibestudio claude` command group. The CLI stays Claude-agnostic apart from
 * the command name: all Claude-Code-specific knowledge lives in the
 * workspace-owned Claude Code extension (launch orchestration) and the
 * `channel-host` bridge (Claude-side protocol). The CLI reaches the configured
 * provider purely over RPC (`extensions.invokeProvider`) — no workspace imports.
 */
const CLAUDE_CODE_PROVIDER = "claudeCode";

/** Structural mirror of the extension's PrepareResult (no workspace import). */
export interface PrepareResult {
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  profile: ClaudeLaunchProfile;
}

export { findContextBinding };

export function printClaudeHelp(): void {
  console.log(`vibestudio claude

Usage:
  vibestudio claude [--channel <id>]        Launch Claude Code as a linked channel agent
  vibestudio claude status                  Report link tier and attachment state
  vibestudio claude emit <event>            Relay a Claude Code hook event to the bridge (used by hooks)
  vibestudio claude channel-host             Contained-launch MCP bridge (spawned by Claude Code)
`);
}

/** Group entry point, dispatched from client.ts. */
export async function runClaudeGroup(
  argv: string[],
  options: { json?: boolean } = {}
): Promise<number> {
  const [first, ...rest] = argv;
  if (first === "--help" || first === "-h" || first === "help") {
    printClaudeHelp();
    return 0;
  }
  if (first === "emit") return await runEmit(rest);
  if (first === "channel-host") return await runChannelHost(rest);
  if (first === "status") return await runStatus(options.json === true);
  // Bare `vibestudio claude` or `vibestudio claude --channel <id>` → launcher.
  if (first === undefined || first.startsWith("-")) return await runLauncher(argv);
  console.error(`Unknown claude command: ${first}`);
  printClaudeHelp();
  return 2;
}

// ---------------------------------------------------------------------------
// vibestudio claude [--channel <id>]
// ---------------------------------------------------------------------------

async function runLauncher(argv: string[]): Promise<number> {
  const channelFlag = readValueFlag(argv, "--channel");

  const creds = loadCliCredentials();
  if (!creds) {
    throw new AuthError('not paired — run `vibestudio remote pair "<pair-link>"` first');
  }
  const client = new RpcClient(creds);
  const profilesRoot = path.join(cliConfigRoot(), "claude-launches");
  try {
    const location = findContextBindingLocation(process.cwd());
    if (!location) {
      throw new CliError(
        `no ${CONTEXT_BINDING_FILE} found in this or any parent directory — ` +
          "Claude must launch inside the local context tree its file tools will edit"
      );
    }
    assertBindingWorkspace(location.binding, creds);

    let channelId = channelFlag;
    if (!channelId) {
      const primary = await invokeExtension<{ channelId: string } | null>(
        client,
        "resolvePrimaryChannel",
        [{ contextId: location.binding.contextId }]
      );
      if (!primary?.channelId) {
        throw new CliError(
          `context ${location.binding.contextId} has no known conversation channel yet — ` +
            `launch once with \`vibestudio claude --channel <id>\` to bind one`
        );
      }
      channelId = primary.channelId;
    }

    // Validate the executable on the selected machine before minting a launch credential.
    await assertClaudeCodeVersion();
    const prepared = await invokeExtension<PrepareResult>(client, "prepare", [{ channelId }]);
    return await executePreparedClaudeLaunch({
      prepared,
      expectedContextId: location.binding.contextId,
      contextDirectory: location.directory,
      profilesRoot,
      serverUrl: creds.url,
      release: async (entityId, launchId) => {
        await invokeExtension(client, "release", [{ entityId, launchId }]);
      },
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Execute a prepared declaration on this machine and own its whole lifecycle. */
export async function executePreparedClaudeLaunch(input: {
  prepared: PrepareResult;
  expectedContextId: string;
  contextDirectory: string;
  profilesRoot: string;
  serverUrl: string;
  release: (entityId: string, launchId: string) => Promise<void>;
  spawnLaunch?: typeof spawnClaude;
}): Promise<number> {
  const { prepared } = input;
  let launch: MaterializedClaudeLaunch | undefined;
  let outcome: { ok: true; exitCode: number } | { ok: false; error: unknown };
  try {
    if (prepared.contextId !== input.expectedContextId) {
      throw new CliError(
        `channel ${prepared.channelId} belongs to context ${prepared.contextId}, but the local tree is ` +
          `${input.expectedContextId}; launch from that context's bound directory`
      );
    }
    launch = await materializeClaudeLaunch({
      profile: prepared.profile,
      profilesRoot: input.profilesRoot,
      serverUrl: input.serverUrl,
    });
    outcome = {
      ok: true,
      exitCode: await (input.spawnLaunch ?? spawnClaude)(launch, input.contextDirectory),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let cleanupError: unknown;
  try {
    if (launch) await removeMaterializedClaudeLaunch(launch);
  } catch (error) {
    cleanupError = error;
  }
  try {
    await input.release(prepared.entityId, prepared.profile.launchId);
  } catch (error) {
    cleanupError ??= error;
  }
  if (!outcome.ok) throw outcome.error;
  if (cleanupError) throw cleanupError;
  return outcome.exitCode;
}

export function spawnClaude(
  launch: MaterializedClaudeLaunch,
  contextDirectory: string
): Promise<number> {
  const confined = confineClaudeReadOnly({
    argv: launch.argv,
    profileDir: launch.profileDir,
    contextDirectory,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(confined.command, confined.args, {
      cwd: contextDirectory,
      env: { ...process.env, ...launch.env, ...confined.env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(128 + (os.constants.signals[signal] ?? 0));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

async function invokeExtension<T>(client: RpcClient, method: string, args: unknown[]): Promise<T> {
  return await client.call<T>("extensions.invokeProvider", [CLAUDE_CODE_PROVIDER, method, args]);
}

// ---------------------------------------------------------------------------
// vibestudio claude emit <event>   (invoked by Claude Code hooks)
// ---------------------------------------------------------------------------

async function runEmit(argv: string[]): Promise<number> {
  // Hooks must NEVER break the session: swallow every error and exit 0.
  try {
    const event = argv[0];
    if (!event) return 0;
    const socketPath = emitSocketPath(process.env, process.cwd());
    if (!socketPath) return 0;
    const payload = await readStdinSafe();
    const line = JSON.stringify({ event, payload, ts: Date.now() });
    await writeToHookSocket(socketPath, line);
  } catch {
    // Intentionally ignored.
  }
  return 0;
}

/**
 * Where a hook emission goes. Hooks only exist in an OS-contained launch and
 * therefore always use its disposable profile socket. There is no unmanaged
 * per-context fallback.
 */
export function emitSocketPath(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const profile = env["VIBESTUDIO_LAUNCH_PROFILE"];
  if (profile) return path.join(profile, "hook.sock");
  void cwd;
  return null;
}

function readStdinSafe(): Promise<unknown> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }
    let data = "";
    const done = (): void => {
      if (!data.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(data);
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", done);
    process.stdin.on("error", () => resolve(null));
    // Never block a hook indefinitely.
    setTimeout(done, 2000).unref();
  });
}

export function writeToHookSocket(socketPath: string, line: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const finish = (): void => {
      socket.destroy();
      resolve();
    };
    socket.on("connect", () => {
      socket.write(`${line}\n`, () => finish());
    });
    socket.on("error", () => resolve());
    socket.setTimeout(2000, finish);
  });
}

// ---------------------------------------------------------------------------
// vibestudio claude channel-host   (the bridge, plan §7)
// ---------------------------------------------------------------------------

async function runChannelHost(argv: string[]): Promise<number> {
  if (readValueFlag(argv, "--channel")) {
    throw new CliError(
      "channel-host no longer adopts unmanaged sessions; launch the contained session with `vibestudio claude --channel <id>`"
    );
  }
  const config = await resolveBridgeConfig(process.env);
  return await runChannelHostLoop(config);
}

// ---------------------------------------------------------------------------
// vibestudio claude status   (tier probe, plan §8.3)
// ---------------------------------------------------------------------------

async function runStatus(json: boolean): Promise<number> {
  const env = process.env;
  const binding = findContextBinding(process.cwd());
  const creds = loadCliCredentials();
  if (binding && creds) assertBindingWorkspace(binding, creds);
  const launched = Boolean(env["VIBESTUDIO_AGENT_TOKEN"] && env["VIBESTUDIO_LAUNCH_PROFILE"]);
  const agentToken = env["VIBESTUDIO_AGENT_TOKEN"];
  const bridgeSocket = bridgeHookSocket(env, binding);

  // Tier model: 2 = our OS-contained terminal launch, 0 = paired CLI only.
  // The former unmanaged/plugin adoption tier was removed because a child MCP
  // process cannot make its already-running parent filesystem read-only.
  const tier = launched ? 2 : 0;

  const lines: string[] = [
    `tier: ${tier} (${tier === 2 ? "contained linked session" : "CLI only"})`,
    `paired device credential: ${creds ? `yes (${creds.url})` : "no"}`,
    `context binding: ${binding ? `${binding.workspaceId}/${binding.contextId}` : "none (not inside a context folder)"}`,
    `agent credential env: ${agentToken ? "present" : "absent"}`,
    `launch profile: ${env["VIBESTUDIO_LAUNCH_PROFILE"] ?? "absent"}`,
    `bridge hook socket: ${bridgeSocket ?? "absent"}`,
  ];

  if (agentToken && env["VIBESTUDIO_SERVER_URL"]) {
    try {
      const config = await resolveBridgeConfig(env);
      const client = new RpcClient(bridgeRpcCredential(config));
      const status = await client.callTarget<Record<string, unknown>>(
        config.vesselRef,
        "linkedStatus",
        []
      );
      lines.push(
        `vessel: ${config.vesselRef}`,
        `attached: ${String(status["attached"])}`,
        `pending events: ${String(status["pendingCount"])}`,
        `channels: ${(status["channelIds"] as string[] | undefined)?.join(", ") ?? ""}`
      );
      await client.close().catch(() => undefined);
    } catch (err) {
      lines.push(`vessel status: unavailable (${err instanceof Error ? err.message : err})`);
    }
  }

  printResult(
    { tier, paired: Boolean(creds), contextId: binding?.contextId ?? null, lines },
    { json, human: () => console.log(lines.join("\n")) }
  );
  return 0;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bridgeHookSocket(
  env: NodeJS.ProcessEnv,
  _binding: ReturnType<typeof findContextBinding>
): string | null {
  const profile = env["VIBESTUDIO_LAUNCH_PROFILE"];
  if (profile) {
    const profileSocket = path.join(profile, "hook.sock");
    if (fs.existsSync(profileSocket)) return profileSocket;
  }
  return null;
}

function readValueFlag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === name) return argv[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}
