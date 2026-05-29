#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { discoverNatstackServers } from "@natstack/shared/tailscaleDiscovery";
import {
  clearCliCredentials,
  loadCliCredentials,
  saveCliCredentials,
  credentialPath,
} from "./credentialStore.js";
import { completePairing, createPairingInvite, refreshShell } from "./remoteClient.js";

interface Options {
  url?: string;
  code?: string;
  link?: string;
  label?: string;
  ttlMs?: number;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") {
    printHelp();
    return 0;
  }
  if (command === "discover") {
    const servers = await discoverNatstackServers();
    for (const server of servers) console.log(server.url);
    return 0;
  }
  if (command === "pair") return pair(rest);
  if (command === "invite") return invite(rest);
  if (command === "status") return status();
  if (command === "logout") {
    clearCliCredentials();
    console.log("logged out");
    return 0;
  }
  console.error(`Unknown command: ${command}`);
  printHelp();
  return 2;
}

async function pair(argv: string[]): Promise<number> {
  const opts = parseOptions(argv);
  if (argv[0] && argv[0].startsWith("natstack://")) {
    opts.link = argv[0];
  } else if (argv[0] && !argv[0].startsWith("--")) {
    opts.url = argv[0];
  }
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

async function status(): Promise<number> {
  const creds = loadCliCredentials();
  if (!creds) {
    console.log("not paired");
    return 1;
  }
  let refresh;
  try {
    refresh = await refreshShell(creds);
  } catch (error) {
    console.log(`not connected: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const response = await fetch(new URL("/healthz", creds.url));
  if (!response.ok) {
    console.log(`unreachable (${response.status})`);
    return 1;
  }
  const body = (await response.json()) as Record<string, unknown>;
  console.log(`connected: ${creds.url}`);
  if (typeof body["version"] === "string") console.log(`version: ${body["version"]}`);
  const workspaceId =
    typeof refresh["workspaceId"] === "string"
      ? refresh["workspaceId"]
      : typeof body["workspaceId"] === "string"
        ? body["workspaceId"]
        : undefined;
  if (workspaceId) console.log(`workspace: ${workspaceId}`);
  if (typeof refresh["serverId"] === "string") console.log(`server: ${refresh["serverId"]}`);
  return 0;
}

async function invite(argv: string[]): Promise<number> {
  const opts = parseOptions(argv);
  const creds = loadCliCredentials();
  if (!creds) {
    console.error("not paired");
    return 1;
  }
  let invite;
  try {
    invite = await createPairingInvite(creds, { ttlMs: opts.ttlMs });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(`Pairing code: ${invite.code}`);
  console.log(`Pair URL: ${invite.deepLink}`);
  if (typeof invite.expiresAt === "number") {
    console.log(`Expires: ${new Date(invite.expiresAt).toISOString()}`);
  }
  return 0;
}

function parseOptions(argv: string[]): Options {
  const opts: Options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") opts.url = argv[++i];
    else if (arg === "--code") opts.code = argv[++i];
    else if (arg === "--label") opts.label = argv[++i];
    else if (arg === "--ttl-ms") {
      const value = Number(argv[++i]);
      if (Number.isFinite(value)) opts.ttlMs = value;
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`natstack-client

Usage:
  natstack-client discover
  natstack-client pair "natstack://connect?url=...&code=..."
  natstack-client pair --url <url> --code <code> [--label <label>]
  natstack-client invite [--ttl-ms <milliseconds>]
  natstack-client status
  natstack-client logout

Credentials are stored as a 0600 JSON file at ${credentialPath()}.
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
