#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    ssh: null,
    repo: "~/natstack",
    workspace: null,
    host: "tailscale",
    port: "3030",
    publicUrl: null,
    dev: false,
    remotePull: false,
    remoteInstall: false,
    remoteBuild: false,
    noMobileInstall: false,
    launchMobile: true,
    resetMobile: false,
    mobileNoBuild: false,
    device: null,
    help: false,
    pairArgs: [],
    sshArgs: [],
  };

  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (passthrough) {
      options.pairArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
    } else if (arg === "--ssh" || arg === "--server") {
      options.ssh = argv[++i] ?? "";
    } else if (arg === "--repo") {
      options.repo = argv[++i] ?? "";
    } else if (arg === "--workspace") {
      options.workspace = argv[++i] ?? "";
    } else if (arg === "--host") {
      options.host = argv[++i] ?? "";
    } else if (arg === "--port" || arg === "--gateway-port") {
      options.port = argv[++i] ?? "";
    } else if (arg === "--public-url") {
      options.publicUrl = argv[++i] ?? "";
    } else if (arg === "--dev" || arg === "--ephemeral") {
      options.dev = true;
    } else if (arg === "--remote-pull") {
      options.remotePull = true;
    } else if (arg === "--remote-install") {
      options.remoteInstall = true;
    } else if (arg === "--remote-build") {
      options.remoteBuild = true;
    } else if (arg === "--no-mobile-install") {
      options.noMobileInstall = true;
    } else if (arg === "--launch-mobile") {
      options.launchMobile = true;
    } else if (arg === "--no-launch-mobile") {
      options.launchMobile = false;
    } else if (arg === "--reset-mobile") {
      options.resetMobile = true;
    } else if (arg === "--mobile-no-build") {
      options.mobileNoBuild = true;
    } else if (arg === "--device") {
      options.device = argv[++i] ?? "";
    } else if (arg === "--ssh-arg") {
      options.sshArgs.push(argv[++i] ?? "");
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && !options.ssh) {
    throw new Error("Missing --ssh <user@host>");
  }
  if (!options.repo) {
    throw new Error("--repo must not be empty");
  }
  return options;
}

function printHelp() {
  console.log(`pair-remote

Start a NatStack pairing server over SSH, while optionally installing the
internal Android app from this laptop.

Usage:
  pnpm pair:remote --ssh home-server --repo ~/natstack --workspace my-workspace
  pnpm pair:remote --ssh user@home --repo /srv/natstack --workspace my-workspace --remote-pull --remote-build
  pnpm pair:remote --ssh home --repo ~/natstack --no-mobile-install -- --no-init

Remote server options:
  --ssh, --server <user@host>  SSH target for the home server.
  --repo <path>               NatStack checkout path on the server. Defaults to ~/natstack.
  --workspace <name>          Workspace name passed to pnpm pair.
  --host <host|lan|tailscale|vpn>
                              Host selection passed to pnpm pair. Defaults to tailscale.
  --port <port>               Gateway port passed to pnpm pair. Defaults to 3030.
  --public-url <url>          Public URL passed to pnpm pair.
  --dev, --ephemeral          Use an ephemeral server workspace.
  --remote-pull               Run git pull before starting the server.
  --remote-install            Run pnpm install before starting the server.
  --remote-build              Run pnpm build before starting the server.
  --ssh-arg <arg>             Extra ssh argument. Can be repeated.

Laptop Android options:
  --no-mobile-install         Do not build/install the internal APK locally.
  --device <adb-serial>       Pass a specific adb device to mobile install.
  --mobile-no-build           Install an existing APK without rebuilding.
  --launch-mobile             Launch the app after install. Default.
  --no-launch-mobile          Install but do not launch the app.
  --reset-mobile              Clear app data before install.

Everything after '--' is forwarded to the remote pnpm pair command.
`);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellPath(value) {
  const raw = String(value);
  if (raw === "~") return "$HOME";
  if (raw.startsWith("~/")) return `"$HOME"/${shellEscape(raw.slice(2))}`;
  return shellEscape(raw);
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    stdio: options.stdio ?? "inherit",
  });
  child.on("error", (error) => {
    console.error(`[pair-remote] Failed to start ${command}: ${error.message}`);
    process.exitCode = 1;
  });
  return child;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function buildRemoteCommand(options) {
  const commands = [`cd ${shellPath(options.repo)}`];
  if (options.remotePull) commands.push("git pull --ff-only");
  if (options.remoteInstall) commands.push("pnpm install");
  if (options.remoteBuild) commands.push("pnpm build");

  const pairArgs = ["pair", "--host", options.host, "--port", options.port];
  if (options.workspace) pairArgs.push("--workspace", options.workspace);
  if (options.publicUrl) pairArgs.push("--public-url", options.publicUrl);
  if (options.dev) pairArgs.push("--dev");
  pairArgs.push(...options.pairArgs);
  commands.push(["pnpm", ...pairArgs].map(shellEscape).join(" "));

  return commands.join(" && ");
}

function startMobileInstall(options) {
  if (options.noMobileInstall) return null;
  const args = ["mobile:install:internal"];
  if (options.device) args.push("--device", options.device);
  if (options.mobileNoBuild) args.push("--no-build");
  if (options.launchMobile) args.push("--launch");
  if (options.resetMobile) args.push("--reset-app");
  console.log(`[pair-remote] Installing internal Android app locally: pnpm ${args.join(" ")}`);
  return run("pnpm", args);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const remoteCommand = buildRemoteCommand(options);
  console.log(`[pair-remote] SSH target: ${options.ssh}`);
  console.log(`[pair-remote] Remote repo: ${options.repo}`);
  console.log(`[pair-remote] Remote command: ${remoteCommand}`);
  console.log("[pair-remote] Keep this terminal open; Ctrl-C stops the remote pairing server.");

  const mobileChild = startMobileInstall(options);
  const sshChild = run("ssh", [...options.sshArgs, options.ssh, remoteCommand]);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      sshChild.kill(sig);
      mobileChild?.kill(sig);
    });
  }

  if (mobileChild) {
    void waitForExit(mobileChild).then(({ code, signal }) => {
      if (signal) {
        console.warn(`[pair-remote] Mobile install stopped by ${signal}`);
      } else if (code !== 0) {
        console.warn(`[pair-remote] Mobile install exited with code ${code}`);
      } else {
        console.log("[pair-remote] Mobile install complete.");
      }
    });
  }

  const { code, signal } = await waitForExit(sshChild);
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
}

main().catch((error) => {
  console.error(`[pair-remote] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
