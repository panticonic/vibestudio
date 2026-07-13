#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSelectedWorkspaceUrl } from "@vibestudio/shared/connect";
import {
  clearCliCredentials,
  loadCliCredentials,
  saveCliCredentials,
  credentialPath,
} from "./credentialStore.js";
import {
  addRemoteWorkspaceMember,
  inviteRemoteUser,
  listRemoteDevices,
  listRemoteWorkspaceMembers,
  listRemoteWorkspaces,
  pairRemoteDevice,
  pairRemoteServer,
  removeRemoteWorkspaceMember,
  revokeRemoteDevice,
  selectRemoteWorkspace,
  type PairOptions,
  type RemoteWorkspaceEntry,
} from "./remoteClient.js";
import { RpcClient, type DeviceCredential } from "./rpcClient.js";
import { runTerminalLaunchGate } from "./terminalLaunchGate.js";
import { agentCommands } from "./agent/index.js";
import { fsCommands } from "./agent/fsCommands.js";
import { vcsCommands } from "./agent/vcsCommands.js";
import { evalCommands } from "./agent/evalCommand.js";
import { channelCommands } from "./channelCommands.js";
import { contextCommands } from "./contextCommands.js";
import { panelCommands } from "./panelCommands.js";
import { systemTestCommands } from "./systemTestCommands.js";
import { runClaudeGroup } from "./claude/index.js";
import {
  findCommand,
  groupCommands,
  parseInvocation,
  renderCommandHelp,
  renderGroupHelp,
  JSON_FLAG,
  type CliCommand,
  type ParsedInvocation,
} from "./commandTable.js";
import {
  AuthError,
  CliError,
  UsageError,
  jsonMode,
  printError,
  printResult,
  redactCliSecrets,
  setPlainOutput,
} from "./output.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal") as {
  generate(value: string, options?: { small?: boolean }): void;
};
const NOT_PAIRED_GUIDANCE =
  'not paired — run `vibestudio remote pair "<pair-link>"` ' +
  "(ask a paired administrator to run `vibestudio remote pair-device`)";

// ───────────────────────────────────────────────────────────────────────────
// remote commands
// ───────────────────────────────────────────────────────────────────────────

async function remotePair(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  const label = typeof inv.flags["label"] === "string" ? inv.flags["label"] : undefined;
  const positional = inv.positionals[0];
  try {
    if (
      !positional ||
      (!positional.startsWith("vibestudio://") &&
        !positional.startsWith("https://vibestudio.app/pair"))
    ) {
      throw new UsageError(
        "pass a Vibestudio pairing link (https://vibestudio.app/pair#... or vibestudio://connect?...)"
      );
    }
    const creds = await pairRemoteServer({ link: positional, ...(label ? { label } : {}) });
    saveCliCredentials(creds);
    const result = { url: creds.url, credentialPath: credentialPath() };
    printResult(result, {
      json,
      human: () => {
        console.log(`paired ${result.url}`);
        console.log(`credentials: ${result.credentialPath}`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteStatus(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const creds = loadCliCredentials();
    if (!creds) {
      throw new AuthError(NOT_PAIRED_GUIDANCE);
    }
    if (!creds.workspaceName || !isSelectedWorkspaceUrl(creds.url)) {
      throw new AuthError(
        "no remote workspace selected - run `vibestudio remote select <workspace>`"
      );
    }
    const rpc = new RpcClient(creds);
    try {
      const info = await rpc.call<Record<string, unknown>>("auth.getConnectionInfo", []);
      const result = {
        url: creds.url,
        workspaceId: typeof info["workspaceId"] === "string" ? info["workspaceId"] : undefined,
        serverId: typeof info["serverId"] === "string" ? info["serverId"] : creds.serverId,
      };
      printResult(result, {
        json,
        human: () => {
          console.log(`connected: ${result.url}`);
          if (result.workspaceId) console.log(`workspace: ${result.workspaceId}`);
          console.log(`server: ${result.serverId}`);
        },
      });
      return 0;
    } finally {
      await rpc.close();
    }
  } catch (error) {
    return printError(error, { json });
  }
}

function requirePairedCredentials(): DeviceCredential {
  const credentials = loadCliCredentials();
  if (!credentials) throw new AuthError("not paired");
  return credentials;
}

function ttlFrom(inv: ParsedInvocation): number | undefined {
  const raw = inv.flags["ttl-ms"];
  if (raw === undefined) return undefined;
  const ttlMs = Number(raw);
  if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 3_600_000) {
    throw new UsageError("--ttl-ms must be an integer from 30000 to 3600000");
  }
  return ttlMs;
}

function printPairingInvite(invite: { pairUrl: string; code: string; expiresAt: number }): void {
  console.log(`Pairing code: ${invite.code}`);
  console.log(`Pair URL: ${invite.pairUrl}`);
  console.log(`Expires: ${new Date(invite.expiresAt).toISOString()}`);
  console.log();
  qrcode.generate(invite.pairUrl, { small: true });
}

async function remoteInviteUser(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const handle = typeof inv.flags["handle"] === "string" ? inv.flags["handle"].trim() : "";
    const workspaces = inv
      .flagsMulti("workspace")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!handle) throw new UsageError("--handle is required");
    if (workspaces.length === 0) throw new UsageError("at least one --workspace is required");
    const displayName =
      typeof inv.flags["display-name"] === "string" ? inv.flags["display-name"].trim() : undefined;
    const role = inv.flags["role"];
    if (role !== undefined && role !== "admin" && role !== "member") {
      throw new UsageError('--role must be "admin" or "member"');
    }
    const ttlMs = ttlFrom(inv);
    const result = await inviteRemoteUser(requirePairedCredentials(), {
      handle,
      workspaces,
      ...(displayName ? { displayName } : {}),
      ...(role ? { role } : {}),
      ...(ttlMs ? { ttlMs } : {}),
    });
    printResult(result, {
      json,
      human: () => {
        console.log(`Invited @${handle} to ${workspaces.join(", ")}`);
        printPairingInvite(result.pairing);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remotePairDevice(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const workspace =
      typeof inv.flags["workspace"] === "string" ? inv.flags["workspace"].trim() : undefined;
    const ttlMs = ttlFrom(inv);
    const result = await pairRemoteDevice(requirePairedCredentials(), {
      ...(workspace ? { workspace } : {}),
      ...(ttlMs ? { ttlMs } : {}),
    });
    printResult(result, { json, human: () => printPairingInvite(result.pairing) });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

function memberRef(inv: ParsedInvocation): { userId?: string; handle?: string } {
  const userId = typeof inv.flags["user-id"] === "string" ? inv.flags["user-id"].trim() : "";
  const handle = typeof inv.flags["handle"] === "string" ? inv.flags["handle"].trim() : "";
  if (Boolean(userId) === Boolean(handle)) {
    throw new UsageError("exactly one of --user-id or --handle is required");
  }
  return { ...(userId ? { userId } : {}), ...(handle ? { handle } : {}) };
}

async function remoteMutateMember(inv: ParsedInvocation, remove: boolean): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const workspace =
      typeof inv.flags["workspace"] === "string" ? inv.flags["workspace"].trim() : "";
    if (!workspace) throw new UsageError("--workspace is required");
    const input = { workspace, ...memberRef(inv) };
    const result = remove
      ? await removeRemoteWorkspaceMember(requirePairedCredentials(), input)
      : await addRemoteWorkspaceMember(requirePairedCredentials(), input);
    printResult(result, {
      json,
      human: () => {
        if (remove && !result.removed) {
          console.log(`not a member of ${workspace}`);
          return;
        }
        console.log(`${remove ? "removed from" : "added to"} ${workspace}`);
      },
    });
    if (remove && !result.removed) return 1;
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteListUsers(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const workspace =
      typeof inv.flags["workspace"] === "string" ? inv.flags["workspace"].trim() : "";
    if (!workspace) throw new UsageError("--workspace is required");
    const result = await listRemoteWorkspaceMembers(requirePairedCredentials(), workspace);
    printResult(result, {
      json,
      human: () => {
        for (const member of result.members) {
          console.log(
            `@${String(member["handle"] ?? member["userId"])}  ${String(member["role"] ?? "member")}`
          );
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteListDevices(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const result = await listRemoteDevices(requirePairedCredentials());
    printResult(result, {
      json,
      human: () => {
        for (const device of result.devices) console.log(`${device.deviceId}  ${device.label}`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteRevokeDevice(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const deviceId = inv.positionals[0] ?? "";
    if (!deviceId) throw new UsageError("device id is required");
    const credentials = requirePairedCredentials();
    const result = await revokeRemoteDevice(credentials, deviceId);
    printResult(result, {
      json,
      human: () => console.log(result.revoked ? "revoked" : "not found"),
    });
    if (result.revoked && credentials.deviceId === deviceId) clearCliCredentials();
    return result.revoked ? 0 : 1;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteWorkspaceList(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const creds = loadCliCredentials();
    if (!creds) throw new AuthError(NOT_PAIRED_GUIDANCE);
    const workspaces = await listRemoteWorkspaces(creds);
    printResult(
      { workspaces },
      {
        json,
        human: () => {
          for (const workspace of workspaces) {
            console.log(`${workspace.name}${workspace.running ? " (running)" : ""}`);
          }
        },
      }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteWorkspaceSelect(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const name =
      inv.positionals[0] ??
      (typeof inv.flags["workspace"] === "string" ? inv.flags["workspace"] : "");
    if (!name) throw new UsageError("workspace name is required");
    const creds = loadCliCredentials();
    if (!creds) throw new AuthError(NOT_PAIRED_GUIDANCE);
    const selected = await selectRemoteWorkspace(creds, name);
    saveCliCredentials(selected);
    printResult(
      {
        workspaceName: selected.workspaceName,
        url: selected.url,
        credentialPath: credentialPath(),
      },
      {
        json,
        human: () => {
          console.log(`workspace: ${selected.workspaceName}`);
          console.log(`server: ${selected.url}`);
        },
      }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

function terminalPairOptions(inv: ParsedInvocation): PairOptions | null {
  let link = typeof inv.flags["pair"] === "string" ? inv.flags["pair"] : undefined;
  const label = typeof inv.flags["label"] === "string" ? inv.flags["label"] : undefined;

  const positional = inv.positionals[0];
  if (
    positional?.startsWith("vibestudio://") ||
    positional?.startsWith("https://vibestudio.app/pair")
  ) {
    if (link)
      throw new UsageError("pass the pairing link once, either positionally or with --pair");
    link = positional;
  } else if (positional) {
    throw new UsageError(
      `Unexpected argument for terminal start: ${positional}. Pass a vibestudio://connect link or an https://vibestudio.app/pair URL (also accepted via --pair).`
    );
  }

  if (link) {
    return {
      link,
      label: label || `Terminal on ${os.hostname()}`,
      platform: "terminal",
    };
  }
  if (label) {
    throw new UsageError("--label is only valid when pairing with --pair");
  }
  return null;
}

async function terminalCredentials(
  inv: ParsedInvocation,
  json: boolean
): Promise<DeviceCredential> {
  const requestedWorkspace =
    typeof inv.flags["workspace"] === "string" ? inv.flags["workspace"].trim() : undefined;
  const pairOptions = terminalPairOptions(inv);
  let creds: DeviceCredential;
  if (pairOptions) {
    creds = await pairRemoteServer(pairOptions);
    saveCliCredentials(creds);
    if (!json) console.log(`paired ${creds.url}`);
  } else {
    const loaded = loadCliCredentials();
    if (!loaded) {
      throw new AuthError(
        'not paired - run `vibestudio terminal start --pair "vibestudio://connect?room=...&fp=...&code=...&sig=...&v=2"`'
      );
    }
    creds = loaded;
  }

  if (requestedWorkspace) {
    creds = await chooseTerminalWorkspace(creds, { requestedWorkspace, json });
    saveCliCredentials(creds);
  }
  if (!isSelectedWorkspaceUrl(creds.url)) {
    throw new AuthError(
      "stored remote credential is not scoped to a workspace; select a workspace"
    );
  }
  return creds;
}

async function chooseTerminalWorkspace(
  creds: DeviceCredential,
  opts: { requestedWorkspace?: string; json: boolean }
): Promise<DeviceCredential> {
  if (opts.requestedWorkspace) {
    return await selectRemoteWorkspace(creds, opts.requestedWorkspace);
  }
  const workspaces = await listRemoteWorkspaces(creds);
  if (workspaces.length === 0) {
    throw new AuthError("server has no workspaces to open");
  }
  if (opts.json || !process.stdin.isTTY) {
    throw new UsageError(
      `choose a workspace with --workspace <name> (${workspaces
        .map((workspace) => workspace.name)
        .join(", ")})`
    );
  }
  const selected = await promptWorkspaceSelection(workspaces);
  return await selectRemoteWorkspace(creds, selected);
}

async function promptWorkspaceSelection(workspaces: RemoteWorkspaceEntry[]): Promise<string> {
  console.log("Choose a workspace:");
  workspaces.forEach((workspace, index) => {
    const status = workspace.running ? " running" : "";
    console.log(`  ${index + 1}. ${workspace.name}${status}`);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question("Workspace: ")).trim();
      const numeric = Number(answer);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= workspaces.length) {
        const selected = workspaces[numeric - 1];
        if (selected) return selected.name;
      }
      const byName = workspaces.find((workspace) => workspace.name === answer);
      if (byName) return byName.name;
      console.log("Enter a workspace number or name.");
    }
  } finally {
    rl.close();
  }
}

async function terminalStart(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const creds = await terminalCredentials(inv, json);
    const result = await runTerminalLaunchGate(creds, {
      target: "terminal",
      yes: inv.flags["yes"] === true,
      json,
      timeoutMs: parseTimeout(inv.flags["timeout"]),
    });
    printResult(result, {
      json,
      human: () => {
        if (result.status === "ready") {
          const launch = result.launch?.status === "ready" ? result.launch : null;
          console.log(`terminal app started${launch?.appId ? `: ${launch.appId}` : ""}`);
          if (launch?.buildKey) console.log(`build: ${launch.buildKey}`);
          if (result.approvalsResolved > 0) {
            console.log(`approvals resolved: ${result.approvalsResolved}`);
          }
          return;
        }
        if (result.status === "denied") {
          console.log("terminal app startup denied");
          return;
        }
        if (result.launch?.status === "unavailable") {
          const details = result.launch.details.length
            ? `: ${result.launch.details.join("; ")}`
            : "";
          console.log(`${result.launch.reason}${details}`);
          return;
        }
        if (result.launch?.status === "preparing") {
          const details = result.launch.details.length
            ? `: ${result.launch.details.join("; ")}`
            : "";
          console.log(`${result.launch.reason}${details}`);
          return;
        }
        console.log(`terminal app did not start: ${result.status}`);
      },
    });
    return result.status === "ready" ? 0 : 1;
  } catch (error) {
    return printError(error, { json });
  }
}

function parseTimeout(value: ParsedInvocation["flags"][string] | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new UsageError("--timeout requires a duration");
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) throw new UsageError("--timeout must be a duration such as 30s, 10m, or 1h");
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const timeoutMs = amount * multiplier;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError("--timeout must be greater than zero");
  }
  return timeoutMs;
}

function scriptCommand(
  group: string,
  name: string,
  scriptName: string,
  summary: string,
  options: {
    usage?: string;
    prependArgs?: string[];
    passthroughHelp?: boolean;
  } = {}
): CliCommand {
  return {
    group,
    name,
    summary,
    usage: options.usage,
    passthrough: true,
    ...(options.passthroughHelp ? { passthroughHelp: true } : {}),
    run: (_inv, rawArgs) => runScript(scriptName, [...(options.prependArgs ?? []), ...rawArgs]),
  };
}

const remoteCommands: CliCommand[] = [
  scriptCommand(
    "remote",
    "deploy",
    "remote-deploy.mjs",
    "Deploy/manage a systemd user remote server",
    {
      usage:
        "vibestudio remote deploy <user@host> [--artifact <tgz>] [--signal-url <url>] [--port 3030]",
      passthroughHelp: true,
    }
  ),
  scriptCommand("remote", "doctor", "remote-doctor.mjs", "Run remote WebRTC preflight checks", {
    usage:
      "vibestudio remote doctor [--signal-url <url>] [--workspace <name> | --identity <identity.pem>]",
    passthroughHelp: true,
  }),
  scriptCommand(
    "remote",
    "repair-identity",
    "remote-repair-identity.mjs",
    "Regenerate the WebRTC identity file",
    {
      usage:
        "vibestudio remote repair-identity --yes [--workspace <name> | --identity <identity.pem>]",
      passthroughHelp: true,
    }
  ),
  scriptCommand("remote", "serve", "remote-serve.mjs", "Start a QR/deep-link pairing server", {
    usage: "vibestudio remote serve [--port 3030] [--dev --auto-approve]",
    // The pair server's own help documents the resolved server entry.
    passthroughHelp: true,
  }),
  {
    group: "remote",
    name: "pair",
    summary: "Save a CLI device credential without launching Electron",
    usage: 'vibestudio remote pair "<pair-link>"',
    flags: [
      { name: "label", takesValue: true, description: "Device label shown on the server" },
      JSON_FLAG,
    ],
    run: remotePair,
  },
  {
    group: "remote",
    name: "invite-user",
    summary: "Create an account, grant workspace access, and invite its first device",
    usage:
      "vibestudio remote invite-user --handle <handle> --workspace <name> [--workspace <name>...]",
    flags: [
      { name: "handle", takesValue: true, description: "Unique account handle" },
      { name: "display-name", takesValue: true, description: "Human-readable account name" },
      { name: "role", takesValue: true, description: "Account role: admin or member" },
      {
        name: "workspace",
        takesValue: true,
        multiple: true,
        description: "Workspace to grant (repeatable)",
      },
      { name: "ttl-ms", takesValue: true, description: "Invite lifetime (30000-3600000 ms)" },
      JSON_FLAG,
    ],
    run: remoteInviteUser,
  },
  {
    group: "remote",
    name: "pair-device",
    summary: "Invite another device for the current account",
    usage: "vibestudio remote pair-device [--workspace <name>] [--ttl-ms <milliseconds>]",
    flags: [
      { name: "workspace", takesValue: true, description: "Workspace opened after pairing" },
      { name: "ttl-ms", takesValue: true, description: "Invite lifetime (30000-3600000 ms)" },
      JSON_FLAG,
    ],
    run: remotePairDevice,
  },
  {
    group: "remote",
    name: "add-member",
    summary: "Grant an existing account access to a workspace",
    usage: "vibestudio remote add-member --workspace <name> (--user-id <id> | --handle <handle>)",
    flags: [
      { name: "workspace", takesValue: true },
      { name: "user-id", takesValue: true },
      { name: "handle", takesValue: true },
      JSON_FLAG,
    ],
    run: (inv) => remoteMutateMember(inv, false),
  },
  {
    group: "remote",
    name: "remove-member",
    summary: "Revoke an account's access to a workspace",
    usage:
      "vibestudio remote remove-member --workspace <name> (--user-id <id> | --handle <handle>)",
    flags: [
      { name: "workspace", takesValue: true },
      { name: "user-id", takesValue: true },
      { name: "handle", takesValue: true },
      JSON_FLAG,
    ],
    run: (inv) => remoteMutateMember(inv, true),
  },
  {
    group: "remote",
    name: "list-users",
    summary: "List the members of a workspace",
    usage: "vibestudio remote list-users --workspace <name>",
    flags: [{ name: "workspace", takesValue: true }, JSON_FLAG],
    run: remoteListUsers,
  },
  {
    group: "remote",
    name: "list-devices",
    summary: "List paired devices",
    usage: "vibestudio remote list-devices",
    flags: [JSON_FLAG],
    run: remoteListDevices,
  },
  {
    group: "remote",
    name: "revoke-device",
    summary: "Revoke a paired device and close its live sessions",
    usage: "vibestudio remote revoke-device <device-id>",
    flags: [JSON_FLAG],
    run: remoteRevokeDevice,
  },
  {
    group: "remote",
    name: "status",
    summary: "Check the stored credential against the server",
    usage: "vibestudio remote status",
    flags: [JSON_FLAG],
    run: remoteStatus,
  },
  {
    group: "remote",
    name: "workspaces",
    summary: "List workspaces on the paired server",
    usage: "vibestudio remote workspaces",
    flags: [JSON_FLAG],
    run: remoteWorkspaceList,
  },
  {
    group: "remote",
    name: "select",
    summary: "Select a workspace on the paired server",
    usage: "vibestudio remote select <workspace>",
    flags: [{ name: "workspace", takesValue: true }, JSON_FLAG],
    run: remoteWorkspaceSelect,
  },
  {
    group: "remote",
    name: "terminal",
    summary: "Review approvals and start the selected terminal app",
    usage:
      "vibestudio remote terminal [--pair <link>] [--workspace <name>] [--yes] [--timeout 10m]",
    flags: [
      {
        name: "pair",
        takesValue: true,
        description: "Pair from a Vibestudio pairing link before starting",
      },
      { name: "label", takesValue: true, description: "Device label used while pairing" },
      { name: "workspace", takesValue: true, description: "Remote workspace to open" },
      {
        name: "yes",
        takesValue: false,
        description: "Approve each terminal startup approval once without prompting",
      },
      {
        name: "timeout",
        takesValue: true,
        description: "Stop waiting after this duration (default 10m)",
      },
      JSON_FLAG,
    ],
    run: terminalStart,
  },
  {
    group: "remote",
    name: "logout",
    summary: "Remove the stored CLI device credential",
    usage: "vibestudio remote logout",
    flags: [JSON_FLAG],
    run: async (inv) => {
      const json = jsonMode(inv.flags["json"] === true);
      clearCliCredentials();
      printResult({ loggedOut: true }, { json, human: () => console.log("logged out") });
      return 0;
    },
  },
  {
    group: "remote",
    name: "host",
    summary: "Run a headless Chromium panel host against the paired server",
    usage:
      "vibestudio remote host [--label <name>] " +
      "[--max-panels 8] [--idle-unload-min 5] [--idle-exit-min 0] [--chromium-path <bin>] [--lean-browser]",
    flags: [
      { name: "label", takesValue: true, description: "Client label shown in lease holders" },
      { name: "max-panels", takesValue: true, description: "Concurrent hosted panels (default 8)" },
      {
        name: "idle-unload-min",
        takesValue: true,
        description: "Unload panels idle this long (default 5)",
      },
      {
        name: "idle-exit-min",
        takesValue: true,
        description: "Self-exit after holding zero leases this long (default: never)",
      },
      { name: "chromium-path", takesValue: true, description: "Chromium executable override" },
      {
        name: "lean-browser",
        takesValue: false,
        description: "Download chrome-headless-shell instead of full Chrome",
      },
      JSON_FLAG,
    ],
    run: remoteHost,
  },
];

const terminalCommands: CliCommand[] = [
  {
    group: "terminal",
    name: "start",
    summary: "Review approvals and start the selected terminal app",
    usage: "vibestudio terminal start [--pair <link>] [--workspace <name>] [--yes] [--timeout 10m]",
    flags: [
      {
        name: "pair",
        takesValue: true,
        description: "Pair from a Vibestudio pairing link before starting",
      },
      { name: "label", takesValue: true, description: "Device label used while pairing" },
      { name: "workspace", takesValue: true, description: "Remote workspace to open" },
      {
        name: "yes",
        takesValue: false,
        description: "Approve each terminal startup approval once without prompting",
      },
      {
        name: "timeout",
        takesValue: true,
        description: "Stop waiting after this duration (default 10m)",
      },
      JSON_FLAG,
    ],
    run: terminalStart,
  },
];

function headlessHostEntryPath(): string {
  const override = process.env["VIBESTUDIO_HEADLESS_HOST_ENTRY"];
  if (override) return path.resolve(override);
  // Root builds copy the headless host bundle to dist/headless-host so the
  // installed CLI can import plain JS. In-repo dev falls back to app dist or
  // TS source (the CLI runs under tsx in-repo).
  const bundledEntry = path.join(repoRoot, "dist", "headless-host", "index.js");
  const appDistEntry = path.join(repoRoot, "apps", "headless-host", "dist", "index.js");
  const srcEntry = path.join(repoRoot, "apps", "headless-host", "src", "index.ts");
  return fs.existsSync(bundledEntry)
    ? bundledEntry
    : fs.existsSync(appDistEntry)
      ? appDistEntry
      : srcEntry;
}

async function createWebRtcHeadlessHostOverrides(
  creds: DeviceCredential & {
    workspacePairing: NonNullable<DeviceCredential["workspacePairing"]>;
  },
  opts: { label?: string }
): Promise<Record<string, unknown>> {
  const [{ WebRtcRpcClient }, { startPanelAssetFacade }, { RemoteCdpHostBridgeSocket }] =
    await Promise.all([
      import("./webrtcClient.js"),
      import("../main/panelAssetFacade.js"),
      import(pathToFileURL(headlessHostEntryPath()).href),
    ]);

  const clientSessionId = `headless-${randomUUID()}`;
  const label = opts.label ?? "Headless";
  const token = `refresh:${creds.deviceId}:${creds.refreshToken}`;
  const client = new WebRtcRpcClient({
    pairing: creds.workspacePairing,
    callerId: `shell:${creds.deviceId}`,
    getToken: () => token,
    connectionId: clientSessionId,
    clientLabel: label,
    logPrefix: "[headless-webrtc]",
  });
  await client.ready();

  let facade: Awaited<ReturnType<typeof startPanelAssetFacade>> | null = null;
  try {
    const rpc = {
      call<T = unknown>(
        targetId: string,
        method: string,
        args: unknown[] = [],
        options?: unknown
      ): Promise<T> {
        void options;
        return targetId === "main"
          ? client.call<T>(method, args)
          : client.callTarget<T>(targetId, method, args);
      },
      stream(
        targetId: string,
        method: string,
        args: unknown[] = [],
        options?: Parameters<import("./webrtcClient.js").WebRtcRpcClient["stream"]>[3]
      ): Promise<Response> {
        return client.stream(targetId, method, args, options);
      },
    };
    facade = await startPanelAssetFacade(
      {
        stream(service, method, args, options) {
          return client.stream("main", `${service}.${method}`, args, options);
        },
      },
      {
        stateDir: path.join(
          os.homedir(),
          ".local",
          "state",
          "vibestudio",
          "headless-host",
          "panel-asset-facade"
        ),
      }
    );
    const activeFacade = facade;

    const eventListeners = new Set<(event: string, payload: unknown) => void>();
    const recoveryHandlers = new Set<() => void | Promise<void>>();
    const cleanups: Array<() => void> = [];
    cleanups.push(
      await client.onEvent("panel:runtimeLeaseChanged", (payload) => {
        for (const listener of eventListeners) listener("panel:runtimeLeaseChanged", payload);
      })
    );
    cleanups.push(
      await client.onRecovery(async () => {
        for (const handler of recoveryHandlers) await handler();
      })
    );

    return {
      serverUrl: `http://127.0.0.1:${activeFacade.port}`,
      clientSessionId,
      connectionFactory: async () => ({
        rpc,
        getToken: () => token,
        onServerEvent(listener: (event: string, payload: unknown) => void) {
          eventListeners.add(listener);
        },
        onResubscribe(handler: () => void | Promise<void>) {
          recoveryHandlers.add(handler);
        },
        async close() {
          for (const cleanup of cleanups.splice(0)) cleanup();
          await client.close();
        },
      }),
      bridgeSocketFactory: () =>
        new RemoteCdpHostBridgeSocket({
          rpc,
          hostConnectionId: clientSessionId,
        }),
      cleanup: async () => {
        for (const cleanup of cleanups.splice(0)) cleanup();
        await activeFacade.close();
        await client.close();
      },
    };
  } catch (error) {
    await facade?.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function remoteHost(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    return await remoteHostImpl(inv);
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteHostImpl(inv: ParsedInvocation): Promise<number> {
  const flagStr = (name: string): string | undefined =>
    typeof inv.flags[name] === "string" ? (inv.flags[name] as string) : undefined;
  const flagMin = (name: string, allowZero = false): number | undefined => {
    const raw = flagStr(name);
    if (!raw) return undefined;
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || (!allowZero && minutes <= 0) || (allowZero && minutes < 0)) {
      throw new UsageError(
        `--${name} must be ${allowZero ? "zero or a positive number" : "a positive number"}`
      );
    }
    return minutes * 60_000;
  };

  const creds = loadCliCredentials();
  if (!creds) {
    console.error(NOT_PAIRED_GUIDANCE);
    return 3;
  }
  if (!isSelectedWorkspaceUrl(creds.url)) {
    console.error("stored remote credential is not scoped to a workspace");
    return 3;
  }
  const configOverrides: Record<string, unknown> = await createWebRtcHeadlessHostOverrides(creds, {
    label: flagStr("label"),
  });
  const cleanup =
    typeof configOverrides["cleanup"] === "function"
      ? (configOverrides["cleanup"] as () => Promise<void>)
      : null;
  delete configOverrides["cleanup"];

  const entry = headlessHostEntryPath();
  const { HeadlessHost, resolveConfig } = (await import(pathToFileURL(entry).href)) as {
    HeadlessHost: new (config: unknown) => {
      start(): Promise<void>;
      stop(reason: string): Promise<void>;
      done: Promise<void>;
    };
    resolveConfig: (overrides: Record<string, unknown>) => unknown;
  };

  const maxPanelsRaw = flagStr("max-panels");
  const maxPanels = maxPanelsRaw === undefined ? undefined : Number(maxPanelsRaw);
  if (maxPanels !== undefined && (!Number.isInteger(maxPanels) || maxPanels <= 0)) {
    throw new UsageError("--max-panels must be a positive integer");
  }
  const config = resolveConfig({
    ...configOverrides,
    label: flagStr("label"),
    maxPanels,
    idleUnloadMs: flagMin("idle-unload-min"),
    idleExitMs: flagMin("idle-exit-min", true),
    chromiumPath: flagStr("chromium-path"),
    leanBrowser: inv.flags["lean-browser"] === true,
  });
  const host = new HeadlessHost(config);
  process.on("SIGINT", () => void host.stop("SIGINT"));
  process.on("SIGTERM", () => void host.stop("SIGTERM"));
  try {
    await host.start();
  } catch (error) {
    await cleanup?.().catch(() => undefined);
    throw new CliError(
      `headless host failed to start: ${redactCliSecrets(error instanceof Error ? error.message : String(error))}`
    );
  }
  await host.done;
  await cleanup?.().catch(() => undefined);
  return 0;
}

const mobileCommands: CliCommand[] = [
  scriptCommand("mobile", "pair", "mobile-pair.mjs", "Start the QR/deep-link pairing server", {
    usage: "vibestudio mobile pair [--port 3030]",
    // The pair server's own help documents the resolved server entry.
    passthroughHelp: true,
  }),
  scriptCommand("mobile", "dev", "mobile-dev.mjs", "Metro + local server + debug APK", {
    usage: "vibestudio mobile dev [--platform android|ios] [--avd <name>] [--device <serial>]",
  }),
  scriptCommand(
    "mobile",
    "smoke",
    "mobile-smoke.mjs",
    "Verify the installed internal APK can pair and reach the workspace app",
    {
      usage: "vibestudio mobile smoke [--platform android|ios] [options]",
      passthroughHelp: true,
    }
  ),
  scriptCommand("mobile", "install", "mobile-install.mjs", "Install the internal APK", {
    usage: "vibestudio mobile install [--platform android|ios] [--device <serial>] [--launch]",
  }),
  scriptCommand("mobile", "devices", "mobile-device.mjs", "Discover phones and app compatibility", {
    usage: "vibestudio mobile devices [--platform android|ios] [--json]",
    prependArgs: ["devices"],
  }),
  scriptCommand("mobile", "connect", "mobile-device.mjs", "Open a secure pairing link on a phone", {
    usage: "vibestudio mobile connect --pair <link> [--platform android|ios] [--device <serial>]",
    prependArgs: ["connect"],
  }),
  scriptCommand("mobile", "logs", "mobile-logs.mjs", "Tail app logs from a device", {
    usage: "vibestudio mobile logs [--platform android|ios] [--device <serial>]",
  }),
  scriptCommand(
    "mobile",
    "emulator",
    "mobile-emulator.mjs",
    "Start an Android emulator or iOS simulator",
    {
      usage:
        "vibestudio mobile emulator [--platform android|ios] [--avd <name>] [--simulator <name>]",
    }
  ),
  scriptCommand(
    "mobile",
    "doctor",
    "mobile-doctor.mjs",
    "Run mobile toolchain and provisioning checks",
    {
      usage: "vibestudio mobile doctor [--json]",
    }
  ),
];

/**
 * The full command registry. Extension point: later command groups
 * (fs, vcs, eval, ...) append their `CliCommand[]` here.
 */
const commandRegistry: CliCommand[] = [
  ...remoteCommands,
  ...terminalCommands,
  ...mobileCommands,
  ...agentCommands,
  ...fsCommands,
  ...vcsCommands,
  ...evalCommands,
  ...channelCommands,
  ...contextCommands,
  ...panelCommands,
  ...systemTestCommands,
];

const GROUP_ORDER = [
  "remote",
  "terminal",
  "mobile",
  "agent",
  "fs",
  "vcs",
  "eval",
  "channel",
  "context",
  "panel",
  "system-test",
];

export async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv;
  setPlainOutput(argv.includes("--plain"));
  if (!group || group === "--help") {
    printHelp();
    return 0;
  }
  if (group === "help") {
    const topic = rest[0];
    if (!topic) {
      printHelp();
      return 0;
    }
    if (topic === "claude") {
      return await runClaudeGroup(["--help"]);
    }
    if (!GROUP_ORDER.includes(topic)) {
      console.error(`Unknown help topic: ${topic}`);
      return 2;
    }
    printGroupHelp(topic);
    return 0;
  }
  if (group === "--version" || group === "-v" || group === "version") {
    console.log(packageVersion());
    return 0;
  }
  // The `claude` group self-parses (it supports a bare launcher invocation plus
  // `emit`/`channel-host` subcommands) and calls the configured Claude Code
  // provider over RPC — it deliberately owns no `CliCommand` entries.
  if (group === "claude") {
    const json = jsonMode(rest.includes("--json"));
    const claudeArgs = rest.filter((arg) => arg !== "--json" && arg !== "--plain");
    try {
      return await runClaudeGroup(claudeArgs, { json });
    } catch (error) {
      return printError(error, { json });
    }
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
  if (command.passthrough && command.passthroughHelp && wantsScriptHelp(subArgs)) {
    return await command.run({ positionals: subArgs, flags: {}, flagsMulti: () => [] }, subArgs);
  }
  if (wantsHelp(subArgs)) {
    console.log(renderCommandHelp(command));
    return 0;
  }
  if (command.passthrough) {
    return await command.run({ positionals: subArgs, flags: {}, flagsMulti: () => [] }, subArgs);
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

/** Whether argv requests command help (--help/-h before any `--` separator). */
function wantsHelp(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

/** Whether argv asks a passthrough script for its own richer help. */
function wantsScriptHelp(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

function runScript(scriptName: string, argv: string[]): Promise<number> {
  const scriptPath = path.join(repoRoot, "scripts", "cli", scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(
      `CLI support file is missing: scripts/cli/${scriptName}. ` +
        "Reinstall or update Vibestudio; if this persists, the package was published incomplete."
    );
    return Promise.resolve(1);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...normalizePassthroughArgs(argv)], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        // If the signal is trapped or ignored, still resolve so main() exits.
        resolve(128 + (os.constants.signals[signal] ?? 0));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

function normalizePassthroughArgs(argv: string[]): string[] {
  const normalized: string[] = [];
  let passthrough = false;
  for (const arg of argv) {
    if (passthrough || arg === "--") {
      normalized.push(arg);
      passthrough = true;
      continue;
    }
    const inline = /^(--[^=]+)=(.*)$/.exec(arg);
    const flag = inline?.[1];
    const value = inline?.[2];
    if (flag !== undefined && value !== undefined) normalized.push(flag, value);
    else normalized.push(arg);
  }
  return normalized;
}

function printHelp(): void {
  const sections = GROUP_ORDER.map(
    (group) =>
      `\n${group} — ${GROUP_DESCRIPTIONS[group] ?? "Commands"}\n${renderGroupHelp(commandRegistry, group)}`
  ).join("\n");
  const claudeSection =
    "  vibestudio claude [--channel <id>]                   Launch Claude Code as a linked channel agent";
  console.log(`vibestudio

Usage:
${sections}
${claudeSection}

Getting started:
  1. Get a pairing invite from the desktop app or the server host.
  2. vibestudio remote pair "https://vibestudio.app/pair#..."
  3. vibestudio remote status

Run \`vibestudio <group> --help\` for a group's commands and
\`vibestudio <group> <command> --help\` for flags and full usage.
Piped output is JSON by default; pass --plain to keep readable output.
Credentials are stored as a 0600 JSON file at ${credentialPath()}.
`);
}

const GROUP_DESCRIPTIONS: Record<string, string> = {
  remote: "pairing, servers, workspaces, and remote hosts",
  terminal: "launch the terminal workspace app",
  mobile: "develop, install, inspect, and pair mobile clients",
  agent: "sessions, diagnostics, services, and workspace skills",
  fs: "read and edit files in the active agent context",
  vcs: "inspect, commit, merge, and push workspace repositories",
  eval: "run sandboxed code in the active agent context",
  channel: "list, read, send, and follow conversation channels",
  context: "materialize and watch remote context folders",
  panel: "inspect and capture workspace panels",
};

function printGroupHelp(group: string): void {
  console.log(`vibestudio ${group}

Usage:
${renderGroupHelp(commandRegistry, group)}
`);
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    // Fall through to a deterministic placeholder for unusual embedded launches.
  }
  return "0.0.0";
}

export function installBrokenPipeHandler(
  stream: NodeJS.EventEmitter,
  terminate: () => void = () => process.exit(0)
): () => void {
  const onError = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      terminate();
      return;
    }
    throw error;
  };
  stream.on("error", onError);
  return () => stream.off("error", onError);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Unix consumers such as `head` may intentionally close a pipe before a
  // large JSON response finishes. Treat that as successful consumption rather
  // than crashing with an unhandled stdout/stderr EPIPE.
  installBrokenPipeHandler(process.stdout);
  installBrokenPipeHandler(process.stderr);
  main(process.argv.slice(2))
    .then((code) => {
      // Let stdout/stderr drain before Node exits. Calling process.exit here
      // truncates large piped JSON and binary `fs read` output at the pipe buffer.
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}

export { commandRegistry, groupCommands };
