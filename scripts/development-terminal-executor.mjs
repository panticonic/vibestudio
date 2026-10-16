#!/usr/bin/env node
/**
 * Attach a terminal device driver to a running Vibestudio instance.
 *
 * The client system tests reach a person's device through the `deviceDriver`
 * service. This is the terminal side: the real `vibestudio` CLI, run in PTYs
 * under a HOME and XDG directories of its own (a test-owned bin directory on
 * PATH), paired as a device of the instance's account before any scenario
 * client exists. The sibling of `development-client-executor.mjs`, which
 * attaches the desktop device.
 *
 * Runs until stopped, then retires its PTYs, connections and private root.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { tsImport } from "tsx/esm/api";
import { mintDevicePairingLink } from "./lib/device-pairing-link.mjs";
import { runParentOwnedMain } from "./lib/parent-owned-main.mjs";

const { createDevelopmentClientLifetime } = await tsImport("./development-client-lifecycle.ts", import.meta.url);

const repoRoot = process.cwd();

function parseArguments(argv) {
  let instanceId;
  let ttlMs = 3_600_000;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--instance") instanceId = argv[(index += 1)];
    else if (arg === "--ttl-ms") ttlMs = Number(argv[(index += 1)]);
    else if (arg === "-h" || arg === "--help") return { help: true };
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!instanceId) throw new Error("usage: development-terminal-executor.mjs --instance ID");
  return { instanceId, ttlMs };
}

async function main(ownerSignal) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log(`Attach a terminal device driver to a running instance.

Usage:
  node scripts/development-terminal-executor.mjs --instance ID [--ttl-ms MS]

Pairs a private CLI profile to the instance account and serves the terminal
device operations to its system tests. Runs until stopped.`);
    return;
  }
  ownerSignal.throwIfAborted();
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-terminal-executor-"));
  const lifetime = createDevelopmentClientLifetime(tempRoot);
  const stop = new AbortController();
  const requestStop = () => {
    stop.abort();
    lifetime.requestStop();
  };
  ownerSignal.addEventListener("abort", requestStop, { once: true });
  if (ownerSignal.aborted) requestStop();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    // Two devices of the account: the one under test, and the driver's own
    // connection (a CLI profile admits one process per endpoint at a time).
    const links = {
      device: await mintDevicePairingLink(repoRoot, parsed.instanceId, parsed.ttlMs, lifetime.acquire),
      driver: await mintDevicePairingLink(repoRoot, parsed.instanceId, parsed.ttlMs, lifetime.acquire),
    };
    console.log(`[terminal-executor] minted device invites on ${parsed.instanceId}`);
    // The CLI's credential and path modules bind their stores when first
    // imported, so the device's own environment has to be in place first.
    const { terminalDeviceLayout } = await tsImport("../src/dev/terminalDevice/layout.ts", import.meta.url);
    const layout = terminalDeviceLayout(tempRoot, repoRoot, process.env, "driver");
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, layout.env);
    const { runTerminalDevice } = await tsImport("../src/dev/terminalDevice/run.ts", import.meta.url);
    await runTerminalDevice({
      root: tempRoot,
      repoRoot,
      links,
      signal: stop.signal,
      log: (line) => console.log(`[terminal-executor] ${line}`),
    });
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    ownerSignal.removeEventListener("abort", requestStop);
    await lifetime.close();
  }
}

await runParentOwnedMain(main, repoRoot);
