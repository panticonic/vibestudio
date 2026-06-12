#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverNatstackServers } from "@natstack/shared/tailscaleDiscovery";
import {
  clearCliCredentials,
  loadCliCredentials,
  saveCliCredentials,
  credentialPath,
} from "./credentialStore.js";
import { completePairing, createPairingInvite } from "./remoteClient.js";
import { refreshShell } from "./rpcClient.js";
import { agentCommands } from "./agent/index.js";
import { fsCommands } from "./agent/fsCommands.js";
import { gitCommands } from "./agent/gitCommands.js";
import { evalCommands } from "./agent/evalCommand.js";
import {
  findCommand,
  groupCommands,
  parseInvocation,
  renderGroupHelp,
  JSON_FLAG,
  type CliCommand,
  type ParsedInvocation,
} from "./commandTable.js";
import { AuthError, UsageError, jsonMode, printError, printResult } from "./output.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ───────────────────────────────────────────────────────────────────────────
// remote commands
// ───────────────────────────────────────────────────────────────────────────

async function remotePair(inv: ParsedInvocation): Promise<number> {
  const opts: { url?: string; code?: string; link?: string; label?: string } = {};
  if (typeof inv.flags["url"] === "string") opts.url = inv.flags["url"];
  if (typeof inv.flags["code"] === "string") opts.code = inv.flags["code"];
  if (typeof inv.flags["label"] === "string") opts.label = inv.flags["label"];
  const positional = inv.positionals[0];
  if (positional?.startsWith("natstack://")) opts.link = positional;
  else if (positional) opts.url = positional;
  let creds;
  try {
    creds = await completePairing(opts);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  saveCliCredentials(creds);
  console.log(`paired ${creds.url}`);
  console.log(`credentials: ${credentialPath()}`);
  return 0;
}

async function remoteStatus(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const creds = loadCliCredentials();
    if (!creds) throw new AuthError("not paired");
    const refresh = await refreshShell(creds);
    const response = await fetch(new URL("/healthz", creds.url));
    if (!response.ok) throw new AuthError(`unreachable (${response.status})`);
    const body = (await response.json()) as Record<string, unknown>;
    const result = {
      url: creds.url,
      version: typeof body["version"] === "string" ? body["version"] : undefined,
      workspaceId:
        refresh.workspaceId ??
        (typeof body["workspaceId"] === "string" ? body["workspaceId"] : undefined),
      serverId: refresh.serverId,
    };
    printResult(result, {
      json,
      human: () => {
        console.log(`connected: ${result.url}`);
        if (result.version) console.log(`version: ${result.version}`);
        if (result.workspaceId) console.log(`workspace: ${result.workspaceId}`);
        if (result.serverId) console.log(`server: ${result.serverId}`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteInvite(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const creds = loadCliCredentials();
    if (!creds) throw new AuthError("not paired");
    let ttlMs: number | undefined;
    if (typeof inv.flags["ttl-ms"] === "string") {
      const value = Number(inv.flags["ttl-ms"]);
      if (Number.isFinite(value)) ttlMs = value;
    }
    const invite = await createPairingInvite(creds, { ttlMs });
    printResult(invite, {
      json,
      human: () => {
        console.log(`Pairing code: ${invite.code}`);
        console.log(`Pair URL: ${invite.deepLink}`);
        if (typeof invite.expiresAt === "number") {
          console.log(`Expires: ${new Date(invite.expiresAt).toISOString()}`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

function scriptCommand(
  group: string,
  name: string,
  scriptName: string,
  summary: string,
  options: { aliases?: string[]; usage?: string; prependArgs?: string[] } = {}
): CliCommand {
  return {
    group,
    name,
    aliases: options.aliases,
    summary,
    usage: options.usage,
    passthrough: true,
    run: (_inv, rawArgs) => runScript(scriptName, [...(options.prependArgs ?? []), ...rawArgs]),
  };
}

const remoteCommands: CliCommand[] = [
  scriptCommand(
    "remote",
    "start",
    "remote-start.mjs",
    "Launch Electron against the paired server",
    {
      aliases: ["desktop"],
      usage: "natstack remote start [--pair <link>]",
    }
  ),
  scriptCommand("remote", "serve", "remote-serve.mjs", "Start a QR/deep-link pairing server", {
    aliases: ["server"],
    usage: "natstack remote serve [--host tailscale] [--port 3030]",
  }),
  {
    group: "remote",
    name: "pair",
    summary: "Save a CLI device credential without launching Electron",
    usage: 'natstack remote pair "natstack://connect?url=...&code=..."',
    flags: [
      { name: "url", takesValue: true },
      { name: "code", takesValue: true },
      { name: "label", takesValue: true },
    ],
    run: remotePair,
  },
  {
    group: "remote",
    name: "invite",
    summary: "Create a pairing invite for another device",
    usage: "natstack remote invite [--ttl-ms <milliseconds>]",
    flags: [{ name: "ttl-ms", takesValue: true }, JSON_FLAG],
    run: remoteInvite,
  },
  {
    group: "remote",
    name: "status",
    summary: "Check the stored credential against the server",
    usage: "natstack remote status",
    flags: [JSON_FLAG],
    run: remoteStatus,
  },
  {
    group: "remote",
    name: "logout",
    summary: "Remove the stored CLI device credential",
    usage: "natstack remote logout",
    run: async () => {
      clearCliCredentials();
      console.log("logged out");
      return 0;
    },
  },
  {
    group: "remote",
    name: "discover",
    summary: "Print NatStack servers discovered on the tailnet",
    usage: "natstack remote discover",
    run: async () => {
      const servers = await discoverNatstackServers();
      for (const server of servers) console.log(server.url);
      return 0;
    },
  },
];

const mobileCommands: CliCommand[] = [
  scriptCommand("mobile", "pair", "mobile-pair.mjs", "Start the QR/deep-link pairing server", {
    usage: "natstack mobile pair [--host tailscale] [--port 3030]",
  }),
  scriptCommand("mobile", "dev", "mobile-dev.mjs", "Metro + local server + debug APK", {
    usage: "natstack mobile dev [--avd <name>] [--device <serial>]",
  }),
  scriptCommand(
    "mobile",
    "smoke",
    "mobile-smoke.mjs",
    "Verify the installed internal APK can pair and reach the workspace app",
    {
      usage: "natstack mobile smoke [--avd <name>] [--device <serial>]",
    }
  ),
  scriptCommand("mobile", "build", "mobile-install.mjs", "Build the trusted internal APK", {
    aliases: ["apk"],
    usage: "natstack mobile build",
    prependArgs: ["--build-only"],
  }),
  scriptCommand("mobile", "install", "mobile-install.mjs", "Install the internal APK", {
    usage: "natstack mobile install [--device <serial>] [--launch]",
  }),
  scriptCommand("mobile", "logs", "mobile-logs.mjs", "Tail app logs from a device", {
    usage: "natstack mobile logs [--device <serial>]",
  }),
  scriptCommand("mobile", "emulator", "mobile-emulator.mjs", "Start an Android emulator", {
    usage: "natstack mobile emulator [--avd <name>]",
  }),
];

/**
 * The full command registry. Extension point: later command groups
 * (fs, git, eval, ...) append their `CliCommand[]` here.
 */
const commandRegistry: CliCommand[] = [
  ...remoteCommands,
  ...mobileCommands,
  ...agentCommands,
  ...fsCommands,
  ...gitCommands,
  ...evalCommands,
];

const GROUP_ORDER = ["remote", "mobile", "agent", "fs", "git", "eval"];

export async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv;
  if (!group || group === "--help" || group === "help") {
    printHelp();
    return 0;
  }
  if (!GROUP_ORDER.includes(group)) {
    console.error(`Unknown command: ${group}`);
    printHelp();
    return 2;
  }
  const [sub, ...subArgs] = rest;
  if (!sub || sub === "--help" || sub === "help") {
    printGroupHelp(group);
    return 0;
  }
  const command = findCommand(commandRegistry, group, sub);
  if (!command) {
    console.error(`Unknown ${group} command: ${sub}`);
    printGroupHelp(group);
    return 2;
  }
  if (command.passthrough) {
    return await command.run({ positionals: subArgs, flags: {} }, subArgs);
  }
  let inv: ParsedInvocation;
  try {
    inv = parseInvocation(command, subArgs);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      if (command.usage) console.error(`Usage: ${command.usage}`);
      return error.exitCode;
    }
    throw error;
  }
  return await command.run(inv, subArgs);
}

function runScript(scriptName: string, argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "scripts", "cli", scriptName), ...argv],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
      }
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

function printHelp(): void {
  const sections = GROUP_ORDER.map((group) => renderGroupHelp(commandRegistry, group)).join("\n");
  console.log(`natstack

Usage:
${sections}

Credentials are stored as a 0600 JSON file at ${credentialPath()}.
`);
}

function printGroupHelp(group: string): void {
  console.log(`natstack ${group}

Usage:
${renderGroupHelp(commandRegistry, group)}
`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

export { commandRegistry, groupCommands };
