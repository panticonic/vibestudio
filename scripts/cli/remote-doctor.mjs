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
  node-datachannel native addon, signaling endpoint policy/reachability, single
  workspace identity.pem layout.
`);
}

function check(condition, name, ok, fail, meta = {}) {
  return { name, ok: Boolean(condition), message: condition ? ok : fail, ...meta };
}

function identityDefaultPath(workspace) {
  const configRoot = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "vibestudio")
    : path.join(os.homedir(), ".config", "vibestudio");
  return path.join(configRoot, "workspaces", workspace, "state", "webrtc", "identity.pem");
}

function inspectIdentity(identityPath) {
  if (!fs.existsSync(identityPath)) {
    return check(false, "identity", "", `identity file is missing: ${identityPath}`, {
      path: identityPath,
    });
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
  const resolved = resolveSignalingUrl({
    flag: signalUrl ?? undefined,
    defaultUrl: DEFAULT_SIGNAL_URL,
  });
  const url = resolved.url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(
        check(false, "signaling", "", `timed out connecting to ${url}`, {
          url,
          source: resolved.source,
        })
      );
    }, 5000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve(
        check(true, "signaling", `reachable: ${url} (${resolved.source})`, "", {
          url,
          source: resolved.source,
        })
      );
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(
        check(false, "signaling", "", `cannot connect to ${url}: ${error.message}`, {
          url,
          source: resolved.source,
        })
      );
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
    checks.push(
      check(false, "node-datachannel", "", `native addon failed to load: ${error.message}`)
    );
  }
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

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[remote-doctor] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
