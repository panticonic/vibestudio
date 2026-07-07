#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function defaultIdentityPath() {
  const configRoot = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "vibestudio")
    : path.join(os.homedir(), ".config", "vibestudio");
  return path.join(configRoot, "webrtc", "identity.pem");
}

function parseArgs(argv) {
  const options = { identity: process.env.VIBESTUDIO_WEBRTC_IDENTITY ?? defaultIdentityPath(), yes: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--identity") options.identity = path.resolve(argv[++i] ?? "");
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`vibestudio remote repair-identity

Usage:
  vibestudio remote repair-identity --yes [--identity <identity.pem>]

Backs up any existing identity.pem and deleted server.pem/server.key remnants,
then writes a fresh combined certificate/private-key identity file.
`);
}

function backupIfExists(file) {
  if (!fs.existsSync(file)) return null;
  const backup = `${file}.bak-${Date.now()}`;
  fs.renameSync(file, backup);
  return backup;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  if (!options.yes) {
    throw new Error("refusing to replace identity material without --yes; every paired device must re-pair afterwards");
  }
  const identity = path.resolve(options.identity);
  fs.mkdirSync(path.dirname(identity), { recursive: true });
  const backups = [backupIfExists(identity)];
  for (const legacy of ["server.pem", "server.key"]) {
    backups.push(backupIfExists(path.join(path.dirname(identity), legacy)));
  }
  const cert = `${identity}.cert.tmp`;
  const key = `${identity}.key.tmp`;
  const result = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "3650",
    "-subj",
    "/CN=Vibestudio WebRTC",
    "-keyout",
    key,
    "-out",
    cert,
  ], { stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`openssl failed: ${result.stderr.toString() || result.stdout.toString()}`);
  }
  const combined = `${fs.readFileSync(cert, "utf8")}\n${fs.readFileSync(key, "utf8")}`;
  fs.writeFileSync(identity, combined, { mode: 0o600 });
  fs.rmSync(cert, { force: true });
  fs.rmSync(key, { force: true });
  console.log(`[remote-repair-identity] wrote ${identity}`);
  for (const backup of backups.filter(Boolean)) {
    console.log(`[remote-repair-identity] backup ${backup}`);
  }
  console.log("[remote-repair-identity] all existing devices must re-pair");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`[remote-repair-identity] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
