import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { loadCliCredentials } from "../credentialStore.js";
import { RpcClient } from "@vibestudio/direct-client";
import { AuthError, CliError } from "../output.js";
import { printResult } from "../output.js";
import { CONTEXT_MARKER, findContextMarker } from "./context.js";
import { agentSocketPath } from "./hookSocket.js";
import { resolveBridgeConfig, runChannelHostLoop } from "./channelHost.js";

/**
 * `vibestudio claude` command group. The CLI stays Claude-agnostic apart from
 * the command name: all Claude-Code-specific knowledge lives in the
 * workspace-owned Claude Code extension (launch orchestration) and the
 * `channel-host` bridge (Claude-side protocol). The CLI reaches the configured
 * provider purely over RPC (`extensions.invokeProvider`) — no workspace imports.
 */
const CLAUDE_CODE_PROVIDER = "claudeCode";

/** Structural mirror of the extension's PrepareResult (no workspace import). */
interface PrepareResult {
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  contextFolder: string;
  env: Record<string, string>;
  argv: string[];
}

export { findContextMarker };

export function printClaudeHelp(): void {
  console.log(`vibestudio claude

Usage:
  vibestudio claude [--channel <id>]        Launch Claude Code as a linked channel agent
  vibestudio claude status                  Report link tier and attachment state
  vibestudio claude emit <event>            Relay a Claude Code hook event to the bridge (used by hooks)
  vibestudio claude channel-host [--channel <id>]
                                            Channel MCP bridge (spawned by Claude Code)
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

  let channelId = channelFlag;
  if (!channelId) {
    const marker = findContextMarker(process.cwd());
    if (!marker) {
      throw new CliError(
        `no --channel given and no ${CONTEXT_MARKER} found in this or any parent directory — ` +
          `run inside a context folder or pass --channel <id>`
      );
    }
    const primary = await invokeExtension<{ channelId: string } | null>(
      client,
      "resolvePrimaryChannel",
      [{ contextId: marker.contextId }]
    );
    if (!primary?.channelId) {
      throw new CliError(
        `context ${marker.contextId} has no known conversation channel yet — ` +
          `launch once with \`vibestudio claude --channel <id>\` to bind one`
      );
    }
    channelId = primary.channelId;
  }

  const prepared = await invokeExtension<PrepareResult>(client, "prepare", [{ channelId }]);
  return await spawnClaude(prepared);
}

function spawnClaude(prepared: PrepareResult): Promise<number> {
  const [command, ...args] = prepared.argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command ?? "claude", args, {
      cwd: prepared.contextFolder,
      env: { ...process.env, ...prepared.env },
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
 * Where a hook emission goes: the launch profile's socket when launched by
 * us, else the per-context fallback socket (plugin/adopted sessions, whose
 * env has no profile) discovered via the cwd-upward context marker.
 */
export function emitSocketPath(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const profile = env["VIBESTUDIO_LAUNCH_PROFILE"];
  if (profile) return path.join(profile, "hook.sock");
  const contextId = env["VIBESTUDIO_CONTEXT_ID"] ?? findContextMarker(cwd)?.contextId;
  return contextId ? agentSocketPath(contextId) : null;
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
  const config = await resolveBridgeConfig(process.env, {
    cwd: process.cwd(),
    channelFlag: readValueFlag(argv, "--channel"),
  });
  return await runChannelHostLoop(config);
}

// ---------------------------------------------------------------------------
// vibestudio claude status   (tier probe, plan §8.3)
// ---------------------------------------------------------------------------

async function runStatus(json: boolean): Promise<number> {
  const env = process.env;
  const marker = findContextMarker(process.cwd());
  const creds = loadCliCredentials();
  const launched = Boolean(env["VIBESTUDIO_AGENT_TOKEN"] && env["VIBESTUDIO_LAUNCH_PROFILE"]);
  const agentToken = env["VIBESTUDIO_AGENT_TOKEN"];
  const bridgeSocket = bridgeHookSocket(env, marker);

  // Tier model (plan §8.3): 2 = our terminal launch (profile env), 1 = channel
  // connected via agent credential (plugin/adoption), 0 = paired CLI only.
  const tier = launched ? 2 : agentToken || bridgeSocket ? 1 : 0;

  const lines: string[] = [
    `tier: ${tier} (${tier === 2 ? "launched terminal session" : tier === 1 ? "linked (plugin/adoption)" : "CLI only"})`,
    `paired device credential: ${creds ? `yes (${creds.url})` : "no"}`,
    `context marker: ${marker ? `${marker.contextId}${marker.serverUrl ? ` @ ${marker.serverUrl}` : ""}` : "none (not inside a context folder)"}`,
    `agent credential env: ${agentToken ? "present" : "absent"}`,
    `launch profile: ${env["VIBESTUDIO_LAUNCH_PROFILE"] ?? "absent"}`,
    `bridge hook socket: ${bridgeSocket ?? "absent"}`,
  ];

  if (agentToken && env["VIBESTUDIO_SERVER_URL"]) {
    try {
      const config = await resolveBridgeConfig(env, { cwd: process.cwd() });
      const client = new RpcClient({ url: config.serverUrl, token: config.agentToken });
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
    { tier, paired: Boolean(creds), contextId: marker?.contextId ?? null, lines },
    { json, human: () => console.log(lines.join("\n")) }
  );
  return 0;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bridgeHookSocket(
  env: NodeJS.ProcessEnv,
  marker: ReturnType<typeof findContextMarker>
): string | null {
  const profile = env["VIBESTUDIO_LAUNCH_PROFILE"];
  if (profile) {
    const profileSocket = path.join(profile, "hook.sock");
    if (fs.existsSync(profileSocket)) return profileSocket;
  }
  const contextId = env["VIBESTUDIO_CONTEXT_ID"] ?? marker?.contextId;
  if (!contextId) return null;
  const socketPath = agentSocketPath(contextId);
  return fs.existsSync(socketPath) ? socketPath : null;
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
