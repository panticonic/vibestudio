#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { workspaceIdentityPath } from "./lib/config-paths.mjs";

export function parseArgs(argv) {
  const options = {
    identity: null,
    workspace: null,
    yes: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--workspace requires a name");
      options.workspace = value;
    } else if (arg === "--yes") options.yes = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.workspace !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(options.workspace)) {
    throw new Error("--workspace must contain only letters, numbers, hyphens, and underscores");
  }
  if (!options.help && options.workspace === null) {
    throw new Error(
      "--workspace is required; hub control identity rotation is intentionally unsupported"
    );
  }
  if (options.workspace !== null) options.identity = workspaceIdentityPath(options.workspace);
  return options;
}

function printHelp() {
  console.log(`vibestudio remote repair-identity

Usage:
  vibestudio remote repair-identity --workspace <name> --yes

Backs up one workspace child's identity.pem, then writes a fresh combined
certificate/private-key identity file. Device identity and hub control remain
valid; clients must re-route that workspace.

Hub control identity rotation is intentionally unsupported. That identity is
account/device trust, not a repairable reach cache; restore its exact backup
instead of minting a replacement certificate.
`);
}

function backupIfExists(file, fileSystem = fs, uniqueId = randomUUID()) {
  if (!fileSystem.existsSync(file)) return null;
  const backup = `${file}.bak-${Date.now()}-${uniqueId}`;
  fileSystem.renameSync(file, backup);
  return backup;
}

function acquireRepairLock(identity, fileSystem = fs) {
  const lock = `${identity}.repair.lock`;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(lock, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    if (error?.code === "EEXIST") {
      throw new Error(
        `identity repair already in progress for ${identity}; if no repair process is running, remove ${lock}`
      );
    }
    fileSystem.rmSync(lock, { force: true });
    throw error;
  }
  fileSystem.closeSync(descriptor);
  return {
    release() {
      fileSystem.rmSync(lock, { force: true });
    },
  };
}

export function repairImpact(options) {
  return `workspace ${options.workspace} identity replaced; device credentials and hub control remain valid, and clients must re-route this workspace`;
}

export function repairIdentity(options, deps = {}) {
  const spawn = deps.spawnSync ?? spawnSync;
  const fileSystem = deps.fs ?? fs;
  const uniqueId = deps.randomUUID?.() ?? randomUUID();
  const identity = path.resolve(options.identity);
  fileSystem.mkdirSync(path.dirname(identity), { recursive: true });
  const repairLock = acquireRepairLock(identity, fileSystem);
  let temporaryDirectory = null;
  try {
    temporaryDirectory = fileSystem.mkdtempSync(`${identity}.repair-`);
    const cert = path.join(temporaryDirectory, "certificate.pem");
    const key = path.join(temporaryDirectory, "private-key.pem");
    const replacement = path.join(temporaryDirectory, "identity.pem");
    const result = spawn(
      "openssl",
      [
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
      ],
      { stdio: "pipe" }
    );
    if (result.error) {
      throw new Error(
        `openssl is required on PATH to regenerate the identity: ${result.error.message}`
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `openssl failed: ${result.stderr?.toString() || result.stdout?.toString() || "unknown error"}`
      );
    }
    const combined = `${fileSystem.readFileSync(cert, "utf8")}\n${fileSystem.readFileSync(key, "utf8")}`;
    fileSystem.writeFileSync(replacement, combined, { mode: 0o600 });
    const backup = backupIfExists(identity, fileSystem, uniqueId);
    try {
      fileSystem.renameSync(replacement, identity);
    } catch (error) {
      if (backup && !fileSystem.existsSync(identity)) {
        fileSystem.renameSync(backup, identity);
      }
      throw error;
    }
    return { identity, backup, impact: repairImpact(options) };
  } finally {
    if (temporaryDirectory) {
      fileSystem.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    repairLock.release();
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (!options.yes) {
    throw new Error(
      `refusing to replace identity material without --yes; ${repairImpact(options)}`
    );
  }
  const result = repairIdentity(options);
  console.log(`[remote-repair-identity] wrote ${result.identity}`);
  if (result.backup) {
    console.log(`[remote-repair-identity] backup ${result.backup}`);
  }
  console.log(`[remote-repair-identity] ${result.impact}`);
  return 0;
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isDirectRun()) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(
      `[remote-repair-identity] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}
