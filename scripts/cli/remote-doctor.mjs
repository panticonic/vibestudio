#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { DEFAULT_SIGNAL_URL, resolveSignalingUrl } from "./lib/connect-utils.mjs";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const options = {
    signalUrl: null,
    identity: process.env.VIBESTUDIO_WEBRTC_IDENTITY ?? null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--signal-url" || arg === "--signaling-url") {
      options.signalUrl = argv[++i] ?? "";
    } else if (arg === "--identity") {
      options.identity = path.resolve(argv[++i] ?? "");
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`vibestudio remote doctor

Usage:
  vibestudio remote doctor [--signal-url <wss-url>] [--identity <identity.pem>] [--json]

Checks:
  node-datachannel native addon, signaling endpoint policy/reachability, single
  identity.pem layout, and deleted legacy WebRTC cert/key env vars.
`);
}

function check(condition, name, ok, fail, meta = {}) {
  return { name, ok: Boolean(condition), message: condition ? ok : fail, ...meta };
}

function identityDefaultPath() {
  const configRoot = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "vibestudio")
    : path.join(os.homedir(), ".config", "vibestudio");
  return path.join(configRoot, "webrtc", "identity.pem");
}

function inspectIdentity(identityPath) {
  if (!identityPath) identityPath = identityDefaultPath();
  const dir = path.dirname(identityPath);
  const legacy = ["server.pem", "server.key"].filter((name) => fs.existsSync(path.join(dir, name)));
  if (legacy.length > 0) {
    return check(false, "identity", "", `legacy WebRTC identity remnants found: ${legacy.join(", ")}`, {
      path: identityPath,
      legacy,
    });
  }
  if (!fs.existsSync(identityPath)) {
    return check(false, "identity", "", `identity file is missing: ${identityPath}`, { path: identityPath });
  }
  const text = fs.readFileSync(identityPath, "utf8");
  const hasCert = text.includes("-----BEGIN CERTIFICATE-----");
  const hasKey = /-----BEGIN (RSA |EC |)PRIVATE KEY-----/.test(text);
  return check(
    hasCert && hasKey,
    "identity",
    `single identity file is present: ${identityPath}`,
    `identity.pem must contain both certificate and private key: ${identityPath}`,
    { path: identityPath }
  );
}

async function checkSignaling(signalUrl) {
  const resolved = resolveSignalingUrl({ flag: signalUrl ?? undefined, defaultUrl: DEFAULT_SIGNAL_URL });
  const url = resolved.url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(check(false, "signaling", "", `timed out connecting to ${url}`, { url, source: resolved.source }));
    }, 5000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve(check(true, "signaling", `reachable: ${url} (${resolved.source})`, "", { url, source: resolved.source }));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(check(false, "signaling", "", `cannot connect to ${url}: ${error.message}`, { url, source: resolved.source }));
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const checks = [];
  try {
    require("node-datachannel");
    checks.push(check(true, "node-datachannel", "native addon loads", ""));
  } catch (error) {
    checks.push(check(false, "node-datachannel", "", `native addon failed to load: ${error.message}`));
  }
  checks.push(
    check(
      !process.env.VIBESTUDIO_WEBRTC_CERT && !process.env.VIBESTUDIO_WEBRTC_KEY,
      "legacy-env",
      "legacy VIBESTUDIO_WEBRTC_CERT/KEY env vars are absent",
      "remove VIBESTUDIO_WEBRTC_CERT and VIBESTUDIO_WEBRTC_KEY; use VIBESTUDIO_WEBRTC_IDENTITY"
    )
  );
  checks.push(inspectIdentity(options.identity));
  checks.push(await checkSignaling(options.signalUrl));
  const ok = checks.every((entry) => entry.ok);
  if (options.json) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
  } else {
    for (const entry of checks) {
      console.log(`${entry.ok ? "ok" : "fail"} ${entry.name}: ${entry.message}`);
    }
  }
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`[remote-doctor] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
