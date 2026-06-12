#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import * as tls from "node:tls";
import { fileURLToPath } from "node:url";
import { parseConnectLink, parseConnectServerUrl } from "./lib/connect-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// NOTE: minimal inline copy of src/cli/credentialStore.ts. This script runs
// as a plain .mjs (spawned by the CLI and runnable standalone before any
// build exists), so it cannot import the TypeScript CLI modules; like the
// other scripts here it only shares code via scripts/cli/lib/*.mjs.
function credentialPath() {
  return path.join(os.homedir(), ".config", "natstack", "cli-credentials.json");
}

function loadCliCredentials() {
  const p = credentialPath();
  if (!fs.existsSync(p)) return null;
  const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  if (
    parsed?.schemaVersion !== 1 ||
    parsed?.kind !== "device" ||
    typeof parsed.url !== "string" ||
    typeof parsed.deviceId !== "string" ||
    typeof parsed.refreshToken !== "string"
  ) {
    return null;
  }
  return parsed;
}

function saveCliCredentials(creds) {
  const p = credentialPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
}

function parseArgs(argv) {
  const options = {
    pairLink: null,
    url: null,
    token: null,
    deviceId: null,
    refreshToken: null,
    caPath: null,
    fingerprint: null,
    label: null,
    help: false,
    electronArgs: [],
  };
  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (passthrough) {
      options.electronArgs.push(arg);
    } else if (arg === "--") {
      passthrough = true;
    } else if (arg === "--pair") {
      options.pairLink = argv[++i] ?? "";
    } else if (arg.startsWith("natstack://")) {
      options.pairLink = arg;
    } else if (arg === "--url") {
      options.url = argv[++i] ?? "";
    } else if (arg === "--token") {
      options.token = argv[++i] ?? "";
    } else if (arg === "--device-id") {
      options.deviceId = argv[++i] ?? "";
    } else if (arg === "--refresh-token") {
      options.refreshToken = argv[++i] ?? "";
    } else if (arg === "--ca") {
      options.caPath = argv[++i] ?? "";
    } else if (arg === "--fingerprint") {
      options.fingerprint = argv[++i] ?? "";
    } else if (arg === "--label") {
      options.label = argv[++i] ?? "";
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`natstack remote start

Pair this laptop with a running NatStack server, or launch Electron using the
previously paired CLI device credential.

Usage:
  natstack remote start --pair "natstack://connect?url=...&code=..."
  natstack remote start
  natstack remote start --url <url> --token <admin-token>
  natstack remote start --url <url> --device-id <id> --refresh-token <token>

Options:
  --pair <link>             Exchange a natstack://connect link, save a device credential, then launch.
  --url <url>               Remote server URL.
  --token <admin-token>     Admin token bootstrap.
  --device-id <id>          Device credential id.
  --refresh-token <token>   Device refresh token.
  --ca <path>               Custom CA path.
  --fingerprint <sha256>    Expected TLS leaf fingerprint.
  --label <label>           Device label used with --pair.
  --help                    Show this help.

Arguments after '--' are forwarded to Electron.
CLI device credentials are read from ${credentialPath()}.
`);
}

function normalizeFingerprint(raw) {
  if (!raw) return null;
  const hex = String(raw).replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 64) return String(raw).toUpperCase();
  return hex.match(/.{2}/g).join(":");
}

function sha256Fingerprint(der) {
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  return hex.match(/.{2}/g).join(":");
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function createPinnedTlsSocket({ host, port, expectedFingerprint }) {
  const sock = tls.connect({
    host,
    port,
    ...(isIpLiteral(host) ? {} : { servername: host }),
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  });
  sock.once("secureConnect", () => {
    const cert = sock.getPeerCertificate(false);
    if (!cert || !cert.raw) {
      sock.destroy(new Error("TLS fingerprint pinning: peer presented no certificate"));
      return;
    }
    const actual = sha256Fingerprint(cert.raw);
    if (actual !== expectedFingerprint) {
      sock.destroy(
        new Error(`TLS fingerprint mismatch: expected ${expectedFingerprint}, got ${actual}`)
      );
    }
  });
  return sock;
}

function createPinnedHttpsAgent(expectedFingerprint) {
  const agent = new HttpsAgent();
  agent.createConnection = (opts) => {
    const host = opts.host ?? "127.0.0.1";
    const port = typeof opts.port === "string" ? parseInt(opts.port, 10) : (opts.port ?? 443);
    return createPinnedTlsSocket({ host, port, expectedFingerprint });
  };
  return agent;
}

function parseJsonObject(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function postAuthJson(remoteUrl, route, bodyValue, options) {
  const requestUrl = new URL(route, remoteUrl);
  const body = JSON.stringify(bodyValue);
  const isHttps = requestUrl.protocol === "https:";
  const fingerprint = normalizeFingerprint(options.fingerprint);
  const agent =
    isHttps && fingerprint
      ? createPinnedHttpsAgent(fingerprint)
      : isHttps && options.caPath
        ? new HttpsAgent({ ca: fs.readFileSync(options.caPath) })
        : undefined;

  return new Promise((resolve, reject) => {
    const req = (isHttps ? httpsRequest : httpRequest)(
      requestUrl,
      {
        method: "POST",
        agent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.once("error", reject);
    req.end(body);
  });
}

async function pair(link, options) {
  const parsed = parseConnectLink(link);
  if (parsed.kind === "error") throw new Error(parsed.reason);
  const response = await postAuthJson(
    new URL(parsed.url),
    "/_r/s/auth/complete-pairing",
    {
      code: parsed.code,
      label: options.label ?? `${os.hostname()} CLI`,
      platform: "desktop",
    },
    options
  );
  const body = parseJsonObject(response.body);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      body?.error
        ? String(body.error)
        : `Pairing failed with HTTP ${response.statusCode}: ${response.statusMessage}`
    );
  }
  if (typeof body.deviceId !== "string" || typeof body.refreshToken !== "string") {
    throw new Error("Pairing response did not include a device credential");
  }
  const creds = {
    schemaVersion: 1,
    kind: "device",
    url: parsed.url,
    deviceId: body.deviceId,
    refreshToken: body.refreshToken,
  };
  saveCliCredentials(creds);
  console.log(`[start-remote] Paired ${body.label ?? "device"} with ${parsed.url}`);
  return creds;
}

function resolveLaunchCredentials(options, cliCreds) {
  if (options.url) {
    const parsedUrl = parseConnectServerUrl(options.url);
    if (parsedUrl.kind === "error") throw new Error(parsedUrl.reason);
    if (options.token) {
      return { url: parsedUrl.url, token: options.token };
    }
    if (options.deviceId && options.refreshToken) {
      return {
        url: parsedUrl.url,
        deviceId: options.deviceId,
        refreshToken: options.refreshToken,
      };
    }
    throw new Error("--url requires --token or --device-id plus --refresh-token");
  }
  if (cliCreds) return cliCreds;
  throw new Error(
    `No remote credentials found. Pair first with:\n  natstack remote start --pair "natstack://connect?url=...&code=..."`
  );
}

function launchElectron(creds, options) {
  const env = {
    ...process.env,
    NATSTACK_REMOTE_URL: creds.url,
    ...(creds.token ? { NATSTACK_REMOTE_TOKEN: creds.token } : {}),
    ...(creds.deviceId ? { NATSTACK_REMOTE_DEVICE_ID: creds.deviceId } : {}),
    ...(creds.refreshToken ? { NATSTACK_REMOTE_REFRESH_TOKEN: creds.refreshToken } : {}),
    ...(options.caPath ? { NATSTACK_REMOTE_CA: options.caPath } : {}),
    ...(options.fingerprint ? { NATSTACK_REMOTE_FINGERPRINT: options.fingerprint } : {}),
  };
  console.log(`[start-remote] Launching Electron against ${creds.url}`);
  const child = spawn(process.execPath, ["scripts/run-electron.mjs", ...options.electronArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const cliCreds = options.pairLink
    ? await pair(options.pairLink, options)
    : loadCliCredentials();
  const creds = resolveLaunchCredentials(options, cliCreds);
  launchElectron(creds, options);
}

main().catch((error) => {
  console.error(`[start-remote] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
