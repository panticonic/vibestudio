#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { workspaceIdentityPath } from "./lib/config-paths.mjs";

export function parseArgs(argv) {
  const options = { identity: null, workspace: null, yes: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") options.workspace = argv[++index] ?? "";
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.workspace !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(options.workspace)) {
    throw new Error("--workspace must contain only letters, numbers, hyphens, and underscores");
  }
  if (!options.help && !options.workspace) {
    throw new Error(
      "--workspace is required; hub endpoint rotation must use a planned trust reset"
    );
  }
  if (options.workspace) options.identity = workspaceIdentityPath(options.workspace);
  return options;
}

function printHelp() {
  console.log(`vibestudio remote rotate-endpoint

Usage: vibestudio remote rotate-endpoint --workspace <name> --yes

Atomically replaces one workspace's durable 32-byte Iroh endpoint secret and
keeps a timestamped backup. Existing devices remain paired with hub control but
must request a fresh reach for this workspace. Hub endpoint rotation is excluded
because it is a deliberate device-trust reset, not a repair operation.`);
}

function acquireLock(identity, fileSystem = fs) {
  const filename = `${identity}.rotate.lock`;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(filename, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    if (error?.code === "EEXIST")
      throw new Error(`endpoint rotation already in progress: ${filename}`);
    fileSystem.rmSync(filename, { force: true });
    throw error;
  }
  fileSystem.closeSync(descriptor);
  return () => fileSystem.rmSync(filename, { force: true });
}

export function rotationImpact(options) {
  return `workspace ${options.workspace} endpoint replaced; clients must request a fresh workspace reach`;
}

export function rotateEndpoint(options, deps = {}) {
  const fileSystem = deps.fs ?? fs;
  const entropy = deps.randomBytes ?? randomBytes;
  const uniqueId = deps.randomUUID?.() ?? randomUUID();
  const identity = path.resolve(options.identity);
  fileSystem.mkdirSync(path.dirname(identity), { recursive: true });
  const release = acquireLock(identity, fileSystem);
  const temporary = `${identity}.tmp-${process.pid}-${uniqueId}`;
  let backup = null;
  try {
    const secret = entropy(32);
    if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
      throw new Error("endpoint entropy source did not return 32 bytes");
    }
    fileSystem.writeFileSync(temporary, secret, { mode: 0o600, flag: "wx" });
    const descriptor = fileSystem.openSync(temporary, "r");
    try {
      fileSystem.fsyncSync(descriptor);
    } finally {
      fileSystem.closeSync(descriptor);
    }
    if (fileSystem.existsSync(identity)) {
      backup = `${identity}.bak-${Date.now()}-${uniqueId}`;
      fileSystem.renameSync(identity, backup);
    }
    try {
      fileSystem.renameSync(temporary, identity);
    } catch (error) {
      if (backup && !fileSystem.existsSync(identity)) fileSystem.renameSync(backup, identity);
      throw error;
    }
    fileSystem.chmodSync(identity, 0o600);
    const directory = fileSystem.openSync(path.dirname(identity), "r");
    try {
      fileSystem.fsyncSync(directory);
    } finally {
      fileSystem.closeSync(directory);
    }
    return { identity, backup, impact: rotationImpact(options) };
  } finally {
    fileSystem.rmSync(temporary, { force: true });
    release();
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (!options.yes)
    throw new Error(`refusing endpoint rotation without --yes; ${rotationImpact(options)}`);
  const result = rotateEndpoint(options);
  console.log(`[remote-rotate-endpoint] wrote ${result.identity}`);
  if (result.backup) console.log(`[remote-rotate-endpoint] backup ${result.backup}`);
  console.log(`[remote-rotate-endpoint] ${result.impact}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[remote-rotate-endpoint] ${error.message}`);
    process.exit(1);
  }
}
