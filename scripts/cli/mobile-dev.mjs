import fsp from "fs/promises";
import os from "os";
import path from "path";
import process from "process";
import net from "net";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { createPnpmInvocation } from "./lib/package-manager.mjs";
import { createServerInvocation, serverEntryArg } from "./lib/server-entry.mjs";
import { parseHubReadyPayload } from "./lib/hub-ready.mjs";
import {
  requiresLocalTurn,
  relayOnlyServerEnv,
  signalingTurnVars,
  startLocalTurnRelay,
} from "./lib/local-turn.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
const signalingDir = path.join(repoRoot, "apps", "signaling");
const mobileDir = path.join(repoRoot, "apps", "mobile");
const androidDir = path.join(mobileDir, "android");
const appPackage = "app.vibestudio.mobile";
const appActivity = `${appPackage}/.MainActivity`;
const metroPort = 8081;
const apkPath = path.join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");

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
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      throw new Error("Forwarding raw server flags is no longer supported");
    } else if (arg === "--platform") {
      options.platform = argv[++i] ?? "android";
    } else if (arg === "--avd") {
      options.avd = argv[++i] ?? null;
    } else if (arg === "--device") {
      options.device = argv[++i] ?? null;
    } else if (arg === "--reset-app") {
      options.resetApp = true;
    } else if (arg === "--no-metro") {
      options.noMetro = true;
    } else if (arg === "--no-install") {
      options.noInstall = true;
    } else if (arg === "--no-launch") {
      options.noLaunch = true;
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
  --avd <name>      Start this AVD if no device is connected; requires coturn
                    (\`turnserver\`) and forces relay-only WebRTC through it
  --device <serial> Use a specific adb device serial
  --reset-app       Clear app data before launch
  --no-metro        Do not start Metro
  --no-install      Do not build/install the Android app
  --no-launch       Do not launch the Android app after setup
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

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  pipeChildOutput(child, options.label ?? command);
  child.once("error", (error) => {
    prefixAndWrite(
      options.label ?? command,
      `Failed to start ${command}: ${error.message}`,
      process.stderr
    );
  });
  return child;
}

function waitForSpawn(child, command, args, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onSpawn = () => finish();
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(), timeoutMs);
    child.once("spawn", onSpawn);
    child.once("error", onError);
    if (child.pid) finish();
    if (child.exitCode != null)
      finish(new Error(`${command} ${args.join(" ")} exited before startup`));
  });
}

function waitForChildExit(child, timeoutMs = 8_000) {
  if (!child || child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.label) prefixAndWrite(options.label, text, process.stdout);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.label) prefixAndWrite(options.label, text, process.stderr);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`)
        );
      }
    });
  });
}

async function waitForServerReady(readyFile, serverChild, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (serverChild.exitCode != null) {
      throw new Error(`Server exited before readiness (code ${serverChild.exitCode})`);
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
      return parseHubReadyPayload(value);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await sleep(250);
    }
  }
  throw new Error(`Timed out waiting for server ready file: ${readyFile}`);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Cloudflare's local runtime (Miniflare) hosting the real SignalingRoom DO, the
// WebRTC rendezvous — exactly as tests/webrtc-system.e2e.test.ts drives it.
async function startSignaling(port, turn = null) {
  const child = spawnManaged(
    wranglerBin,
    [
      "dev",
      "--port",
      String(port),
      "--local",
      "--var",
      "ENVIRONMENT:test",
      ...signalingTurnVars(turn),
    ],
    { cwd: signalingDir, label: "signaling" }
  );
  for (let i = 0; i < 90; i++) {
    if (child.exitCode != null) {
      throw new Error(`wrangler dev (signaling) exited before healthy (code ${child.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return child;
    } catch {
      // Not up yet.
    }
    await sleep(1_000);
  }
  throw new Error("wrangler dev (signaling) did not become healthy");
}

function makeAdbArgs(device, args) {
  return device ? ["-s", device, ...args] : args;
}

async function adb(device, ...args) {
  return runCommand("adb", makeAdbArgs(device, args), { label: "adb" });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellCommand(args) {
  return args.map(shellQuote).join(" ");
}

async function startConnectIntent(device, link) {
  const packageResult = await adb(
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

async function hasAdbDevice(device) {
  try {
    await adb(device, "get-state");
    return true;
  } catch {
    return false;
  }
}

async function waitForAndroidBoot(device, timeoutMs = 180_000) {
  await adb(device, "wait-for-device");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { stdout } = await adb(device, "shell", "getprop", "sys.boot_completed");
    if (stdout.trim() === "1") return;
    await sleep(1000);
  }
  throw new Error("Timed out waiting for Android boot completion");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.platform === "ios") {
    if (process.platform !== "darwin") {
      throw new Error(
        "iOS dev requires macOS with Xcode. Run `vibestudio mobile doctor` on a Mac."
      );
    }
    const startedChildren = [];
    try {
      if (!options.noMetro && !(await isPortOpen("127.0.0.1", metroPort))) {
        const pnpmStart = createPnpmInvocation(["start"]);
        const metroChild = spawnManaged(pnpmStart.command, pnpmStart.args, {
          cwd: mobileDir,
          env: {
            ...process.env,
            REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1",
          },
          label: "metro",
        });
        startedChildren.push(metroChild);
        await waitForSpawn(metroChild, pnpmStart.command, pnpmStart.args);
        await sleep(3000);
      }
      if (!options.noInstall) {
        await runCommand(
          process.execPath,
          [
            path.join(repoRoot, "scripts", "cli", "mobile-install.mjs"),
            "--platform",
            "ios",
            "--simulator",
            "--configuration",
            "Debug",
            ...(options.noLaunch ? [] : ["--launch"]),
          ],
          { cwd: repoRoot, env: process.env, label: "mobile-install-ios" }
        );
      }
      console.log("[mobile-dev] iOS shell is running. Start pairing with: vibestudio mobile pair");
      await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    } finally {
      for (const child of startedChildren.reverse()) {
        if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
      }
      await Promise.all(startedChildren.map((child) => waitForChildExit(child)));
    }
    return;
  }

  const startedChildren = [];
  let cleanedUp = false;
  let emulatorChild = null;
  let launchedEmulator = false;
  let tempRoot = "";
  let readyFilePath = "";
  let cleanupTurnArtifacts = null;

  const cleanup = async (exitCode = 0) => {
    if (cleanedUp) return;
    cleanedUp = true;

    for (const child of startedChildren.reverse()) {
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGTERM");
      }
    }
    if (emulatorChild && emulatorChild.exitCode == null && !emulatorChild.killed) {
      emulatorChild.kill("SIGTERM");
    }
    await Promise.all(startedChildren.map((child) => waitForChildExit(child)));
    if (emulatorChild) {
      await waitForChildExit(emulatorChild);
    }
    for (const child of startedChildren) {
      if (child.exitCode == null) child.kill("SIGKILL");
    }
    await Promise.all(startedChildren.map((child) => waitForChildExit(child, 2_000)));
    if (cleanupTurnArtifacts) await cleanupTurnArtifacts().catch(() => undefined);
    if (readyFilePath) await fsp.rm(readyFilePath, { force: true }).catch(() => undefined);
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void cleanup(0));
  process.on("SIGTERM", () => void cleanup(0));

  try {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-mobile-dev-"));
    readyFilePath = path.join(tempRoot, "hub-ready.json");
    const serverHome = path.join(tempRoot, "server-home");
    const serverConfig = path.join(tempRoot, "server-xdg-config");
    await Promise.all([
      fsp.mkdir(serverHome, { recursive: true }),
      fsp.mkdir(serverConfig, { recursive: true }),
    ]);

    if (!(await hasAdbDevice(options.device))) {
      if (!options.avd) {
        throw new Error(
          "No Android device/emulator detected. Start one first or pass --avd <name>."
        );
      }
      emulatorChild = spawnManaged(
        process.env.ANDROID_EMULATOR ?? "emulator",
        ["-avd", options.avd, "-no-snapshot", "-no-audio", "-no-boot-anim", "-no-window"],
        {
          label: "emulator",
        }
      );
      await waitForSpawn(emulatorChild, process.env.ANDROID_EMULATOR ?? "emulator", []);
      launchedEmulator = true;
    }

    await waitForAndroidBoot(options.device);

    let metroChild = null;
    if (!options.noMetro) {
      if (await isPortOpen("127.0.0.1", metroPort)) {
        console.log(`[mobile-dev] Reusing Metro on port ${metroPort}`);
      } else {
        const pnpmStart = createPnpmInvocation(["start"]);
        metroChild = spawnManaged(pnpmStart.command, pnpmStart.args, {
          cwd: mobileDir,
          env: {
            ...process.env,
            REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1",
          },
          label: "metro",
        });
        await waitForSpawn(metroChild, pnpmStart.command, pnpmStart.args);
        startedChildren.push(metroChild);
        await sleep(3000);
      }
    }

    try {
      await fsp.unlink(readyFilePath);
    } catch {}

    // Local signaling (Cloudflare local runtime) — the WebRTC rendezvous. The
    // phone reaches it over loopback via the adb-reversed signaling port.
    const signalPort = await findFreePort();
    const useTurn = requiresLocalTurn({ launchedEmulator, device: options.device });
    let turn = null;
    if (useTurn) {
      turn = await startLocalTurnRelay({ spawnManaged, waitForSpawn, sleep });
      startedChildren.push(turn.child);
      cleanupTurnArtifacts = turn.cleanupArtifacts;
      console.log(`[mobile-dev] Local TURN relay (emulator NAT): turn:${turn.host}:${turn.port}`);
      turn.child.on("exit", (code) => {
        if (!cleanedUp) {
          console.error(`[mobile-dev] Required local TURN relay exited with code ${code ?? 1}`);
          void cleanup(code && code !== 0 ? code : 1);
        }
      });
    }
    const signalingChild = await startSignaling(signalPort, turn);
    startedChildren.push(signalingChild);
    const signalUrl = `ws://127.0.0.1:${signalPort}`;

    // The server publishes the complete mobile root invite through its strict
    // ready-file handoff.
    const serverArgs = [
      serverEntryArg(),
      "--app-root",
      repoRoot,
      "--ready-file",
      readyFilePath,
      "--ephemeral",
    ];
    const serverInvocation = createServerInvocation(serverArgs);
    const serverChild = spawnManaged(serverInvocation.command, serverInvocation.args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? "development",
        VIBESTUDIO_WEBRTC_SIGNAL_URL: signalUrl,
        HOME: serverHome,
        XDG_CONFIG_HOME: serverConfig,
        APPDATA: path.join(tempRoot, "server-appdata"),
        ...relayOnlyServerEnv(turn),
      },
      label: "server",
    });
    await waitForSpawn(serverChild, serverInvocation.command, serverInvocation.args);
    startedChildren.push(serverChild);
    const ready = await waitForServerReady(readyFilePath, serverChild);
    const invite = ready.rootInvites?.mobile;
    if (!invite) {
      throw new Error("Fresh isolated hub did not publish a mobile root invite");
    }
    const connectLink = invite.deepLink;
    const workspace = ready.workspaces.find((entry) => entry.ephemeral) ?? ready.workspaces[0];
    if (!workspace) throw new Error("Hub ready file did not include a workspace");

    await adb(options.device, "reverse", `tcp:${metroPort}`, `tcp:${metroPort}`);
    await adb(options.device, "reverse", `tcp:${signalPort}`, `tcp:${signalPort}`);
    await adb(options.device, "reverse", `tcp:${ready.gatewayPort}`, `tcp:${ready.gatewayPort}`);

    if (!options.noInstall) {
      await runCommand("./gradlew", ["assembleDebug"], {
        cwd: androidDir,
        env: process.env,
        label: "gradle",
      });
      await adb(options.device, "install", "-r", "-d", apkPath);
    }

    if (options.resetApp) {
      await adb(options.device, "shell", "pm", "clear", appPackage);
    }

    if (!options.noLaunch) {
      await adb(options.device, "shell", "am", "force-stop", appPackage).catch(() => null);
      await startConnectIntent(options.device, connectLink);
    }

    console.log(`[mobile-dev] Ready`);
    console.log(
      `[mobile-dev] Workspace: ${workspace.name}${workspace.ephemeral ? " (ephemeral)" : ""}`
    );
    console.log(`[mobile-dev] Gateway:   ${ready.gatewayUrl}`);
    console.log(`[mobile-dev] Device:    ${options.device ?? "default adb device"}`);

    serverChild.on("exit", (code) => {
      if (!cleanedUp) {
        console.error(`[mobile-dev] Server exited with code ${code ?? 1}`);
        void cleanup(code ?? 1);
      }
    });
    metroChild?.on("exit", (code) => {
      if (!cleanedUp) {
        console.error(`[mobile-dev] Metro exited with code ${code ?? 1}`);
        void cleanup(code ?? 1);
      }
    });
  } catch (error) {
    console.error(`[mobile-dev] ${error instanceof Error ? error.message : String(error)}`);
    await cleanup(1);
  }
}

void main();
