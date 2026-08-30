#!/usr/bin/env node
// End-to-end desktop pairing smoke over Iroh. Starts the normal
// `vibestudio remote serve` hub,
// consumes the protected first-desktop invite from the server ready payload, then launches
// Electron with that deep link so the desktop shell connects to the server over
// the encrypted Iroh transport (no Tailscale, signaling, or remote HTTP origin). It then
// approves the Electron host-target launch gate and verifies the hosted desktop
// shell loads, a panel works, native desktop event subscriptions respond, and
// no renderer warning/error or uncaught main-process failure was hidden behind
// a visually successful frame.
//
// The app pairs and connects IN-PROCESS — the chooser no longer relaunches — so
// the entire flow is observed through a SINGLE Electron launch handle. Cleanup is
// crash-proof: it never assumes app.process()/app.close() succeed and always
// SIGKILLs the Electron pid + child server so no orphan process survives
// a pass or a failure.
//
import fsp from "node:fs/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { createConnectDeepLink, parseConnectLink } from "./cli/lib/connect-grammar.generated.mjs";
import { parseHubReadyPayload } from "./cli/lib/hub-ready.mjs";
import {
  assertBaseCheckoutBootable,
  createRemoteServeArgs,
  resolveDevelopmentBase,
  waitForRootInvite,
} from "./cli/lib/smoke-remote-server.mjs";
import { resolveElectronExecutableForVibestudio } from "./branded-electron.mjs";
import {
  formatDesktopDiagnostics,
  unexpectedDesktopDiagnostics,
} from "./lib/desktop-smoke-diagnostics.mjs";

const electronBinary = resolveElectronExecutableForVibestudio();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainPath = path.join(repoRoot, "dist", "main.cjs");
const defaultReadyFile = path.join(
  os.tmpdir(),
  `vibestudio-desktop-smoke-ready-${process.pid}.json`
);
const screenshotDir = path.join(repoRoot, "test-results", "desktop-pairing-smoke");
const HOSTED_SHELL_APP = "@workspace-apps/shell";
const ELECTRON_EVALUATE_TIMEOUT_MS = 5_000;
// Capture the profile cache before the smoke replaces HOME/XDG_CONFIG_HOME.
// Mutable server/app state remains isolated; only receipt-validated,
// content-addressed derived artifacts are shared between independent instances.
const sharedDerivedCacheDir = getSharedDerivedDataPath();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateElectron(app, pageFunction, arg, label, timeoutMs = ELECTRON_EVALUATE_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Electron evaluation timed out while ${label}`)),
      timeoutMs
    );
  });
  return Promise.race([app.evaluate(pageFunction, arg), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function parseArgs(argv) {
  const options = {
    timeoutMs: 420_000,
    launchTimeoutMs: 180_000,
    readyFile: defaultReadyFile,
    productionBase: false,
    baseCheckout: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(argv[++i], "--timeout-ms");
    } else if (arg === "--launch-timeout-ms") {
      options.launchTimeoutMs = parsePositiveInt(argv[++i], "--launch-timeout-ms");
    } else if (arg === "--ready-file") {
      options.readyFile = path.resolve(argv[++i] ?? "");
    } else if (arg === "--base-checkout") {
      options.baseCheckout = path.resolve(argv[++i] ?? "");
    } else if (arg === "--production-base") {
      options.productionBase = true;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`vibestudio desktop pairing smoke

Usage:
  node scripts/desktop-pairing-smoke.mjs [options]

Runner options:
  --timeout-ms <ms>         Time to wait for server readiness. Defaults to 420000.
  --launch-timeout-ms <ms>  Time to wait for Electron launch and shell load.
                            Defaults to 180000.
  --ready-file <path>       Server ready-file path. Defaults to an OS temp path.
  --base-checkout <dir>     Use this Base checkout for this run only.
  --production-base        Use the canonical pinned production Base instead of
                            the selected development checkout.
  --help                    Show this help message.

The smoke consumes the hub's one-time root desktop invite and connects through
the exact public-relay-default Iroh path used by production.
`);
}

function prefixAndWrite(prefix, text, stream) {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    stream.write(`[${prefix}] ${line}\n`);
  }
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: [options.pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) =>
    prefixAndWrite(options.label ?? command, chunk.toString(), process.stdout)
  );
  child.stderr?.on("data", (chunk) =>
    prefixAndWrite(options.label ?? command, chunk.toString(), process.stderr)
  );
  child.once("error", (error) => {
    prefixAndWrite(
      options.label ?? command,
      `Failed to start ${command}: ${error.message}`,
      process.stderr
    );
  });
  return child;
}

async function startEphemeralLinuxSecretService(tempRoot, children) {
  if (process.platform !== "linux") return { env: {}, electronArgs: [] };

  const home = path.join(tempRoot, "home");
  const configHome = path.join(tempRoot, "xdg");
  const dataHome = path.join(tempRoot, "xdg-data");
  const runtimeDir = path.join(tempRoot, "runtime");
  const controlDir = path.join(tempRoot, "keyring-control");
  const busConfig = path.join(tempRoot, "session-bus.conf");
  const busSocket = path.join(runtimeDir, "session-bus");
  await Promise.all([
    fsp.mkdir(home, { recursive: true }),
    fsp.mkdir(configHome, { recursive: true }),
    fsp.mkdir(dataHome, { recursive: true }),
    fsp.mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(controlDir, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([fsp.chmod(runtimeDir, 0o700), fsp.chmod(controlDir, 0o700)]);
  await fsp.writeFile(
    busConfig,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:path=${busSocket}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
    { mode: 0o600 }
  );

  const serviceEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_RUNTIME_DIR: runtimeDir,
  };
  const bus = spawn(
    "dbus-daemon",
    [`--config-file=${busConfig}`, "--nofork", "--nopidfile", "--print-address=1"],
    {
      cwd: repoRoot,
      env: serviceEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  children.push(bus);
  bus.stderr?.on("data", (chunk) =>
    prefixAndWrite("desktop-secret-bus", chunk.toString(), process.stderr)
  );
  const busAddress = await new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () => reject(new Error("Timed out starting the isolated desktop secret-service bus")),
      5_000
    );
    const finish = (error, address) => {
      clearTimeout(timer);
      bus.stdout?.off("data", onData);
      bus.off("error", onError);
      bus.off("exit", onExit);
      if (error) reject(error);
      else resolve(address);
    };
    const onData = (chunk) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const address = buffered.slice(0, newline).trim();
      if (!address) {
        finish(new Error("The isolated desktop secret-service bus emitted an empty address"));
        return;
      }
      finish(null, address);
    };
    const onError = (error) => finish(error);
    const onExit = (code) =>
      finish(new Error(`The isolated desktop secret-service bus exited early (code ${code})`));
    bus.stdout?.on("data", onData);
    bus.once("error", onError);
    bus.once("exit", onExit);
  });

  const keyringEnv = { ...serviceEnv, DBUS_SESSION_BUS_ADDRESS: busAddress };
  const keyring = spawnManaged(
    "gnome-keyring-daemon",
    ["--foreground", "--unlock", "--components=secrets", `--control-directory=${controlDir}`],
    {
      cwd: repoRoot,
      env: keyringEnv,
      label: "desktop-secret-service",
      pipeStdin: true,
    }
  );
  children.push(keyring);
  keyring.stdin?.end(randomUUID());
  await waitForSpawn(keyring, "gnome-keyring-daemon", ["--foreground", "--unlock"]);
  await sleep(250);
  if (keyring.exitCode != null) {
    throw new Error(`The isolated desktop secret service exited early (code ${keyring.exitCode})`);
  }
  console.log("[desktop-smoke] Started an isolated Linux secret service for device credentials");
  return {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: busAddress,
      XDG_CURRENT_DESKTOP: "GNOME",
    },
    electronArgs: ["--password-store=gnome-libsecret"],
  };
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

function waitForChildExit(child, timeoutMs = 5 * 60_000) {
  if (!child || child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForServerReady(readyFile, serverChild, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (serverChild.exitCode != null) {
      throw new Error(`Server exited before readiness (code ${serverChild.exitCode})`);
    }
    try {
      const content = await fsp.readFile(readyFile, "utf8");
      return parseHubReadyPayload(JSON.parse(content));
    } catch {
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

function buildConnectDeepLinkFromLog(loggedLink) {
  const parsed = parseConnectLink(loggedLink);
  if (parsed.kind !== "ok") {
    throw new Error(`Server logged an invalid pairing link: ${parsed.reason}`);
  }
  return createConnectDeepLink({
    endpointId: parsed.endpointId,
    code: parsed.code,
    relays: parsed.relays,
    v: parsed.v,
    exp: parsed.exp,
  });
}

function hasElectronDisplay() {
  if (process.platform !== "linux") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function launchDesktopApp(deepLink, tempRoot, launchTimeoutMs, desktopEnvironment) {
  if (!fs.existsSync(mainPath)) {
    throw new Error(`Electron main entry not found at ${mainPath}. Run pnpm build first.`);
  }
  if (!hasElectronDisplay()) {
    throw new Error(
      "Desktop pairing smoke requires an X11 or Wayland display. Run it from a desktop session or under xvfb-run."
    );
  }

  const env = {
    ...process.env,
    NODE_ENV: "development",
    VIBESTUDIO_TEST_MODE: "1",
    VIBESTUDIO_APP_ROOT: repoRoot,
    ELECTRON_DISABLE_GPU: "1",
    ELECTRON_DISABLE_SANDBOX: "1",
    HOME: path.join(tempRoot, "home"),
    XDG_CONFIG_HOME: path.join(tempRoot, "xdg"),
    ...desktopEnvironment.env,
  };

  await fsp.mkdir(env.HOME, { recursive: true });
  await fsp.mkdir(env.XDG_CONFIG_HOME, { recursive: true });

  const userDataDir = path.join(tempRoot, "electron-user-data");
  console.log(`[desktop-smoke] Launching Electron with Iroh pairing deep link`);
  // The desktop shell ingests the pairing material via the vibestudio://connect
  // deep link passed as an argv: protocolHandler.enqueueFirstArgvLink(process.argv)
  // (src/main/index.ts) scans argv on first launch, the bootstrap chooser drains
  // it (vibestudio:drain-pair-link), and the shell dials the server over Iroh.
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [
      "--no-sandbox",
      ...desktopEnvironment.electronArgs,
      `--user-data-dir=${userDataDir}`,
      mainPath,
      deepLink,
    ],
    env,
    timeout: launchTimeoutMs,
  });
  const child = app.process();
  child.stdout?.on("data", (chunk) => prefixAndWrite("electron", chunk.toString(), process.stdout));
  child.stderr?.on("data", (chunk) => prefixAndWrite("electron", chunk.toString(), process.stderr));
  await installDesktopDiagnostics(app);
  await app.firstWindow({ timeout: launchTimeoutMs });
  return app;
}

async function installDesktopDiagnostics(app) {
  await evaluateElectron(
    app,
    ({ app: electronApp, webContents }) => {
      const state = {
        records: [],
        attachedIds: new Set(),
      };
      globalThis.__desktopPairingSmokeDiagnostics = state;

      const attach = (contents) => {
        if (contents.isDestroyed() || state.attachedIds.has(contents.id)) return;
        state.attachedIds.add(contents.id);
        const base = () => ({
          url: contents.isDestroyed() ? "" : contents.getURL(),
          sourceId: "",
          timestamp: Date.now(),
        });
        contents.on("console-message", (event) => {
          state.records.push({
            type: "console",
            level: String(event.level ?? ""),
            message: String(event.message ?? ""),
            ...base(),
            sourceId: String(event.sourceId ?? ""),
          });
        });
        contents.on(
          "did-fail-load",
          (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            state.records.push({
              type: "did-fail-load",
              level: "",
              message: `${errorDescription} (${errorCode}); mainFrame=${String(isMainFrame)}`,
              ...base(),
              url: String(validatedURL ?? ""),
            });
          }
        );
        contents.on("render-process-gone", (_event, details) => {
          state.records.push({
            type: "render-process-gone",
            level: "",
            message: String(details.reason ?? "unknown"),
            ...base(),
          });
        });
        contents.on("unresponsive", () => {
          state.records.push({
            type: "unresponsive",
            level: "",
            message: "Renderer became unresponsive",
            ...base(),
          });
        });
      };

      for (const contents of webContents.getAllWebContents()) attach(contents);
      electronApp.on("web-contents-created", (_event, contents) => attach(contents));
    },
    undefined,
    "installing desktop renderer diagnostics"
  );
}

async function readDesktopDiagnostics(app) {
  return evaluateElectron(
    app,
    () => {
      const diagnostics = globalThis.__desktopPairingSmokeDiagnostics;
      if (!diagnostics) throw new Error("Desktop renderer diagnostics were not installed");
      return diagnostics.records;
    },
    undefined,
    "reading desktop renderer diagnostics"
  );
}

async function readMainProcessErrors(app) {
  return evaluateElectron(
    app,
    () => {
      const testApi = globalThis.__testApi;
      if (!testApi?.readMainProcessErrors) throw new Error("Desktop test API is not available");
      return testApi.readMainProcessErrors();
    },
    undefined,
    "reading the main-process error ledger"
  );
}

async function waitForDesktopShell(app, timeoutMs) {
  const deadlineMs = Date.now() + timeoutMs;
  let lastSnapshots = [];
  let clickedApprovals = 0;
  while (Date.now() < deadlineMs) {
    const snapshots = await collectShellSnapshots(app, Math.max(1_000, deadlineMs - Date.now()));
    lastSnapshots = snapshots;
    const errorText = snapshots
      .map((snapshot) => snapshot.text)
      .find((text) =>
        /\b(Connection error|Launch gate could not|Failed to initialize|Remote server disconnected|Cannot continue|Cannot start|Recovery failed|Vibestudio could not start|Workspace startup is taking longer than expected)\b/i.test(
          text
        )
      );
    if (errorText) {
      throw new Error(`Desktop shell surfaced an error: ${summarizeText(errorText)}`);
    }

    if (snapshots.some((snapshot) => snapshot.hasHostedShellChrome)) {
      const hostView = await getHostViewDebugInfo(app).catch(() => null);
      return { snapshots, hostView, clickedApprovals };
    }

    if (snapshots.some((snapshot) => snapshot.hasLaunchGateApproval)) {
      const clicked = await clickDesktopButton(
        app,
        /^(Trust and (start|connect)|Approve and (start|connect))$/i
      );
      if (clicked) {
        clickedApprovals += 1;
        console.log("[desktop-smoke] Approved desktop workspace app launch gate");
        await sleep(1_000);
        continue;
      }
    }

    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for hosted desktop shell. Last snapshots:\n${JSON.stringify(
      lastSnapshots,
      null,
      2
    )}`
  );
}

async function waitForShellOverlayCleared(app, timeoutMs) {
  const deadlineMs = Date.now() + timeoutMs;
  let hostView = null;
  let lastOverlayState;
  let workspaceInstallApprovals = 0;
  let lastWorkspaceInstallClickAt = 0;
  while (Date.now() < deadlineMs) {
    hostView = await getHostViewDebugInfo(app).catch(() => null);
    if (hostView?.shellOverlayActive !== lastOverlayState) {
      lastOverlayState = hostView?.shellOverlayActive;
      console.log(`[desktop-smoke] Shell overlay active: ${String(lastOverlayState)}`);
    }
    if (hostView?.shellOverlayActive === false) {
      return { hostView, workspaceInstallApprovals };
    }

    // A fresh remote workspace deliberately asks once before admitting the
    // template's apps, panels, and services. Exercise that real consent step
    // so this smoke proves the post-pair workspace is usable, rather than
    // treating a valid first-run review as a compositor hang.
    // A fresh workspace can have more than one unit-install review. The shell
    // intentionally advances to the next review after each decision, so keep
    // draining the queue until the overlay actually releases the panel layer.
    // Pace retries so a still-pending decision cannot receive duplicate clicks.
    if (Date.now() - lastWorkspaceInstallClickAt >= 750) {
      const clicked = await clickDesktopButton(app, /^Add to workspace$/i);
      if (clicked) {
        workspaceInstallApprovals += 1;
        lastWorkspaceInstallClickAt = Date.now();
        console.log(
          `[desktop-smoke] Approved workspace install review #${workspaceInstallApprovals}`
        );
        await sleep(250);
        continue;
      }
    }
    await sleep(250);
  }
  throw new Error(
    `Desktop shell overlay remained active after dismissing the Remote server pane: ${JSON.stringify(hostView)}`
  );
}

async function collectShellSnapshots(app, timeoutMs = ELECTRON_EVALUATE_TIMEOUT_MS) {
  return evaluateElectron(
    app,
    async ({ webContents }) => {
      const snapshots = [];
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue;
        const url = contents.getURL();
        try {
          const dom = await Promise.race([
            contents.executeJavaScript(
              `(() => {
            const text = document.body?.innerText ?? "";
            const buttons = Array.from(document.querySelectorAll("button"))
              .map((button) => button.textContent?.trim() ?? "")
              .filter(Boolean);
            const hasLaunchGateApproval = Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'))
              && buttons.some((label) =>
                /^(Trust and (start|connect)|Approve and (start|connect)|Deny)$/i.test(label)
              );
            const hasHostedShellChrome = Boolean(
              document.querySelector('[data-shell-top-chrome="titlebar"]')
                || document.querySelector(".titlebar-breadcrumb-scroll")
                || document.querySelector('[aria-label="Menu"]')
                || document.querySelector('[data-hosted-shell="true"]')
            );
            return {
              text: text.slice(0, 3000),
              buttons,
              hasLaunchGateApproval,
              hasHostedShellChrome,
            };
          })()`,
              true
            ),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("webContents DOM probe timed out")), 2_000)
            ),
          ]);
          snapshots.push({
            id: contents.id,
            url,
            title: contents.getTitle(),
            ...dom,
          });
        } catch {
          // Ignore non-DOM webContents.
        }
      }
      return snapshots;
    },
    undefined,
    "collecting shell snapshots",
    timeoutMs
  );
}

async function clickDesktopButton(app, label) {
  try {
    return await evaluateElectron(
      app,
      async ({ webContents }, labelSource) => {
        const label = new RegExp(labelSource, "i");
        const candidates = [];
        for (const contents of webContents.getAllWebContents()) {
          if (contents.isDestroyed()) continue;
          try {
            const priority = await contents.executeJavaScript(
              `(() => {
              const hasLaunchGateApproval = Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'));
              const hasHostedShellChrome = Boolean(
                document.querySelector('[data-shell-top-chrome="titlebar"]')
                  || document.querySelector(".titlebar-breadcrumb-scroll")
                  || document.querySelector('[aria-label="Menu"]')
              );
              if (hasLaunchGateApproval) return 0;
              if (hasHostedShellChrome) return 2;
              return 3;
            })()`,
              true
            );
            candidates.push({ contents, priority });
          } catch {
            // Ignore non-DOM webContents.
          }
        }
        candidates.sort((a, b) => a.priority - b.priority);
        for (const { contents } of candidates) {
          if (contents.isDestroyed()) continue;
          try {
            const clicked = await contents.executeJavaScript(
              `(() => {
              const label = new RegExp(${JSON.stringify(labelSource)}, "i");
              const button = Array.from(document.querySelectorAll("button"))
                .find((item) => label.test(
                  item.getAttribute("aria-label")?.trim()
                    || item.textContent?.trim()
                    || ""
                ));
              if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
              button.click();
              return true;
            })()`,
              true
            );
            if (clicked) return true;
          } catch {
            // Ignore non-DOM webContents.
          }
        }
        return false;
      },
      label.source,
      "clicking a desktop button"
    );
  } catch {
    return false;
  }
}

async function waitAndClickHostedShellButton(app, label, timeoutMs) {
  return evaluateElectron(
    app,
    async ({ webContents }, input) => {
      const deadline = Date.now() + input.timeoutMs;
      while (Date.now() < deadline) {
        const hostedShellUrl =
          globalThis.__testApi?.getHostViewDebugInfo?.().hostedShellUrl ?? null;
        const contents = hostedShellUrl
          ? webContents
              .getAllWebContents()
              .find(
                (candidate) => !candidate.isDestroyed() && candidate.getURL() === hostedShellUrl
              )
          : null;
        if (contents) {
          const clicked = await contents
            .executeJavaScript(
              `(() => {
                  const label = new RegExp(${JSON.stringify(input.labelSource)}, "i");
                  const button = Array.from(document.querySelectorAll("button"))
                    .find((item) => label.test(
                      item.getAttribute("aria-label")?.trim()
                        || item.textContent?.trim()
                        || ""
                    ));
                  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
                  button.click();
                  return true;
                })()`,
              true
            )
            .catch(() => false);
          if (clicked) return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    },
    { timeoutMs, labelSource: label.source },
    "waiting for an enabled desktop button",
    timeoutMs + 5_000
  );
}

async function dismissConnectionDialog(app) {
  return evaluateElectron(
    app,
    async ({ webContents }) => {
      const hostedShellUrl = globalThis.__testApi?.getHostViewDebugInfo?.().hostedShellUrl ?? null;
      if (!hostedShellUrl) return false;
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL() === hostedShellUrl);
      if (!contents) return false;
      try {
        return await contents.executeJavaScript(
          `(() => {
              const dialog = document.querySelector('[role="dialog"]');
              const text = dialog?.textContent ?? "";
              if (!/paired devices/i.test(text)) return false;
              const close = Array.from(dialog.querySelectorAll("button"))
                .find((button) => button.textContent?.trim() === "Close");
              if (!(close instanceof HTMLButtonElement) || close.disabled) return false;
              close.click();
              return true;
            })()`,
          true
        );
      } catch {
        return false;
      }
    },
    undefined,
    "dismissing the connection dialog"
  );
}

async function verifySettingsEvent(app, timeoutMs) {
  const invoked = await evaluateElectron(
    app,
    ({ BrowserWindow, Menu }) => {
      const findItem = (items) => {
        for (const item of items) {
          if (item.label === "Settings…") return item;
          const nested = item.submenu ? findItem(item.submenu.items) : null;
          if (nested) return nested;
        }
        return null;
      };
      const menu = Menu.getApplicationMenu();
      const item = menu ? findItem(menu.items) : null;
      if (!item?.click) return false;
      item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {
        triggeredByAccelerator: false,
      });
      return true;
    },
    undefined,
    "emitting open-settings through the application menu"
  );
  if (!invoked) {
    throw new Error("Desktop application menu did not expose Settings…");
  }

  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await evaluateElectron(
      app,
      async ({ webContents }) => {
        const testApi = globalThis.__testApi;
        const hostedShellUrl = testApi?.getHostViewDebugInfo?.().hostedShellUrl ?? null;
        if (!hostedShellUrl) return { opened: false, reason: "hosted-shell-unavailable" };
        const shell = webContents
          .getAllWebContents()
          .find((contents) => !contents.isDestroyed() && contents.getURL() === hostedShellUrl);
        if (!shell) {
          return { opened: false, reason: "hosted-shell-web-contents-unavailable", hostedShellUrl };
        }
        try {
          return await shell.executeJavaScript(
            `(() => {
              const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
              const opened = dialogs.some((dialog) => {
                const labelledBy = dialog.getAttribute("aria-labelledby");
                const accessibleName = labelledBy
                  ? document.getElementById(labelledBy)?.textContent?.trim()
                  : dialog.getAttribute("aria-label")?.trim();
                const connectionTab = dialog.querySelector(
                  '[role="tab"][aria-label="Connection"][aria-selected="true"], [role="tab"][aria-label="Connection"][data-state="active"]'
                );
                return accessibleName === "Settings" && connectionTab !== null;
              });
              return {
                opened,
                hostedShellUrl: location.href,
                dialogs: dialogs.map((dialog) => (dialog.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 240)),
              };
            })()`,
            true
          );
        } catch (error) {
          return {
            opened: false,
            reason: error instanceof Error ? error.message : String(error),
            hostedShellUrl,
          };
        }
      },
      undefined,
      "checking the connection settings event result"
    );
    if (latest.opened) {
      console.log(
        "[desktop-smoke] Verified the typed open-settings subscription through the application menu"
      );
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `The application menu emitted open-settings for the Connection section, but the hosted shell did not open Settings. Last state: ${JSON.stringify(latest)}`
  );
}

async function assertCleanDesktopDiagnostics(app) {
  // Event watches settle asynchronously after the first rendered frame. Give
  // rejected watches and the main-process rejection ledger one bounded turn to
  // become observable before declaring the paired desktop healthy.
  await sleep(500);
  const [rendererDiagnostics, mainProcessErrors] = await Promise.all([
    readDesktopDiagnostics(app),
    readMainProcessErrors(app),
  ]);
  const unexpectedRendererDiagnostics = unexpectedDesktopDiagnostics(rendererDiagnostics);
  if (unexpectedRendererDiagnostics.length > 0) {
    throw new Error(
      `Desktop renderers reported unexpected warnings or errors:\n${formatDesktopDiagnostics(
        unexpectedRendererDiagnostics
      )}`
    );
  }
  if (mainProcessErrors.length > 0) {
    throw new Error(
      `Desktop main process reported uncaught errors: ${JSON.stringify(mainProcessErrors, null, 2)}`
    );
  }
}

async function getHostViewDebugInfo(app) {
  return evaluateElectron(
    app,
    () => {
      const testApi = globalThis.__testApi;
      return testApi?.getHostViewDebugInfo?.() ?? null;
    },
    undefined,
    "reading host view diagnostics"
  );
}

async function getPanelTree(app) {
  return evaluateElectron(
    app,
    () => {
      const testApi = globalThis.__testApi;
      return testApi?.getPanelTree?.() ?? [];
    },
    undefined,
    "reading the panel tree"
  );
}

async function waitForRenderedPanel(app, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let workspaceInstallApprovals = 0;
  while (Date.now() < deadline) {
    // Install reviews are asynchronous shell state and can appear after the
    // initial overlay snapshot was already clear. Drain them in the same loop
    // that proves panel readiness so the test follows the user's actual cold
    // startup, rather than racing one transient DOM observation.
    if (await clickDesktopButton(app, /^Add to workspace$/i)) {
      workspaceInstallApprovals += 1;
      console.log(
        `[desktop-smoke] Approved workspace install review #${workspaceInstallApprovals}`
      );
      await sleep(250);
      continue;
    }

    try {
      latest = await evaluateElectron(
        app,
        async () => {
          const testApi = globalThis.__testApi;
          if (!testApi) throw new Error("Desktop test API is not available");
          const initializationFailure = testApi.readPanelInitializationFailure();
          if (initializationFailure) return { initializationFailure };

          const panels = testApi.getPanelTree();
          const panel =
            panels.find((entry) => entry.snapshot?.source === "panels/chat") ?? panels[0];
          if (!panel) return { panel: null };
          const readiness = await testApi.getPanelReadiness(panel.id);
          let text = "";
          if (readiness.terminal && readiness.nativeSlotBound) {
            text = await testApi.getPanelText(panel.id).catch(() => "");
          }
          return {
            panel: { id: panel.id, source: panel.snapshot?.source ?? null },
            readiness,
            text: text.replace(/\s+/g, " ").trim().slice(0, 240),
          };
        },
        undefined,
        "reading canonical panel readiness",
        Math.min(30_000, Math.max(1_000, deadline - Date.now()))
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("evaluation timed out")) throw error;
      await sleep(250);
      continue;
    }

    if (latest.initializationFailure) {
      throw new Error(
        `Desktop panel initialization failed: ${JSON.stringify(latest.initializationFailure)}`
      );
    }
    if (latest.readiness?.terminal && latest.readiness.nativeSlotBound) {
      return { ...latest, workspaceInstallApprovals };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for a ready, native-bound panel surface. Last state: ${JSON.stringify(latest)}`
  );
}

const CHAT_STARTUP_COPY = [
  "Loading your conversation",
  "Preparing model choices",
  "Preparing your agent",
  "Waiting for workspace review",
];

async function waitForChatExperienceReady(app, panelId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latestText = "";
  while (Date.now() < deadline) {
    latestText = await evaluateElectron(
      app,
      async (_electron, id) => {
        const testApi = globalThis.__testApi;
        if (!testApi) throw new Error("Desktop test API is not available");
        return (await testApi.getPanelText(id)).replace(/\s+/g, " ").trim();
      },
      panelId,
      "waiting for the chat experience to become ready",
      Math.min(30_000, Math.max(1_000, deadline - Date.now()))
    ).catch((error) => {
      if (error instanceof Error && error.message.includes("evaluation timed out"))
        return latestText;
      throw error;
    });
    if (latestText && CHAT_STARTUP_COPY.every((copy) => !latestText.includes(copy))) {
      return latestText.slice(0, 500);
    }
    await sleep(250);
  }
  throw new Error(
    `Chat panel remained in its startup experience after its native surface was ready: ${JSON.stringify(latestText.slice(0, 800))}`
  );
}

async function verifyNativePageTitleProjection(app, panelId, timeoutMs) {
  const replacementTitle = `Desktop title projection ${randomUUID().slice(0, 8)}`;
  const expectedTitle = await evaluateElectron(
    app,
    async (_electron, { id, title }) => {
      const testApi = globalThis.__testApi;
      if (!testApi) throw new Error("Desktop test API is not available");
      return testApi.executePanelScript(
        id,
        `document.title = ${JSON.stringify(title)}; document.title`
      );
    },
    { id: panelId, title: replacementTitle },
    "changing the native panel document title"
  );
  if (typeof expectedTitle !== "string" || expectedTitle.trim().length === 0) {
    throw new Error(
      `Native panel did not expose a document title: ${JSON.stringify(expectedTitle)}`
    );
  }

  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  let latestChrome = { treeTitle: "", breadcrumbTitle: "" };
  while (Date.now() < deadline) {
    latestChrome = await evaluateElectron(
      app,
      async ({ webContents }, id) => {
        const shell = webContents
          .getAllWebContents()
          .find(
            (contents) =>
              !contents.isDestroyed() &&
              contents.getTitle() === "@workspace-apps/shell" &&
              !contents.getURL().includes("#overlaySurface=")
          );
        if (!shell) return { treeTitle: "", breadcrumbTitle: "" };
        return shell.executeJavaScript(
          `(() => {
            const panelId = ${JSON.stringify(id)};
            const treeRow = [...document.querySelectorAll('[data-panel-tree-row="true"]')]
              .find((element) => element.getAttribute('data-panel-id') === panelId);
            const breadcrumb = [...document.querySelectorAll('[data-breadcrumb-id]')]
              .find((element) => element.getAttribute('data-breadcrumb-id') === panelId);
            return {
              treeTitle: treeRow?.textContent?.trim() ?? '',
              breadcrumbTitle: breadcrumb?.textContent?.trim() ?? '',
            };
          })()`,
          true
        );
      },
      panelId,
      "reading hosted shell title chrome"
    );
    if (
      latestChrome.treeTitle.includes(expectedTitle) &&
      latestChrome.breadcrumbTitle.includes(expectedTitle)
    ) {
      return expectedTitle;
    }
    await sleep(100);
  }
  throw new Error(
    `Native page title did not reach hosted shell panel-tree and breadcrumb chrome: ${JSON.stringify(
      {
        expectedTitle,
        ...latestChrome,
      }
    )}`
  );
}

async function createAndWaitForNewPanel(app, existingPanelIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const controlTimeoutMs = Math.min(30_000, Math.max(1_000, timeoutMs));
  const clicked = await waitAndClickHostedShellButton(app, /^New panel$/i, controlTimeoutMs);
  if (!clicked) {
    const lastShellSnapshots = await collectShellSnapshots(app).catch(() => []);
    throw new Error(
      `Hosted shell did not expose an enabled "New panel" control: ${JSON.stringify(lastShellSnapshots)}`
    );
  }

  let latest = null;
  while (Date.now() < deadline) {
    latest = await evaluateElectron(
      app,
      async (_electron, { knownIds }) => {
        const testApi = globalThis.__testApi;
        if (!testApi) throw new Error("Desktop test API is not available");
        const initializationFailure = testApi.readPanelInitializationFailure();
        if (initializationFailure) return { initializationFailure };
        const panel = testApi.getPanelTree().find((entry) => !knownIds.includes(entry.id));
        if (!panel) return { panel: null };
        const readiness = await testApi.getPanelReadiness(panel.id);
        return {
          panel: { id: panel.id, source: panel.snapshot?.source ?? null },
          readiness,
        };
      },
      { knownIds: [...existingPanelIds] },
      "waiting for a newly created panel"
    );
    if (latest.initializationFailure) {
      throw new Error(
        `New panel initialization failed: ${JSON.stringify(latest.initializationFailure)}`
      );
    }
    if (latest.readiness?.terminal && latest.readiness.nativeSlotBound) return latest;
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for a newly created native-bound panel. Last state: ${JSON.stringify(latest)}`
  );
}

async function saveScreenshot(app) {
  const pages = app.windows();
  const page = pages[0] ?? (await app.firstWindow({ timeout: 5_000 }));
  await fsp.mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(
    screenshotDir,
    `desktop-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
  );
  await Promise.race([
    page.screenshot({ path: screenshotPath, fullPage: false }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Desktop smoke screenshot timed out")), 5_000)
    ),
  ]);
  return screenshotPath;
}

function summarizeText(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 800);
}

async function closeElectron(app) {
  if (!app) return;
  // Capture the pid up front: app.process() can THROW if Playwright's underlying
  // _object was already torn down (the failure mode that left orphan windows).
  let pid;
  try {
    pid = app.process()?.pid;
  } catch {
    pid = undefined;
  }
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 5_000)),
    ]);
  } catch {
    // app.close() threw or timed out — fall through to the pid kill below.
  }
  // Final safety net: SIGKILL the Electron process by pid so no orphan window
  // survives a pass OR a failure. ESRCH (already exited) is fine.
  if (typeof pid === "number") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const children = [];
  let electronApp = null;
  let cleanedUp = false;
  let tempRoot = "";
  const deadlineMs = Date.now() + options.timeoutMs;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    // closeElectron is crash-proof, but wrap anyway so a throw can never strand
    // the child server killed below.
    try {
      await closeElectron(electronApp);
    } catch {
      // ignore — children are still killed below.
    }
    // Processes are registered in dependency order (session bus, keyring,
    // server). Stop and await them in reverse order so a dependent
    // can finish its own shutdown before its backing service disappears.
    for (const child of children.reverse()) {
      try {
        if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      await waitForChildExit(child);
      try {
        if (child.exitCode == null) child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await waitForChildExit(child, 30_000);
    }
    try {
      await fsp.unlink(options.readyFile);
    } catch {}
    if (tempRoot) {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  process.on("SIGINT", () => {
    void cleanup().then(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    void cleanup().then(() => process.exit(143));
  });

  try {
    try {
      await fsp.unlink(options.readyFile);
    } catch {}
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-desktop-smoke-"));
    const desktopEnvironment = await startEphemeralLinuxSecretService(tempRoot, children);

    // 1. Start the same remote-serve launcher users run. No relay override is
    // supplied, so this exercises the production public-relay defaults.
    const gatewayPort = await findFreePort();
    const serverArgs = createRemoteServeArgs(repoRoot, options.readyFile, gatewayPort);
    const serverHome = path.join(tempRoot, "server-home");
    const serverConfig = path.join(tempRoot, "server-config");
    await Promise.all([
      fsp.mkdir(serverHome, { recursive: true }),
      fsp.mkdir(serverConfig, { recursive: true }),
    ]);
    const serverEnv = {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "development",
      VIBESTUDIO_TEST_MODE: "1",
      VIBESTUDIO_SERVER_ENTRY: "live",
      VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: sharedDerivedCacheDir,
      HOME: serverHome,
      XDG_CONFIG_HOME: serverConfig,
    };
    const developmentBase = await resolveDevelopmentBase({
      repoRoot,
      checkpointTarget: path.join(tempRoot, "base-checkpoint"),
      productionBase: options.productionBase,
      explicitCheckout: options.baseCheckout,
    });
    if (developmentBase) {
      serverEnv.VIBESTUDIO_DEV_ROOT_TEMPLATE = JSON.stringify(developmentBase.pin);
      serverEnv.VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT = developmentBase.checkout;
      delete serverEnv.VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK;
      await assertBaseCheckoutBootable({ repoRoot, checkout: developmentBase.checkout });
      console.log(
        `[desktop-smoke] Base: ${developmentBase.pin.commit} from ${developmentBase.sourceCheckout}`
      );
    } else {
      delete serverEnv.VIBESTUDIO_DEV_ROOT_TEMPLATE;
      delete serverEnv.VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT;
      delete serverEnv.VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK;
      console.log("[desktop-smoke] Base: canonical pinned production release");
    }
    const serverChild = spawnManaged(process.execPath, serverArgs, {
      cwd: repoRoot,
      env: serverEnv,
      label: "server",
    });
    await waitForSpawn(serverChild, process.execPath, serverArgs);
    children.push(serverChild);

    await waitForServerReady(
      options.readyFile,
      serverChild,
      Math.max(1_000, deadlineMs - Date.now())
    );

    // 2. Follow the deployed first-device flow: consume the protected root
    // invite emitted in the server's ready payload.
    const invite = await waitForRootInvite({
      readyFile: options.readyFile,
      timeoutMs: Math.max(1_000, deadlineMs - Date.now()),
    });
    const loggedLink = invite.pairUrl;
    const deepLink = buildConnectDeepLinkFromLog(loggedLink);
    const parsed = parseConnectLink(deepLink);
    if (parsed.kind !== "ok") {
      throw new Error(`Server logged an invalid pairing link: ${parsed.reason}`);
    }
    console.log(
      `[desktop-smoke] Iroh pairing: endpoint=${parsed.endpointId}; relays=${parsed.relays.join(",")}`
    );
    console.log(`[desktop-smoke] Deep link: ${deepLink}`);

    electronApp = await launchDesktopApp(
      deepLink,
      tempRoot,
      options.launchTimeoutMs,
      desktopEnvironment
    );
    const result = await waitForDesktopShell(electronApp, options.launchTimeoutMs);
    const panels = await getPanelTree(electronApp).catch(() => []);
    const dismissedRemotePane = await dismissConnectionDialog(electronApp);
    if (dismissedRemotePane) console.log("[desktop-smoke] Dismissed Remote server pane");
    const overlay = await waitForShellOverlayCleared(
      electronApp,
      Math.max(1_000, deadlineMs - Date.now())
    );
    const hostView = overlay.hostView;
    const hostedShellUrl = String(
      hostView?.hostedShellUrl ??
        result.snapshots.find((snapshot) => snapshot.title === HOSTED_SHELL_APP)?.url ??
        ""
    );
    const renderedPanel = await waitForRenderedPanel(
      electronApp,
      Math.max(1_000, deadlineMs - Date.now())
    );
    const chatExperience = await waitForChatExperienceReady(
      electronApp,
      renderedPanel.panel.id,
      Math.max(1_000, deadlineMs - Date.now())
    );
    console.log(`[desktop-smoke] Chat experience ready: ${chatExperience}`);
    const panelIds = new Set((await getPanelTree(electronApp)).map((panel) => panel.id));
    const newPanel = await createAndWaitForNewPanel(
      electronApp,
      panelIds,
      Math.max(1_000, deadlineMs - Date.now())
    );
    const projectedTitle = await verifyNativePageTitleProjection(
      electronApp,
      newPanel.panel.id,
      Math.max(1_000, deadlineMs - Date.now())
    );
    console.log(`[desktop-smoke] Native page title projected: ${projectedTitle}`);
    await verifySettingsEvent(electronApp, Math.max(1_000, deadlineMs - Date.now()));
    await assertCleanDesktopDiagnostics(electronApp);
    const screenshotPath = await saveScreenshot(electronApp).catch(() => null);
    if (screenshotPath) {
      console.log(`[desktop-smoke] Post-pair window: ${path.relative(repoRoot, screenshotPath)}`);
    }
    console.log(
      `[desktop-smoke] PASS paired desktop app over Iroh; ` +
        `hostApprovals=${result.clickedApprovals}; ` +
        `workspaceApprovals=${overlay.workspaceInstallApprovals + renderedPanel.workspaceInstallApprovals}; ` +
        `hostedShell=${hostedShellUrl}; ` +
        `panels=${Array.isArray(panels) ? panels.length : "unknown"}; ` +
        `renderedPanel=${JSON.stringify(renderedPanel)}; ` +
        `chatExperience=${JSON.stringify(chatExperience)}; ` +
        `projectedTitle=${JSON.stringify(projectedTitle)}; ` +
        `newPanel=${JSON.stringify(newPanel)}` +
        (screenshotPath ? `; screenshot=${path.relative(repoRoot, screenshotPath)}` : "")
    );
    await cleanup();
  } catch (error) {
    console.error(`[desktop-smoke] ${error instanceof Error ? error.message : String(error)}`);
    await cleanup();
    process.exit(1);
  }
}

await main();
