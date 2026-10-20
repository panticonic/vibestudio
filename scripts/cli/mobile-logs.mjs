#!/usr/bin/env node
// Tail adb logcat for the Vibestudio Android app process.

import { spawn } from "node:child_process";
import { ownedEntry, retireOnAbort } from "../lib/owned-entry.mjs";
import { bootedIosSimulator } from "./lib/mobile-ios.mjs";
import { flagValue } from "./lib/args.mjs";

function parseArgs(argv) {
  const options = {
    platform: "android",
    device: null,
    packageName: "app.vibestudio.mobile.internal",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--platform") {
      options.platform = flagValue(argv, ++i, arg);
    } else if (arg === "--device") {
      options.device = flagValue(argv, ++i, arg);
    } else if (arg === "--package") {
      options.packageName = flagValue(argv, ++i, arg);
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.platform !== "android" && options.platform !== "ios") {
    throw new Error("--platform must be android or ios");
  }
  return options;
}

function printHelp() {
  console.log(`vibestudio mobile logs

Usage:
  vibestudio mobile logs [--platform android]
  vibestudio mobile logs --platform ios [--device <simulator-udid>]
  vibestudio mobile logs --device <adb-serial>

Options:
  --platform <name>  android or ios. Defaults to android.
  --device <id>      Target a specific adb device or booted iOS simulator.
  --package <id>     App package to inspect. Defaults to app.vibestudio.mobile.internal.
  --help             Show this help message.
`);
}

function adbArgs(device, args) {
  return device ? ["-s", device, ...args] : args;
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`)
        );
    });
  });
}

async function streamOwned(ownership, ownerSignal, command, args) {
  // The stream belongs to this script's ownership: a stop request, or the
  // script's own death, retires it.
  const owned = ownership.spawn(command, args, {
    kill: "immediate",
    label: command,
    stdio: "inherit",
  });
  const { child } = owned;
  if (!child.pid) {
    await owned.registered.catch(() => undefined);
    throw new Error(`Could not start ${command}`);
  }
  retireOnAbort(ownership, ownerSignal, owned);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await owned.join();
  const stop =
    ownerSignal.aborted && ownerSignal.reason?.code === "ESTOP" ? ownerSignal.reason : null;
  return { code: exit.code, signal: stop?.signal ?? exit.signal };
}

function finishStream(result) {
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 0;
}

async function main({ signal, ownership }) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.platform === "ios") {
    if (process.platform !== "darwin") {
      throw new Error("iOS logs require macOS. Use Console.app for hardware-device logs.");
    }
    const devices = await runCapture("xcrun", ["simctl", "list", "devices", "available", "--json"]);
    const simulatorId = bootedIosSimulator(devices.stdout, options.device);
    console.log(
      `[mobile-logs] Streaming Vibestudio logs from simulator ${simulatorId}. Press Ctrl-C to stop.`
    );
    signal.throwIfAborted();
    return await streamOwned(ownership, signal, "xcrun", [
      "simctl",
      "spawn",
      simulatorId,
      "log",
      "stream",
      "--style",
      "compact",
      "--predicate",
      'process == "Vibestudio"',
    ]);
  }

  const pidResult = await runCapture(
    "adb",
    adbArgs(options.device, ["shell", "pidof", options.packageName])
  );
  const pid = pidResult.stdout.trim().split(/\s+/)[0];
  if (!pid) {
    throw new Error(
      `Could not find a running process for ${options.packageName}. Launch the app first.`
    );
  }

  console.log(`[mobile-logs] Tailing ${options.packageName} pid ${pid}. Press Ctrl-C to stop.`);
  signal.throwIfAborted();
  return await streamOwned(
    ownership,
    signal,
    "adb",
    adbArgs(options.device, ["logcat", "--pid", pid, "-v", "time"])
  );
}

try {
  // Released before the stream's status is reported: a stop request ends this
  // process by the signal that asked for it.
  const result = await ownedEntry(main);
  if (result) finishStream(result);
} catch (error) {
  console.error(`[mobile-logs] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
