#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { DEFAULT_SIGNAL_URL, resolveSignalingUrl } from "./lib/connect-utils.mjs";

const require = createRequire(import.meta.url);

const UNIT_NAME = "vibestudio-server.service";

export function parseArgs(argv) {
  const options = {
    signalUrl: null,
    identity: null,
    workspace: "default",
    json: false,
    help: false,
  };
  let identityExplicit = false;
  let workspaceExplicit = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--signal-url") {
      options.signalUrl = argv[++i] ?? "";
    } else if (arg === "--identity") {
      identityExplicit = true;
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--identity requires a path");
      options.identity = path.resolve(value);
    } else if (arg === "--workspace") {
      workspaceExplicit = true;
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--workspace requires a name");
      options.workspace = value;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (identityExplicit && workspaceExplicit) {
    throw new Error("pass --workspace or --identity, not both");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.workspace)) {
    throw new Error("--workspace must contain only letters, numbers, hyphens, and underscores");
  }
  options.identity ??= identityDefaultPath(options.workspace);
  return options;
}

function printHelp() {
  console.log(`vibestudio remote doctor

Usage:
  vibestudio remote doctor [--signal-url <wss-url>]
    [--workspace <name> | --identity <identity.pem>] [--json]

Checks:
  node-datachannel native addon, deleted legacy WebRTC cert/key env vars, the
  identity.pem layout (present, 0600, cert+key), signaling reachability, and —
  when a deployed systemd unit is present — the unit's active state and gateway
  port. Server-only checks are skipped (not failed) off the deployed host.
`);
}

export function check(condition, name, ok, fail, meta = {}) {
  return { name, ok: Boolean(condition), message: condition ? ok : fail, ...meta };
}

export function skip(name, message, meta = {}) {
  return { name, ok: true, skipped: true, message, ...meta };
}

export function identityDefaultPath(workspace = "default") {
  // Workspace answerers own their identities beneath the hub's managed
  // workspace directory. Honor XDG_CONFIG_HOME exactly as env-paths does.
  const configRoot = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "vibestudio")
    : path.join(os.homedir(), ".config", "vibestudio");
  return path.join(configRoot, "workspaces", workspace, "state", "webrtc", "identity.pem");
}

export function inspectIdentity(identityPath) {
  if (!identityPath) identityPath = identityDefaultPath();
  const dir = path.dirname(identityPath);
  const legacy = ["server.pem", "server.key"].filter((name) => fs.existsSync(path.join(dir, name)));
  if (legacy.length > 0) {
    return check(
      false,
      "identity",
      "",
      `legacy WebRTC identity remnants found (run: vibestudio remote repair-identity --yes): ${legacy.join(", ")}`,
      {
        path: identityPath,
      }
    );
  }
  let stat;
  try {
    stat = fs.statSync(identityPath);
  } catch {
    return check(false, "identity", "", `identity file is missing: ${identityPath}`, {
      path: identityPath,
    });
  }
  // Private key material must not be group/world accessible.
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return check(
      false,
      "identity",
      "",
      `identity.pem is group/world accessible (mode ${mode.toString(8).padStart(4, "0")}); run: chmod 600 ${identityPath}`,
      { path: identityPath, mode }
    );
  }
  const text = fs.readFileSync(identityPath, "utf8");
  const hasCert = text.includes("-----BEGIN CERTIFICATE-----");
  const hasKey = /-----BEGIN (RSA |EC |)PRIVATE KEY-----/.test(text);
  return check(
    hasCert && hasKey,
    "identity",
    `identity.pem present, 0600, cert+key: ${identityPath}`,
    `identity.pem must contain both certificate and private key: ${identityPath}`,
    { path: identityPath }
  );
}

/**
 * Build the reachability probe URL. The signaling worker only upgrades
 * `/room/:id?role=…` (apps/signaling/src/index.ts) — dialing the endpoint ROOT
 * never upgrades and falsely reports a healthy endpoint as unreachable. Match how
 * packages/rpc/src/transports/webrtcSignalingClient.ts joins: a per-room ws URL
 * with role=answerer against a throwaway random room id.
 */
export function signalingRoomWsUrl(resolvedUrl, room = randomUUID()) {
  const url = new URL(resolvedUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/room/${encodeURIComponent(room)}`;
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  url.searchParams.set("role", "answerer");
  return url.toString();
}

export async function checkSignaling(signalUrl, wsFactory = (u) => new WebSocket(u)) {
  const resolved = resolveSignalingUrl({
    flag: signalUrl ?? undefined,
    defaultUrl: DEFAULT_SIGNAL_URL,
  });
  const url = signalingRoomWsUrl(resolved.url);
  return new Promise((resolve) => {
    let settled = false;
    const socket = wsFactory(url);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.terminate?.() ?? socket.close?.();
      } catch {
        /* already closing */
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(
        check(false, "signaling", "", `timed out connecting to ${url}`, {
          url,
          source: resolved.source,
        })
      );
    }, 8000);
    socket.once("open", () => {
      finish(
        check(true, "signaling", `reachable: ${resolved.url} (${resolved.source})`, "", {
          url,
          source: resolved.source,
        })
      );
    });
    socket.once("error", (error) => {
      finish(
        check(false, "signaling", "", `cannot connect to ${url}: ${error.message}`, {
          url,
          source: resolved.source,
        })
      );
    });
  });
}

function unitFilePath() {
  return path.join(os.homedir(), ".config", "systemd", "user", UNIT_NAME);
}

/** Parse `--port N` out of the unit's ExecStart line, if present. */
export function gatewayPortFromUnit(unitText) {
  const match = unitText.match(/ExecStart=.*\bremote serve\b.*?--port[= ](\d{1,5})/);
  return match ? Number(match[1]) : null;
}

async function checkGatewayPort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(
        check(true, "gateway-port", `loopback gateway is listening on 127.0.0.1:${port}`, "")
      );
    });
    socket.setTimeout(3000);
    socket.once("timeout", () => {
      socket.destroy();
      resolve(
        check(
          false,
          "gateway-port",
          "",
          `nothing is listening on 127.0.0.1:${port} (check: vibestudio remote deploy logs <host>)`
        )
      );
    });
    socket.once("error", (error) => {
      resolve(check(false, "gateway-port", "", `cannot reach 127.0.0.1:${port}: ${error.message}`));
    });
  });
}

export async function checkDeployedUnit(spawnImpl, unitPath = unitFilePath()) {
  if (!fs.existsSync(unitPath)) {
    return {
      unit: skip("systemd-unit", "no deployed unit on this host (client preflight)"),
      port: null,
    };
  }
  const { spawnSync } = spawnImpl ?? (await import("node:child_process"));
  const active = spawnSync("systemctl", ["--user", "is-active", UNIT_NAME], { encoding: "utf8" });
  const state = (active.stdout ?? "").trim() || (active.stderr ?? "").trim();
  const unit = check(
    active.status === 0,
    "systemd-unit",
    `${UNIT_NAME} is active`,
    `${UNIT_NAME} is ${state || "not active"} (check: vibestudio remote deploy status <host>)`
  );
  let port = null;
  try {
    port = gatewayPortFromUnit(fs.readFileSync(unitPath, "utf8"));
  } catch {
    port = null;
  }
  return { unit, port };
}

export async function runDoctor(options, deps = {}) {
  const checks = [];
  try {
    (deps.require ?? require)("node-datachannel");
    checks.push(check(true, "node-datachannel", "native addon loads", ""));
  } catch (error) {
    checks.push(
      check(false, "node-datachannel", "", `native addon failed to load: ${error.message}`)
    );
  }
  checks.push(
    check(
      !process.env.VIBESTUDIO_WEBRTC_CERT && !process.env.VIBESTUDIO_WEBRTC_KEY,
      "legacy-env",
      "legacy VIBESTUDIO_WEBRTC_CERT/KEY env vars are absent",
      "remove VIBESTUDIO_WEBRTC_CERT and VIBESTUDIO_WEBRTC_KEY; use VIBESTUDIO_WEBRTC_IDENTITY"
    )
  );
  const { unit, port } = await checkDeployedUnit(deps.spawnImpl, deps.unitPath);
  checks.push(unit);
  if (port !== null) {
    checks.push(await checkGatewayPort(port));
  }
  checks.push(inspectIdentity(options.identity));
  checks.push(await checkSignaling(options.signalUrl, deps.wsFactory));
  return { ok: checks.filter((entry) => !entry.skipped).every((entry) => entry.ok), checks };
}

function renderChecklist({ ok, checks }) {
  const symbol = (entry) => (entry.skipped ? "○" : entry.ok ? "✓" : "✗");
  console.log("\nVibestudio remote doctor");
  console.log("─".repeat(40));
  for (const entry of checks) {
    console.log(`  ${symbol(entry)} ${entry.name.padEnd(16)} ${entry.message}`);
  }
  console.log("─".repeat(40));
  console.log(ok ? "  All checks passed. 🎉\n" : "  Some checks failed — see the ✗ lines above.\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const result = await runDoctor(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    renderChecklist(result);
  }
  return result.ok ? 0 : 1;
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isDirectRun()) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[remote-doctor] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
