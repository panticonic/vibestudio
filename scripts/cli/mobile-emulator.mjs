#!/usr/bin/env node
import { spawn } from "child_process";

function parseArgs(argv) {
  const options = {
    avd: process.env.VIBESTUDIO_ANDROID_AVD ?? "Vibestudio_Test",
    help: false,
    emulatorArgs: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--avd") {
      options.avd = argv[++i] ?? options.avd;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      options.emulatorArgs.push(arg);
    }
  }

  return options;
}

function printHelp() {
  console.log(`vibestudio mobile emulator

Usage:
  vibestudio mobile emulator
  vibestudio mobile emulator --avd <name>
  vibestudio mobile emulator -- <extra emulator args>

Defaults:
  AVD: Vibestudio_Test

Set VIBESTUDIO_ANDROID_AVD=<name> to change the default.
`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const command = process.env.ANDROID_EMULATOR ?? "emulator";
const args = [
  "-avd",
  options.avd,
  "-no-snapshot",
  "-no-audio",
  "-no-boot-anim",
  ...options.emulatorArgs,
];

console.log(`[mobile-emulator] Launching windowed AVD: ${options.avd}`);
console.log(`[mobile-emulator] ${command} ${args.join(" ")}`);

const child = spawn(command, args, {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error(`[mobile-emulator] Failed to launch emulator: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
