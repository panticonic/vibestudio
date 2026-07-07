#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

function parseArgs(argv) {
  const options = {
    platform: "android",
    avd: process.env.VIBESTUDIO_ANDROID_AVD ?? "Vibestudio_Test",
    simulator: process.env.VIBESTUDIO_IOS_SIMULATOR ?? "iPhone 16",
    help: false,
    passthroughArgs: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.passthroughArgs.push(...argv.slice(i + 1));
      break;
    } else if (arg === "--platform") {
      options.platform = argv[++i] ?? options.platform;
    } else if (arg === "--avd") {
      options.avd = argv[++i] ?? options.avd;
    } else if (arg === "--simulator") {
      options.simulator = argv[++i] ?? options.simulator;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      options.passthroughArgs.push(arg);
    }
  }

  if (options.platform !== "android" && options.platform !== "ios") {
    throw new Error("--platform must be android or ios");
  }
  return options;
}

function printHelp() {
  console.log(`vibestudio mobile emulator

Usage:
  vibestudio mobile emulator [--platform android] [--avd <name>]
  vibestudio mobile emulator --platform ios [--simulator <name>]
  vibestudio mobile emulator -- <extra emulator args>

Defaults:
  Android AVD: Vibestudio_Test
  iOS simulator: iPhone 16

Set VIBESTUDIO_ANDROID_AVD=<name> or VIBESTUDIO_IOS_SIMULATOR=<name> to change
the defaults.
`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`));
    });
  });
}

async function launchAndroid(options) {
  const command = process.env.ANDROID_EMULATOR ?? "emulator";
  const args = [
    "-avd",
    options.avd,
    "-no-snapshot",
    "-no-audio",
    "-no-boot-anim",
    ...options.passthroughArgs,
  ];
  console.log(`[mobile-emulator] Launching windowed AVD: ${options.avd}`);
  console.log(`[mobile-emulator] ${command} ${args.join(" ")}`);
  await run(command, args);
}

async function launchIos(options) {
  if (process.platform !== "darwin") {
    throw new Error("iOS simulator requires macOS with Xcode.");
  }
  console.log(`[mobile-emulator] Booting iOS simulator: ${options.simulator}`);
  await run("xcrun", ["simctl", "boot", options.simulator]).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Unable to boot|Booted|already booted/i.test(message)) throw error;
  });
  await run("open", ["-a", "Simulator"]);
  await run("xcrun", ["simctl", "bootstatus", options.simulator, "-b"]);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else if (options.platform === "ios") {
    await launchIos(options);
  } else {
    await launchAndroid(options);
  }
} catch (error) {
  console.error(`[mobile-emulator] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
