import fsp from "fs/promises";
import path from "path";
import process from "process";
import net from "net";
import { fileURLToPath } from "url";
import { ownedEntry } from "../lib/owned-entry.mjs";
import { createPnpmInvocation } from "./lib/package-manager.mjs";
import { parseHubReadyPayload, rootBootstrapPairingInvite } from "./lib/hub-ready.mjs";
import { INTERNAL_ANDROID_PACKAGE } from "./lib/mobile-native-android.mjs";
import { waitForAndroidBoot } from "./lib/android-avd.mjs";
import { flagValue } from "./lib/args.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mobileInstallScript = path.join(repoRoot, "scripts", "cli", "mobile-install.mjs");
const developmentTemplateResolver = path.join(
  repoRoot,
  "scripts",
  "resolve-development-templates.ts"
);
const runInstanceEntry = path.join(repoRoot, "src", "dev", "runInstance.ts");
const mobileDir = path.join(repoRoot, "hosts", "react-native");
const appPackage = INTERNAL_ANDROID_PACKAGE;
const appActivity = `${appPackage}/app.vibestudio.mobile.MainActivity`;
const metroPort = 8081;

export function mobileDevServerArgs({ instanceId, templateCheckoutRoot, readyFilePath }) {
  return [
    "--import",
    "tsx",
    runInstanceEntry,
    "server",
    "--instance",
    instanceId,
    "--template-checkouts",
    templateCheckoutRoot,
    "--ready-file",
    readyFilePath,
    "--ephemeral",
    // The instance ends with this launcher: its lease is the supervisor's cue.
    "--lifetime",
    "leased",
  ];
}

export function mobileDevMetroEnvironment(env = process.env) {
  // Metro bundles only the shipped host; clients are built by the server.
  return { ...env, REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1" };
}

export function mobileDevInstallArgs({ platform, device, noLaunch }) {
  return [
    mobileInstallScript,
    "--platform",
    platform,
    ...(platform === "android" ? ["--from-source"] : ["--simulator", "--configuration", "Debug"]),
    ...(device ? ["--device", device] : []),
    ...(!noLaunch && platform === "ios" ? ["--launch"] : []),
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function parseArgs(argv) {
  const options = {
    platform: "android",
    avd: null,
    device: null,
    resetApp: false,
    noMetro: false,
    noInstall: false,
    noLaunch: false,
    templateCheckouts: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      throw new Error("Forwarding raw server flags is no longer supported");
    } else if (arg === "--platform") {
      options.platform = flagValue(argv, ++i, arg);
    } else if (arg === "--avd") {
      options.avd = flagValue(argv, ++i, arg);
    } else if (arg === "--device") {
      options.device = flagValue(argv, ++i, arg);
    } else if (arg === "--reset-app") {
      options.resetApp = true;
    } else if (arg === "--no-metro") {
      options.noMetro = true;
    } else if (arg === "--no-install") {
      options.noInstall = true;
    } else if (arg === "--no-launch") {
      options.noLaunch = true;
    } else if (arg === "--template-checkouts") {
      options.templateCheckouts = flagValue(argv, ++i, arg);
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
  console.log(`vibestudio mobile dev

Usage:
  vibestudio mobile dev [--platform android|ios] [options]

Runner options:
  --platform <name> android or ios. Defaults to android.
  --avd <name>      Start this AVD if no device is connected
  --device <id>     Use an Android serial or iOS simulator UDID
  --reset-app       Clear app data before launch
  --no-metro        Do not start Metro
  --no-install      Do not build/install the Android app
  --no-launch       Do not launch the Android app after setup
  --template-checkouts <dir>
                     Use the complete registry-defined local template set
  --help            Show this help message
`);
}

function prefixAndWrite(prefix, text, stream) {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    stream.write(`[${prefix}] ${line}\n`);
  }
}

function pipeChildOutput(child, prefix) {
  child.stdout?.on("data", (chunk) => {
    prefixAndWrite(prefix, chunk.toString(), process.stdout);
  });
  child.stderr?.on("data", (chunk) => {
    prefixAndWrite(prefix, chunk.toString(), process.stderr);
  });
}

/** A long-running child of this launcher's ownership, retired with it. A
 * failure to start surfaces from `owned.registered`. */
function spawnManaged(ownership, command, args, options = {}) {
  const { label, kill = "graceful", ...spawnOptions } = options;
  const owned = ownership.spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    // pnpm is pnpm.cmd on Windows, which Node only starts through a shell.
    ...(process.platform === "win32" ? { shell: true } : {}),
    ...spawnOptions,
    kill,
    label: label ?? command,
  });
  pipeChildOutput(owned.child, label ?? command);
  return owned;
}

/** Resolves when `owned`'s leader exits, with its status. */
function exitOf(owned) {
  const child = owned.child;
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/** Resolves once `port` accepts connections. The leader's exit before that, or
 * a stop request, ends the wait: those are the terminal events, not a clock. */
async function waitForPort(port, owned, signal, label) {
  while (!(await isPortOpen("127.0.0.1", port))) {
    signal.throwIfAborted();
    const { exitCode, signalCode } = owned.child;
    if (exitCode !== null || signalCode !== null) {
      throw new Error(`${label} exited (${signalCode ?? exitCode}) before listening on ${port}`);
    }
    await sleep(250);
  }
}

/** One-shot command, a member of this launcher's ownership. */
async function runCommand(ownership, command, args, options = {}) {
  const { label, ...spawnOptions } = options;
  const owned = ownership.spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...(process.platform === "win32" ? { shell: true } : {}),
    ...spawnOptions,
    kill: "immediate",
    label: label ?? command,
  });
  const child = owned.child;
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    if (label) prefixAndWrite(label, text, process.stdout);
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    if (label) prefixAndWrite(label, text, process.stderr);
  });
  const { code } = await exitOf(owned);
  await owned.join();
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`);
  }
  return { stdout, stderr };
}

/** Observe the server's ready-file handoff. The server's exit or a stop
 * request is the terminal event; there is no deadline. */
async function waitForServerReady(readyFile, owned, signal) {
  for (;;) {
    signal.throwIfAborted();
    const { exitCode, signalCode } = owned.child;
    if (exitCode !== null || signalCode !== null) {
      throw new Error(`Server exited before readiness (${signalCode ?? exitCode})`);
    }
    try {
      const content = await fsp.readFile(readyFile, "utf8");
      let value;
      try {
        value = JSON.parse(content);
      } catch (error) {
        if (error instanceof SyntaxError) {
          await sleep(250);
          continue;
        }
        throw error;
      }
      const ready = parseHubReadyPayload(value);
      if (!ready.rootInvite || rootBootstrapPairingInvite(ready.rootInvite)) return ready;
      await sleep(250);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await sleep(250);
    }
  }
}

function makeAdbArgs(device, args) {
  return device ? ["-s", device, ...args] : args;
}

async function adb(ownership, device, ...args) {
  return runCommand(ownership, "adb", makeAdbArgs(device, args), { label: "adb" });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellCommand(args) {
  return args.map(shellQuote).join(" ");
}

async function startConnectIntent(ownership, device, link) {
  const packageResult = await adb(
    ownership,
    device,
    "shell",
    shellCommand([
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      link,
      "-p",
      appPackage,
    ])
  ).catch((error) => error);
  if (!(packageResult instanceof Error)) return;

  await adb(
    ownership,
    device,
    "shell",
    shellCommand([
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      link,
      "-n",
      appActivity,
    ])
  );
}

async function hasAdbDevice(ownership, device) {
  try {
    await adb(ownership, device, "get-state");
    return true;
  } catch {
    return false;
  }
}

async function main({ signal, ownership, scratchRoot }, options) {
  const resolvedTemplates = await runCommand(
    ownership,
    process.execPath,
    [
      "--import",
      "tsx",
      developmentTemplateResolver,
      "--source-only",
      ...(options.templateCheckouts ? ["--root", options.templateCheckouts] : []),
    ],
    { cwd: repoRoot }
  );
  const selectedTemplates = JSON.parse(resolvedTemplates.stdout.trim());
  if (!selectedTemplates?.root || !selectedTemplates?.checkouts?.system) {
    throw new Error(
      "mobile dev requires development template checkouts. Configure them with `pnpm dev:templates setup` or pass --template-checkouts <dir>."
    );
  }
  if (
    !(await fsp
      .stat(mobileDir)
      .then((stat) => stat.isDirectory())
      .catch(() => false))
  ) {
    throw new Error("mobile dev requires a complete Host source checkout");
  }
  // Every child below is a member of this launcher's ownership: a stop request
  // ends the wait, and releasing the ownership retires them in order.
  const stopped = new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", resolve, { once: true });
  });
  const startMetro = async () => {
    const pnpmStart = createPnpmInvocation(["start"]);
    const metro = spawnManaged(ownership, pnpmStart.command, pnpmStart.args, {
      cwd: mobileDir,
      env: mobileDevMetroEnvironment(),
      label: "metro",
    });
    await metro.registered;
    await waitForPort(metroPort, metro, signal, "metro");
    return metro;
  };

  if (options.platform === "ios") {
    if (process.platform !== "darwin") {
      throw new Error(
        "iOS dev requires macOS with Xcode. Run `vibestudio mobile doctor` on a Mac."
      );
    }
    if (!options.noMetro && !(await isPortOpen("127.0.0.1", metroPort))) await startMetro();
    if (!options.noInstall) {
      await runCommand(
        ownership,
        process.execPath,
        mobileDevInstallArgs({
          platform: "ios",
          device: options.device,
          noLaunch: options.noLaunch,
        }),
        { cwd: repoRoot, env: process.env, label: "mobile-install-ios" }
      );
    }
    console.log("[mobile-dev] iOS shell is running. Start pairing with: vibestudio mobile pair");
    await stopped;
    return;
  }

  if (!(await hasAdbDevice(ownership, options.device))) {
    if (!options.avd) {
      throw new Error("No Android device/emulator detected. Start one first or pass --avd <name>.");
    }
    spawnManaged(
      ownership,
      process.env.ANDROID_EMULATOR ?? "emulator",
      ["-avd", options.avd, "-no-snapshot", "-no-audio", "-no-boot-anim", "-no-window"],
      { label: "emulator" }
    );
  }

  await waitForAndroidBoot(options.device);

  let metro = null;
  if (!options.noMetro) {
    if (await isPortOpen("127.0.0.1", metroPort)) {
      console.log(`[mobile-dev] Reusing Metro on port ${metroPort}`);
    } else {
      metro = await startMetro();
    }
  }

  // The server publishes one complete root invitation fact through its strict
  // ready-file handoff. Mobile consumes its deep-link presentation directly.
  const readyFilePath = path.join(scratchRoot, "server-ready.json");
  const instanceId = `mobile-dev-${process.pid}`;
  const serverArgs = mobileDevServerArgs({
    instanceId,
    templateCheckoutRoot: selectedTemplates.root,
    readyFilePath,
  });
  const server = spawnManaged(ownership, process.execPath, serverArgs, {
    cwd: repoRoot,
    env: process.env,
    label: "server",
    lease: true,
  });
  await server.registered;
  const ready = await waitForServerReady(readyFilePath, server, signal);
  const invite = rootBootstrapPairingInvite(ready.rootInvite);
  if (!invite) {
    throw new Error("Fresh isolated hub did not publish a root invite");
  }
  const connectLink = invite.deepLink;
  const workspace = ready.workspaces.find((entry) => entry.ephemeral) ?? ready.workspaces[0];
  if (!workspace) throw new Error("Hub ready file did not include a workspace");

  await adb(ownership, options.device, "reverse", `tcp:${metroPort}`, `tcp:${metroPort}`);

  if (!options.noInstall) {
    await runCommand(
      ownership,
      process.execPath,
      mobileDevInstallArgs({
        platform: "android",
        device: options.device,
        noLaunch: true,
      }),
      {
        cwd: repoRoot,
        env: process.env,
        label: "mobile-install-android",
      }
    );
  }

  if (options.resetApp) {
    await adb(ownership, options.device, "shell", "pm", "clear", appPackage);
  }

  if (!options.noLaunch) {
    await adb(ownership, options.device, "shell", "am", "force-stop", appPackage).catch(() => null);
    await startConnectIntent(ownership, options.device, connectLink);
  }

  console.log(`[mobile-dev] Ready`);
  console.log(
    `[mobile-dev] Workspace: ${ready.workspaceName}${ready.isEphemeral ? " (ephemeral)" : ""}`
  );
  console.log(`[mobile-dev] Transport: Iroh (public relay defaults)`);
  console.log(`[mobile-dev] Device:    ${options.device ?? "default adb device"}`);

  // Run until asked to stop; a server or Metro that exits first is the failure.
  const ended = async (owned, name) => {
    const { code, signal: exitSignal } = await exitOf(owned);
    throw new Error(`${name} exited (${exitSignal ?? code})`);
  };
  await Promise.race([stopped, ended(server, "Server"), ...(metro ? [ended(metro, "Metro")] : [])]);
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return Promise.resolve();
  }
  return ownedEntry((context) => main(context, options), { scratchPrefix: "mobile-dev-" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(`[mobile-dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
