#!/usr/bin/env node
// Tail adb logcat for the Vibestudio Android app process.

import { spawn } from "node:child_process";
import { terminateOwnedProcessTree } from "../owned-process-tree.mjs";

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
      options.platform = argv[++i] ?? "android";
    } else if (arg === "--device") {
      options.device = argv[++i] ?? null;
    } else if (arg === "--package") {
      options.packageName = argv[++i] ?? "";
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
  vibestudio mobile logs --platform ios
  vibestudio mobile logs --device <adb-serial>

Options:
  --platform <name>  android or ios. Defaults to android.
  --device <serial>  Target a specific adb device.
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

async function streamOwned(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  if (!child.pid) throw new Error(`Could not start ${command}`);

  let requestedSignal = null;
  let termination = null;
  const requestTermination = (signal) => {
    if (requestedSignal) return;
    requestedSignal = signal;
    termination = terminateOwnedProcessTree(child.pid);
    void termination.catch(() => {});
  };
  const onSigint = () => requestTermination("SIGINT");
  const onSigterm = () => requestTermination("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const retired = await (termination ?? terminateOwnedProcessTree(child.pid));
    if (!retired.gone) {
      throw new Error(retired.detail ?? `${command} process tree did not retire`);
    }
    return { code: exit.code, signal: requestedSignal ?? exit.signal };
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

function finishStream(result) {
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.platform === "ios") {
    if (process.platform !== "darwin") {
      throw new Error("iOS logs require macOS. Use Console.app for hardware-device logs.");
    }
    if (options.device) {
      throw new Error(
        "iOS hardware-device logs are not streamed by this CLI; use Console.app with the device selected."
      );
    }
    console.log("[mobile-logs] Streaming iOS simulator logs for Vibestudio. Press Ctrl-C to stop.");
    finishStream(
      await streamOwned("xcrun", [
        "simctl",
        "spawn",
        "booted",
        "log",
        "stream",
        "--style",
        "compact",
        "--predicate",
        'process == "Vibestudio"',
      ])
    );
    return;
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
  finishStream(
    await streamOwned("adb", adbArgs(options.device, ["logcat", "--pid", pid, "-v", "time"]))
  );
}

try {
  await main();
} catch (error) {
  console.error(`[mobile-logs] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
