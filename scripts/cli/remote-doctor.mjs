#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { cliCredentialPath, hubIdentityPath, workspaceIdentityPath } from "./lib/config-paths.mjs";

const require = createRequire(import.meta.url);
const UNIT_NAME = "vibestudio-server.service";
const ALPN = [...new TextEncoder().encode("vibestudio-rpc/4")];
const PROBE_TIMEOUT_MS = 15_000;

export function parseArgs(argv) {
  const options = {
    workspace: null,
    identity: null,
    identityExplicit: false,
    relayUrls: [],
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") options.workspace = argv[++index] ?? "";
    else if (arg === "--relay-url") options.relayUrls.push(argv[++index] ?? "");
    else if (arg === "--identity") {
      options.identity = path.resolve(argv[++index] ?? "");
      options.identityExplicit = true;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.workspace && options.identity)
    throw new Error("pass --workspace or --identity, not both");
  if (options.workspace && !/^[A-Za-z0-9_-]{1,64}$/.test(options.workspace)) {
    throw new Error("--workspace has an invalid name");
  }
  options.identity ??= options.workspace
    ? workspaceIdentityPath(options.workspace)
    : hubIdentityPath();
  options.identityExplicit ||= options.workspace !== null;
  return options;
}

export function check(condition, name, ok, fail, meta = {}) {
  return { name, ok: Boolean(condition), message: condition ? ok : fail, ...meta };
}
export function skip(name, message, meta = {}) {
  return { name, ok: true, skipped: true, message, ...meta };
}

function loadBinding(loader = require) {
  const entry =
    typeof loader.resolve === "function"
      ? path.join(path.dirname(loader.resolve("@number0/iroh/package.json")), "index.js")
      : "@number0/iroh";
  const binding = loader(entry);
  if (
    typeof binding.Endpoint?.builder !== "function" ||
    typeof binding.SecretKey?.fromBytes !== "function"
  ) {
    throw new Error("@number0/iroh did not expose the pinned native API");
  }
  return binding;
}

export function inspectIdentity(identityPath, loader = require) {
  let stat;
  try {
    stat = fs.statSync(identityPath);
  } catch {
    return check(false, "endpoint-identity", "", `endpoint secret is missing: ${identityPath}`);
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return check(
      false,
      "endpoint-identity",
      "",
      `endpoint secret must be mode 0600 (found ${mode.toString(8)})`
    );
  }
  const bytes = fs.readFileSync(identityPath);
  try {
    if (bytes.byteLength !== 32) throw new Error("secret must contain exactly 32 bytes");
    const endpointId = loadBinding(loader)
      .SecretKey.fromBytes([...bytes])
      .public()
      .toString();
    return check(
      true,
      "endpoint-identity",
      `endpoint ${endpointId.slice(0, 12)}…; secret is 0600`,
      "",
      { endpointId }
    );
  } catch (error) {
    return check(false, "endpoint-identity", "", `malformed endpoint secret: ${error.message}`);
  }
}

export function loadPairedCredential(filename = cliCredentialPath()) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    return value?.transport === "iroh" ? value : null;
  } catch {
    return null;
  }
}

export function inspectCredentialEndpoint(credential, loader = require) {
  if (!credential) return skip("credential-endpoint", "no paired Iroh credential on this host");
  if (typeof credential.endpointSecret !== "string") {
    return check(false, "credential-endpoint", "", "paired endpoint secret is missing");
  }
  try {
    const secret = Buffer.from(credential.endpointSecret, "base64url");
    if (secret.byteLength !== 32) throw new Error("secret must contain exactly 32 bytes");
    const endpointId = loadBinding(loader)
      .SecretKey.fromBytes([...secret])
      .public()
      .toString();
    return check(
      /^[0-9a-f]{64}$/.test(endpointId),
      "credential-endpoint",
      `device credential owns endpoint ${endpointId.slice(0, 12)}…`,
      "paired endpoint secret did not derive a canonical Endpoint ID",
      { endpointId }
    );
  } catch (error) {
    return check(
      false,
      "credential-endpoint",
      "",
      `malformed paired endpoint secret: ${error.message}`
    );
  }
}

export function inspectRetiredTransportDependencies(loader = require) {
  if (typeof loader.resolve !== "function") {
    return skip("retired-transport", "dependency resolver unavailable in this environment");
  }
  const forbidden = [
    ["react", "native", "web", "rtc"].join("-"),
    ["node", "datachannel"].join("-"),
  ];
  const installed = forbidden.filter((name) => {
    try {
      loader.resolve(name);
      return true;
    } catch {
      return false;
    }
  });
  const retiredEnvironment = Object.keys(process.env).filter((name) =>
    name.startsWith(["VIBESTUDIO", "WEB", "RTC"].join("_"))
  );
  return check(
    installed.length === 0 && retiredEnvironment.length === 0,
    "retired-transport",
    "retired native dependencies and environment are absent",
    `retired transport remains installed or configured: ${[
      ...installed,
      ...retiredEnvironment,
    ].join(", ")}`
  );
}

function validateRelays(relays) {
  if (!Array.isArray(relays) || relays.length < 1 || relays.length > 8) return false;
  return relays.every((relay) => {
    try {
      const url = new URL(relay);
      return (
        url.protocol === "https:" && url.toString() === relay && !url.username && !url.password
      );
    } catch {
      return false;
    }
  });
}

async function probePairedReach(credential, loader = require) {
  if (!credential) return skip("iroh-probe", "no paired Iroh credential on this host");
  const reach = credential.controlPairing;
  if (!reach || !validateRelays(reach.relays) || !/^[0-9a-f]{64}$/.test(reach.endpointId ?? "")) {
    return check(false, "iroh-probe", "", "paired control reach is malformed");
  }
  if (typeof credential.endpointSecret !== "string") {
    return check(false, "iroh-probe", "", "paired endpoint secret is missing");
  }
  const binding = loadBinding(loader);
  let endpoint;
  try {
    const secret = Buffer.from(credential.endpointSecret, "base64url");
    if (secret.byteLength !== 32) throw new Error("paired endpoint secret is malformed");
    const builder = binding.Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey([...secret]);
    builder.alpns([ALPN]);
    builder.relayMode(binding.RelayMode.customFromUrls(reach.relays));
    endpoint = await builder.bind();
    let timer;
    const probe = async () => {
      let lastError;
      for (const relay of reach.relays) {
        try {
          const address = new binding.EndpointAddr(
            binding.EndpointId.fromString(reach.endpointId),
            relay,
            []
          );
          const connection = await endpoint.connect(address, ALPN);
          const path = connection.paths().find((candidate) => candidate.isSelected);
          connection.close(0n, []);
          return check(
            true,
            "iroh-probe",
            `ALPN accepted; ${path?.isRelay ? "relayed" : "direct"} path`,
            "",
            { relay, path: path?.remoteAddr ?? null }
          );
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error("no relay attempt completed");
    };
    return await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          void endpoint.close().catch(() => undefined);
          reject(new Error(`probe exceeded ${PROBE_TIMEOUT_MS}ms overall deadline`));
        }, PROBE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    return check(false, "iroh-probe", "", `Iroh probe failed: ${error.message}`);
  } finally {
    await endpoint?.close().catch(() => undefined);
  }
}

function unitFilePath() {
  return path.join(os.homedir(), ".config", "systemd", "user", UNIT_NAME);
}

export async function runDoctor(options, deps = {}) {
  const checks = [];
  try {
    loadBinding(deps.require ?? require);
    checks.push(check(true, "native-binding", "@number0/iroh 1.1.0 native binding loads", ""));
  } catch (error) {
    checks.push(check(false, "native-binding", "", `Iroh native binding failed: ${error.message}`));
  }
  const unitPath = deps.unitPath ?? unitFilePath();
  const serverHost = fs.existsSync(unitPath);
  checks.push(
    serverHost
      ? check(true, "systemd-unit", `${UNIT_NAME} is installed`, "")
      : skip("systemd-unit", "no deployed unit on this host")
  );
  checks.push(
    serverHost || options.identityExplicit
      ? inspectIdentity(options.identity, deps.require ?? require)
      : skip("endpoint-identity", "no server endpoint secret expected on this client host")
  );
  const credential = deps.credential ?? loadPairedCredential(deps.credentialFile);
  checks.push(inspectCredentialEndpoint(credential, deps.require ?? require));
  const relays =
    options.relayUrls.length > 0
      ? options.relayUrls
      : (credential?.controlPairing?.relays ??
        process.env.VIBESTUDIO_IROH_RELAYS?.split(",") ??
        []);
  checks.push(
    check(
      validateRelays(relays),
      "relay-config",
      `${relays.length} explicit HTTPS relay(s); n0 preset disabled`,
      "no canonical explicit Iroh relay set is configured"
    )
  );
  checks.push(await probePairedReach(credential, deps.require ?? require));
  checks.push(inspectRetiredTransportDependencies(deps.require ?? require));
  return { ok: checks.filter((entry) => !entry.skipped).every((entry) => entry.ok), checks };
}

function printHelp() {
  console.log(`vibestudio remote doctor

Usage: vibestudio remote doctor [--workspace <name> | --identity <endpoint.key>]
                                [--relay-url <https-url>...] [--json]

Checks the pinned Iroh native binding, durable endpoint identities and permissions,
explicit relay set with n0 presets disabled, retired dependency absence, and one
bounded peer-authenticated ALPN/path probe when this host has a paired credential.`);
}

function render(result) {
  console.log("\nVibestudio remote doctor");
  for (const entry of result.checks)
    console.log(`  ${entry.skipped ? "○" : entry.ok ? "✓" : "✗"} ${entry.name}: ${entry.message}`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const result = await runDoctor(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else render(result);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[remote-doctor] ${error.message}`);
      process.exit(1);
    });
}
