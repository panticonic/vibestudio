/**
 * Electron E2E test setup utilities.
 *
 * Provides helpers for launching the app with isolated test workspaces,
 * waiting for panels, and cleaning up after tests.
 */

import {
  _electron as electron,
  expect,
  test as playwrightTest,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execFileSync } from "child_process";
import { getCentralDataPath } from "@vibestudio/env-paths";
import {
  WORKSPACE_SOURCE_DIRS,
  WORKSPACE_STATE_DIRS,
} from "@vibestudio/workspace-contracts/sourceDirs";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import type { PanelLifecycleResult } from "@vibestudio/shared/types";
import type { PanelReadinessSnapshot, TestApi } from "../../src/main/testApi.js";
import type { MainProcessErrorRecord } from "../../src/main/mainProcessErrorLedger.js";
import type { PanelInitializationFailure } from "../../src/main/panelInitializationFailure.js";
import { isAutomationContextReplacement } from "./automationContext.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

export interface TestApp {
  /** The Playwright Electron application handle */
  app: ElectronApplication;
  /** The main window's Page object */
  window: Page;
  /** Path to the isolated test workspace */
  workspacePath: string;
  /** Captured stdout and stderr from the Electron process. */
  getOutput: () => string;
  /** Clean up the app and test workspace */
  cleanup: () => Promise<void>;
}

export const ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE =
  "Electron E2E tests require an X11 or Wayland display. Run them from a desktop session or under xvfb-run.";

export function hasElectronDisplay(): boolean {
  if (process.platform !== "linux") {
    return true;
  }
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export interface LaunchOptions {
  /** Use an existing managed workspace directory instead of creating a new one */
  workspace?: string;
  /** Initial panel source to load (defaults to shell:new launcher if no panels exist) */
  initialPanel?: string;
  /** Open DevTools on launch (dev mode only) */
  devTools?: boolean;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Timeout for app launch in milliseconds (default: 120000) */
  launchTimeout?: number;
  /** Exact main-process failures intentionally induced by this launch. */
  expectedMainProcessErrors?: ReadonlyArray<Pick<MainProcessErrorRecord, "kind" | "message">>;
}

interface ManagedWorkspaceInfo {
  workspaceName: string;
  testRoot: string;
  env: Record<string, string>;
}

const SHARED_MACHINE_CACHE_DIRS = ["npm-cache", "external-deps", "extension-runtime-deps"] as const;

function linkSharedMachineCaches(isolatedCentralDataDir: string): void {
  const sharedCentralDataDir = getCentralDataPath();
  if (path.resolve(sharedCentralDataDir) === path.resolve(isolatedCentralDataDir)) return;

  fs.mkdirSync(isolatedCentralDataDir, { recursive: true });
  for (const cacheDir of SHARED_MACHINE_CACHE_DIRS) {
    const source = path.join(sharedCentralDataDir, cacheDir);
    const destination = path.join(isolatedCentralDataDir, cacheDir);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
  }
}

function getTestEnv(testRoot: string): Record<string, string> {
  switch (process.platform) {
    case "win32":
      return { APPDATA: path.join(testRoot, "appdata") };
    case "darwin":
      return { HOME: path.join(testRoot, "home") };
    default:
      return {
        HOME: path.join(testRoot, "home"),
        XDG_CONFIG_HOME: path.join(testRoot, "xdg"),
      };
  }
}

function getCentralDataDirFromEnv(env: Record<string, string>): string {
  switch (process.platform) {
    case "win32":
      return path.join(env.APPDATA!, "vibestudio");
    case "darwin":
      return path.join(env.HOME!, "Library", "Application Support", "vibestudio");
    default:
      return path.join(env.XDG_CONFIG_HOME!, "vibestudio");
  }
}

function getWorkspaceInfo(workspaceDir: string): ManagedWorkspaceInfo {
  const workspaceName = path.basename(workspaceDir);
  let testRoot: string;

  switch (process.platform) {
    case "win32":
      testRoot = path.dirname(path.dirname(path.dirname(path.dirname(workspaceDir))));
      break;
    case "darwin":
      testRoot = path.dirname(
        path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(workspaceDir)))))
      );
      break;
    default:
      testRoot = path.dirname(path.dirname(path.dirname(path.dirname(workspaceDir))));
      break;
  }

  return {
    workspaceName,
    testRoot,
    env: getTestEnv(testRoot),
  };
}

function getWorkspaceTemplateDir(projectRoot: string): string {
  const templateDir = path.join(projectRoot, "workspace");
  if (!fs.existsSync(path.join(templateDir, "meta/vibestudio.yml"))) {
    throw new Error(`Workspace template not found at ${templateDir}`);
  }
  return templateDir;
}

function collectUnitDirs(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
      const child = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(child, "package.json"))) {
        result.push(child);
        continue;
      }
      visit(child);
    }
  };
  visit(root);
  return result;
}

function initializeUnitGitRepos(sourceRoot: string): void {
  for (const unitDir of collectUnitDirs(sourceRoot)) {
    execFileSync("git", ["init", "-b", "main"], { cwd: unitDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "e2e@example.invalid"], {
      cwd: unitDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Vibestudio E2E"], {
      cwd: unitDir,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "-A"], { cwd: unitDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initial e2e workspace snapshot"], {
      cwd: unitDir,
      stdio: "ignore",
    });
  }
}

export function createManagedTestWorkspace(projectRoot?: string): string {
  const resolvedProjectRoot = projectRoot ?? path.resolve(__dirname, "../..");
  const templateDir = getWorkspaceTemplateDir(resolvedProjectRoot);
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-e2e-"));
  const env = getTestEnv(testRoot);
  const workspaceName = `e2e_${crypto.randomBytes(6).toString("hex")}`;
  const workspaceDir = path.join(getCentralDataDirFromEnv(env), "workspaces", workspaceName);
  const sourceRoot = path.join(workspaceDir, "source");
  const stateRoot = path.join(workspaceDir, "state");

  for (const dir of Object.values(env)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Test identity, workspace source, and mutable state remain private. Reuse
  // only machine-scoped dependency caches, whose entries are keyed by content,
  // so repeated cold workspace launches do not depend on external network
  // latency or duplicate immutable installs.
  linkSharedMachineCaches(getCentralDataDirFromEnv(env));

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  for (const dir of WORKSPACE_SOURCE_DIRS) {
    const src = path.join(templateDir, dir);
    const dest = path.join(sourceRoot, dir);
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, {
        recursive: true,
        filter: (candidate) => {
          const name = path.basename(candidate);
          return name !== ".git" && name !== "node_modules" && name !== ".cache";
        },
      });
    } else {
      fs.mkdirSync(dest, { recursive: true });
    }
  }

  initializeUnitGitRepos(sourceRoot);

  for (const dir of WORKSPACE_STATE_DIRS) {
    fs.mkdirSync(path.join(stateRoot, dir), { recursive: true });
  }

  const centralData = new CentralDataManager({
    databasePath: path.join(getCentralDataDirFromEnv(env), "server-auth", "identity.db"),
  });
  try {
    centralData.addWorkspace(workspaceName);
    // E2E owns the isolated hub lifecycle. Persist the explicit "stop" quit
    // policy in this fixture's private identity database so Electron can take
    // its normal graceful shutdown path without opening an interactive dialog.
    centralData.setKeepServerOnQuit(false);
  } finally {
    centralData.close();
  }

  return workspaceDir;
}

export function removeManagedTestWorkspace(workspaceDir: string): void {
  const { testRoot } = getWorkspaceInfo(workspaceDir);
  fs.rmSync(testRoot, { recursive: true, force: true });
}

/**
 * Launch the vibestudio Electron app with an isolated test workspace.
 *
 * @example
 * ```typescript
 * const { app, window, cleanup } = await launchTestApp();
 * try {
 *   // Run tests
 *   await window.click('[data-testid="some-button"]');
 * } finally {
 *   await cleanup();
 * }
 * ```
 */
export async function launchTestApp(options: LaunchOptions = {}): Promise<TestApp> {
  const {
    workspace,
    initialPanel,
    devTools = false,
    env = {},
    launchTimeout = 120000,
    expectedMainProcessErrors = [],
  } = options;

  const projectRoot = path.resolve(__dirname, "../..");
  const workspacePath = workspace ?? createManagedTestWorkspace(projectRoot);
  const workspaceInfo = getWorkspaceInfo(workspacePath);
  const ownsWorkspace = workspace === undefined;

  // Determine the main entry point
  const mainPath = path.resolve(projectRoot, "dist", "main.cjs");

  if (!fs.existsSync(mainPath)) {
    throw new Error(
      `Main entry point not found at ${mainPath}. Make sure to run 'pnpm build' before running E2E tests.`
    );
  }

  // Get the electron binary path
  const electronPath = require("electron") as string;

  if (!hasElectronDisplay()) {
    throw new Error(ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);
  }

  // Build electron args - first arg is the app entry point
  const electronUserDataDir = path.join(workspaceInfo.testRoot, "electron-user-data");
  const args = [
    "--no-sandbox",
    `--user-data-dir=${electronUserDataDir}`,
    mainPath,
    `--workspace=${workspaceInfo.workspaceName}`,
  ];
  if (initialPanel) {
    args.push(`--panel=${initialPanel}`);
  }

  // Launch the app using the electron binary
  const app = await electron.launch({
    executablePath: electronPath,
    args,
    env: {
      ...process.env,
      NODE_ENV: "development",
      VIBESTUDIO_TEST_MODE: "1",
      // Disable GPU acceleration for CI environments
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
      ...workspaceInfo.env,
      ...env,
    },
    timeout: launchTimeout,
  });
  const output: string[] = [];
  const child = app.process();
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));

  // Cleanup is available before readiness waits so a failed launch cannot
  // orphan the detached local hub (or its workspace/workerd children).
  let testApiReady = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      let ledgerFailure: Error | undefined;
      await playwrightTest.info().attach(`electron-output-${workspaceInfo.workspaceName}.log`, {
        body: output.join(""),
        contentType: "text/plain",
      });
      const hubLogPath = path.join(getCentralDataDirFromEnv(workspaceInfo.env), "logs", "hub.log");
      if (fs.existsSync(hubLogPath)) {
        await playwrightTest.info().attach(`hub-output-${workspaceInfo.workspaceName}.log`, {
          body: fs.readFileSync(hubLogPath),
          contentType: "text/plain",
        });
      }
      if (testApiReady) {
        try {
          const panelInitializationFailure = await readPanelInitializationFailure(app);
          await playwrightTest
            .info()
            .attach(`panel-initialization-${workspaceInfo.workspaceName}.json`, {
              body: JSON.stringify(panelInitializationFailure, null, 2),
              contentType: "application/json",
            });
          const errors = await readMainProcessErrors(app);
          await playwrightTest
            .info()
            .attach(`main-process-errors-${workspaceInfo.workspaceName}.json`, {
              body: JSON.stringify(errors, null, 2),
              contentType: "application/json",
            });
          const remaining = [...errors];
          const missing = expectedMainProcessErrors.filter((expected) => {
            const index = remaining.findIndex(
              (actual) => actual.kind === expected.kind && actual.message === expected.message
            );
            if (index < 0) return true;
            remaining.splice(index, 1);
            return false;
          });
          if (missing.length > 0 || remaining.length > 0) {
            ledgerFailure = new Error(
              `Main-process error ledger mismatch. Missing expected errors: ${JSON.stringify(
                missing
              )}; unexpected errors: ${JSON.stringify(remaining)}`
            );
          }
        } catch (error) {
          ledgerFailure =
            error instanceof Error
              ? error
              : new Error(`Failed to assert main-process error ledger: ${String(error)}`);
        }
      }

      const mainPid = child.pid;
      const workspaceServerPid = readReadyFilePid(
        path.join(workspacePath, "state", "server-ready.json")
      );
      const centralDataDir = getCentralDataDirFromEnv(workspaceInfo.env);
      const hubReady = readHubReadyFile(path.join(centralDataDir, "server-auth", "hub-ready.json"));
      const hubPid = hubReady?.pid;
      const closeWithTimeout = async (timeoutMs: number): Promise<void> =>
        Promise.race([
          app.close(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("App close timed out")), timeoutMs)
          ),
        ]);

      try {
        // HubProcessManager allows up to 12 seconds for the detached hub's
        // ordered shutdown. Cutting Electron off earlier strands its 30-second
        // machine-control lease and makes an immediate restart fail.
        await closeWithTimeout(20_000);
      } catch (error) {
        console.warn("[TestSetup] Graceful close failed, force killing:", error);
        try {
          killProcessTree(mainPid, "SIGKILL");
          await waitForProcessExit(mainPid, 3000);
        } catch {
          // Process may already be dead.
        }
      }

      cleanupKnownChildProcesses(mainPid);
      cleanupKnownChildProcesses(workspaceServerPid);
      for (const detachedPid of [workspaceServerPid, hubPid]) {
        killProcessTree(detachedPid, "SIGTERM");
        if (!(await waitForProcessExit(detachedPid, 15_000))) {
          cleanupKnownChildProcesses(detachedPid);
          killProcessTree(detachedPid, "SIGKILL");
          await waitForProcessExit(detachedPid, 3000);
        }
      }

      // A forced hub stop cannot execute its final lease release. Once the
      // exact ready-file PID is confirmed dead, release only that boot's lease
      // so an immediate restart does not wait for the 30-second fencing TTL.
      if (hubReady && !isProcessAlive(hubReady.pid)) {
        const centralData = new CentralDataManager({
          databasePath: path.join(centralDataDir, "server-auth", "identity.db"),
        });
        try {
          centralData.releaseHubProcessLease(hubReady.serverBootId);
        } finally {
          centralData.close();
        }
      }

      if (ownsWorkspace) {
        try {
          await removeManagedTestWorkspaceWithRetry(workspacePath);
        } catch (error) {
          console.warn("[TestSetup] Error removing workspace:", error);
        }
      }

      if (ledgerFailure) throw ledgerFailure;
    })();
    return cleanupPromise;
  };

  // Get the first window and wait for the test bridge. Readiness failures must
  // carry the detached hub log because child startup diagnostics live there.
  let window: Page;
  try {
    window = await app.firstWindow({ timeout: launchTimeout });
    await window.waitForLoadState("domcontentloaded");
    await waitForTestApiReady(app, launchTimeout, output);
    testApiReady = true;
  } catch (error) {
    const electronDetails = output.join("").trim();
    const hubDetails = readLogTail(
      path.join(getCentralDataDirFromEnv(workspaceInfo.env), "logs", "hub.log")
    );
    await cleanup();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        electronDetails ? `\n\nElectron output before readiness:\n${electronDetails}` : ""
      }${hubDetails ? `\n\nLocal hub log before readiness:\n${hubDetails}` : ""}`
    );
  }

  // Optionally open DevTools
  if (devTools) {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.openDevTools();
    });
  }

  return { app, window, workspacePath, getOutput: () => output.join(""), cleanup };
}

/**
 * Test-side human driver for cold-start unit reviews. This goes through the
 * real shell resolver and queue; it deliberately does not grant a process-wide
 * bypass. Callers remain responsible for non-unit approval kinds.
 */
export async function approvePendingStartupUnits(
  app: ElectronApplication,
  timeoutMs = 180_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let sawReview = false;
  let emptySince = 0;
  while (Date.now() < deadline) {
    try {
      const pending = (await app.evaluate(async () => {
        const testApi = (globalThis as { __testApi?: Pick<TestApi, "rpcCall"> }).__testApi;
        if (!testApi) throw new Error("Test API not available");
        return testApi.rpcCall("shellApproval", "listPending", []);
      })) as Array<{ approvalId: string; kind: string }>;
      const reviews = pending.filter((approval) => approval.kind === "unit-batch");
      for (const review of reviews) {
        sawReview = true;
        await app.evaluate(async (_electron, approvalId) => {
          const testApi = (globalThis as { __testApi?: Pick<TestApi, "rpcCall"> }).__testApi;
          if (!testApi) throw new Error("Test API not available");
          await testApi.rpcCall("shellApproval", "resolve", [approvalId, "once"]);
        }, review.approvalId);
      }
      if (sawReview && reviews.length === 0) {
        emptySince ||= Date.now();
        if (Date.now() - emptySince >= 750) return;
      } else {
        emptySince = 0;
      }
    } catch (error) {
      if (!isAutomationContextReplacement(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the cold-start unit review to settle");
}

function readLogTail(logFile: string, maxCharacters = 20_000): string {
  try {
    const content = fs.readFileSync(logFile, "utf8");
    return content.slice(-maxCharacters).trim();
  } catch {
    return "";
  }
}

function readReadyFilePid(readyFile: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(readyFile, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function readHubReadyFile(readyFile: string): { pid: number; serverBootId: string } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(readyFile, "utf8")) as {
      pid?: unknown;
      serverBootId?: unknown;
    };
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.serverBootId !== "string" ||
      parsed.serverBootId.length === 0
    ) {
      return undefined;
    }
    return { pid: parsed.pid, serverBootId: parsed.serverBootId };
  } catch {
    return undefined;
  }
}

async function waitForProcessExit(pid: number | undefined, timeoutMs: number): Promise<boolean> {
  if (!pid || process.platform === "win32") return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen >= 0 && stat.slice(closeParen + 2).startsWith("Z ")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function removeManagedTestWorkspaceWithRetry(workspaceDir: string): Promise<void> {
  let lastError: unknown = null;
  for (const delayMs of [0, 100, 250, 500, 1000]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      removeManagedTestWorkspace(workspaceDir);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function waitForTestApiReady(
  app: ElectronApplication,
  timeoutMs: number,
  output: string[]
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const ready = await app.evaluate(() => {
        return typeof (globalThis as { __testApi?: unknown }).__testApi !== "undefined";
      });
      if (ready) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const details = output.join("").trim();
  const reason =
    lastError instanceof Error ? lastError.message : lastError ? String(lastError) : "";
  throw new Error(
    `Timed out waiting for VIBESTUDIO_TEST_MODE test API.${reason ? ` Last error: ${reason}` : ""}${
      details ? `\n\nElectron output before test API timeout:\n${details}` : ""
    }`
  );
}

function cleanupKnownChildProcesses(mainPid: number | undefined): void {
  if (!mainPid) return;
  if (process.platform === "win32") return;
  const workerdConfigDir = `/tmp/vibestudio-workerd-${mainPid}/config.capnp`;
  for (const pid of findPidsByCommand(workerdConfigDir)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
    return;
  }
  for (const childPid of collectChildPids(pid)) {
    try {
      process.kill(childPid, signal);
    } catch {
      // already gone
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

function collectChildPids(rootPid: number): number[] {
  const result: number[] = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let stdout = "";
    try {
      stdout = execFileSync("ps", ["-o", "pid=", "--ppid", String(current)], {
        encoding: "utf8",
      });
    } catch {
      continue;
    }
    for (const token of stdout.trim().split(/\s+/)) {
      if (!token) continue;
      const childPid = Number(token);
      if (!Number.isInteger(childPid) || childPid <= 0) continue;
      result.unshift(childPid);
      stack.push(childPid);
    }
  }
  return result;
}

function findPidsByCommand(needle: string): number[] {
  let stdout = "";
  try {
    stdout = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes(needle)) continue;
    const match = line.match(/^\s*(\d+)\s+/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * Wait for a panel to appear in the UI.
 *
 * @param window - The Playwright Page object
 * @param panelIdPattern - A string or regex to match the panel ID
 * @param timeout - Maximum time to wait in milliseconds (default: 10000)
 */
export async function waitForPanel(
  window: Page,
  panelIdPattern: string | RegExp,
  timeout = 10000
): Promise<void> {
  const selector =
    typeof panelIdPattern === "string" ? `[data-panel-id="${panelIdPattern}"]` : `[data-panel-id]`;

  await window.waitForSelector(selector, { timeout });

  if (panelIdPattern instanceof RegExp) {
    // Verify the pattern matches
    const panelId = await window.getAttribute(selector, "data-panel-id");
    if (!panelId || !panelIdPattern.test(panelId)) {
      throw new Error(`No panel matching pattern ${panelIdPattern} found`);
    }
  }
}

/**
 * Get the panel tree from the main process via TestApi.
 */
export async function getPanelTree(app: ElectronApplication): Promise<
  Array<{
    id: string;
    title: string;
    children: unknown[];
    snapshot?: {
      source?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    };
  }>
> {
  return app.evaluate(() => {
    const testApi = (globalThis as { __testApi?: { getPanelTree: () => unknown[] } }).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.getPanelTree();
  }) as Promise<
    Array<{
      id: string;
      title: string;
      children: unknown[];
      snapshot?: {
        source?: string;
        contextId?: string;
        stateArgs?: Record<string, unknown>;
      };
    }>
  >;
}

/**
 * Get the focused panel ID from the main process.
 */
export async function getFocusedPanelId(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(() => {
    const testApi = (globalThis as { __testApi?: { getFocusedPanelId: () => string | null } })
      .__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.getFocusedPanelId();
  });
}

/**
 * Get the panel whose WebContents currently has Electron focus.
 */
export async function getFocusedPanelWebContentsId(
  app: ElectronApplication
): Promise<string | null> {
  return app.evaluate(() => {
    const testApi = (
      globalThis as { __testApi?: { getFocusedPanelWebContentsId: () => string | null } }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.getFocusedPanelWebContentsId();
  });
}

/**
 * Create a panel via the TestApi.
 */
export async function createPanel(
  app: ElectronApplication,
  parentId: string,
  source: string,
  options?: {
    name?: string;
    env?: Record<string, string>;
    focus?: boolean;
    stateArgs?: Record<string, unknown>;
  }
): Promise<{ id: string; type: string; title: string }> {
  return app.evaluate(
    async (_electron, { parentId, source, options }) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            createPanel: (
              p: string,
              s: string,
              o?: unknown
            ) => Promise<{ id: string; type: string; title: string }>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
      }
      return testApi.createPanel(parentId, source, options);
    },
    { parentId, source, options }
  );
}

/**
 * Close a panel via the TestApi.
 */
export async function closePanel(app: ElectronApplication, panelId: string): Promise<void> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (globalThis as { __testApi?: { closePanel: (id: string) => Promise<void> } })
      .__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.closePanel(id);
  }, panelId);
}

/**
 * Reload a panel via the TestApi.
 */
export async function reloadPanel(
  app: ElectronApplication,
  panelId: string
): Promise<PanelLifecycleResult> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as {
        __testApi?: { reloadPanel: (id: string) => Promise<PanelLifecycleResult> };
      }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.reloadPanel(id);
  }, panelId);
}

export async function getPanelReadiness(
  app: ElectronApplication,
  panelId: string
): Promise<PanelReadinessSnapshot> {
  return app.evaluate((_electron, id) => {
    const testApi = (globalThis as { __testApi?: Pick<TestApi, "getPanelReadiness"> }).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.getPanelReadiness(id);
  }, panelId);
}

export async function isPanelReady(app: ElectronApplication, panelId: string): Promise<boolean> {
  return (await getPanelReadiness(app, panelId)).terminal;
}

/** True once background panel content is built and live, without requiring visible-slot binding. */
export async function isPanelContentReady(
  app: ElectronApplication,
  panelId: string
): Promise<boolean> {
  return (await getPanelReadiness(app, panelId)).contentReady;
}

export async function readPanelInitializationFailure(
  app: ElectronApplication
): Promise<PanelInitializationFailure | null> {
  return app.evaluate(() => {
    const testApi = (
      globalThis as {
        __testApi?: Pick<TestApi, "readPanelInitializationFailure">;
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    return testApi.readPanelInitializationFailure();
  });
}

export function panelInitializationFailureError(
  failure: PanelInitializationFailure | null
): Error | null {
  if (!failure) return null;
  const stack = failure.stack ? `\n${failure.stack}` : "";
  return new Error(
    `Hosted shell panel initialization failed during ${failure.trigger}: ${failure.message}${stack}`
  );
}

export async function ensureHostedShellReady(
  app: ElectronApplication,
  options: { panelSource: string; timeoutMs?: number }
): Promise<PanelReadinessSnapshot> {
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  let launchSessionId: string | null = null;
  let lastState: unknown = null;
  while (Date.now() < deadline) {
    try {
      const initializationError = panelInitializationFailureError(
        await readPanelInitializationFailure(app)
      );
      if (initializationError) throw initializationError;

      const launch = await app.evaluate(async (_electron, currentSessionId) => {
        const testApi = (globalThis as { __testApi?: Pick<TestApi, "rpcCall"> }).__testApi;
        if (!testApi) throw new Error("Test API not available");
        return currentSessionId
          ? testApi.rpcCall("workspace", "hostTargets.getLaunchSession", [currentSessionId])
          : testApi.rpcCall("workspace", "hostTargets.beginLaunch", ["electron"]);
      }, launchSessionId);
      if (launch && typeof launch === "object") {
        const sessionId = (launch as { sessionId?: unknown }).sessionId;
        if (typeof sessionId === "string") launchSessionId = sessionId;
        const approvals = (launch as { approvals?: unknown }).approvals;
        if (launchSessionId && Array.isArray(approvals) && approvals.length > 0) {
          await app.evaluate(async (_electron, id) => {
            const testApi = (globalThis as { __testApi?: Pick<TestApi, "rpcCall"> }).__testApi;
            if (!testApi) throw new Error("Test API not available");
            await testApi.rpcCall("workspace", "hostTargets.resolveLaunchSessionApproval", [
              id,
              "once",
            ]);
          }, launchSessionId);
        }
      }

      const panel = (await getPanelTree(app)).find(
        (entry) => entry.snapshot?.source === options.panelSource
      );
      if (panel) {
        const readiness = await getPanelReadiness(app, panel.id);
        lastState = readiness;
        if (readiness.terminal) return readiness;
      } else {
        lastState = { panelSource: options.panelSource, panel: "missing", launch };
      }
    } catch (error) {
      // Bootstrap navigation replaces Electron's automation context. Retry the
      // authoritative probes for that narrow race only. Product/service errors
      // are terminal diagnostics and must not be disguised as readiness waits.
      if (!isAutomationContextReplacement(error)) throw error;
      lastState = { error: error instanceof Error ? error.message : String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const surfaces = await app.evaluate(async ({ webContents }) =>
    Promise.all(
      webContents
        .getAllWebContents()
        .filter((contents) => !contents.isDestroyed())
        .map(async (contents) => {
          let documentState: { readyState: string; bodyText: string } | null = null;
          try {
            documentState = (await contents.executeJavaScript(
              `({ readyState: document.readyState, bodyText: (document.body?.innerText ?? "").slice(0, 2000) })`,
              true
            )) as { readyState: string; bodyText: string };
          } catch {
            // Non-DOM WebContents are still useful by type and URL.
          }
          return {
            id: contents.id,
            type: contents.getType(),
            url: contents.getURL(),
            title: contents.getTitle(),
            loading: contents.isLoading(),
            documentState,
          };
        })
    )
  );
  throw new Error(
    `Hosted shell did not reach terminal readiness for ${options.panelSource}: ${JSON.stringify({ lastState, surfaces })}`
  );
}

export async function readMainProcessErrors(
  app: ElectronApplication
): Promise<MainProcessErrorRecord[]> {
  return app.evaluate(() => {
    const testApi = (globalThis as { __testApi?: Pick<TestApi, "readMainProcessErrors"> })
      .__testApi;
    if (!testApi) throw new Error("Test API not available");
    return testApi.readMainProcessErrors();
  });
}

export async function clearMainProcessErrors(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const testApi = (globalThis as { __testApi?: Pick<TestApi, "clearMainProcessErrors"> })
      .__testApi;
    if (!testApi) throw new Error("Test API not available");
    testApi.clearMainProcessErrors();
  });
}

export async function assertNoMainProcessErrors(
  app: ElectronApplication,
  testInfo: TestInfo,
  label = "main-process-errors"
): Promise<void> {
  const errors = await readMainProcessErrors(app);
  await testInfo.attach(`${label}.json`, {
    body: JSON.stringify(errors, null, 2),
    contentType: "application/json",
  });
  expect(errors, "main process must not leak uncaught exceptions or unhandled rejections").toEqual(
    []
  );
}

export async function getPanelText(app: ElectronApplication, panelId: string): Promise<string> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as { __testApi?: { getPanelText: (id: string) => Promise<string> } }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.getPanelText(id);
  }, panelId);
}

export async function getPanelHtml(app: ElectronApplication, panelId: string): Promise<string> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as { __testApi?: { getPanelHtml: (id: string) => Promise<string> } }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.getPanelHtml(id);
  }, panelId);
}

export type PanelDiagnostic = {
  type: "console" | "did-fail-load" | "render-process-gone" | "unresponsive";
  level?: string;
  message: string;
  timestamp: number;
};

export interface PanelLayoutAudit {
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number };
  horizontalOverflow: Array<{
    tag: string;
    className: string;
    text: string;
    left: number;
    right: number;
    width: number;
  }>;
  verticalOverflow: Array<{
    tag: string;
    className: string;
    text: string;
    top: number;
    bottom: number;
    height: number;
  }>;
}

export async function startPanelDiagnostics(
  app: ElectronApplication,
  panelId: string
): Promise<void> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as { __testApi?: { startPanelDiagnostics: (id: string) => Promise<void> } }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.startPanelDiagnostics(id);
  }, panelId);
}

export async function getPanelDiagnostics(
  app: ElectronApplication,
  panelId: string
): Promise<PanelDiagnostic[]> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as { __testApi?: { getPanelDiagnostics: (id: string) => PanelDiagnostic[] } }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.getPanelDiagnostics(id);
  }, panelId);
}

export async function getPanelLayoutAudit(
  app: ElectronApplication,
  panelId: string
): Promise<PanelLayoutAudit> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as {
        __testApi?: { getPanelLayoutAudit: (id: string) => Promise<PanelLayoutAudit> };
      }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.getPanelLayoutAudit(id);
  }, panelId);
}

export async function getNativePanelSlotDebugInfo(app: ElectronApplication): Promise<
  Array<{
    nativeSlotId: string;
    panelId: string;
    bounds: { x: number; y: number; width: number; height: number };
    focused: boolean;
    ownerViewId: string;
    ownerGeneration: number;
  }>
> {
  return app.evaluate(async () => {
    const testApi = (
      globalThis as {
        __testApi?: {
          getNativePanelSlotDebugInfo: () => Array<{
            nativeSlotId: string;
            panelId: string;
            bounds: { x: number; y: number; width: number; height: number };
            focused: boolean;
            ownerViewId: string;
            ownerGeneration: number;
          }>;
        };
      }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.getNativePanelSlotDebugInfo();
  });
}

export async function clickPanelSelector(
  app: ElectronApplication,
  panelId: string,
  selector: string
): Promise<boolean> {
  return app.evaluate(
    async (_electron, args) => {
      const testApi = (
        globalThis as {
          __testApi?: { clickPanelSelector: (id: string, selector: string) => Promise<boolean> };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
      }
      return testApi.clickPanelSelector(args.panelId, args.selector);
    },
    { panelId, selector }
  );
}

export async function clickPanelText(
  app: ElectronApplication,
  panelId: string,
  selector: string,
  text: string
): Promise<boolean> {
  return app.evaluate(
    async (_electron, args) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            clickPanelText: (id: string, selector: string, text: string) => Promise<boolean>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
      }
      return testApi.clickPanelText(args.panelId, args.selector, args.text);
    },
    { panelId, selector, text }
  );
}

export async function executePanelScript<T = unknown>(
  app: ElectronApplication,
  panelId: string,
  script: string
): Promise<T> {
  return app.evaluate(
    async (_electron, args) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            executePanelScript: <T = unknown>(id: string, script: string) => Promise<T>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
      }
      return testApi.executePanelScript<T>(args.panelId, args.script);
    },
    { panelId, script }
  );
}

export async function getPanelSelectorWindowPoint(
  app: ElectronApplication,
  panelId: string,
  selector: string
): Promise<{ x: number; y: number } | null> {
  return app.evaluate(
    async (_electron, args) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            getPanelSelectorWindowPoint: (
              id: string,
              selector: string
            ) => Promise<{ x: number; y: number } | null>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
      }
      return testApi.getPanelSelectorWindowPoint(args.panelId, args.selector);
    },
    { panelId, selector }
  );
}

export async function typePanelText(
  app: ElectronApplication,
  panelId: string,
  text: string
): Promise<void> {
  return app.evaluate(
    async (_electron, args) => {
      const testApi = (
        globalThis as {
          __testApi?: { typePanelText: (id: string, text: string) => Promise<void> };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
      }
      return testApi.typePanelText(args.panelId, args.text);
    },
    { panelId, text }
  );
}

export async function setElectronClipboardText(
  app: ElectronApplication,
  text: string
): Promise<void> {
  return app.evaluate(({ clipboard }, value) => {
    clipboard.writeText(value);
  }, text);
}

export async function getElectronClipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

export async function callTerminalPanel<T = unknown>(
  app: ElectronApplication,
  panelId: string,
  method: string,
  args?: unknown
): Promise<T> {
  return app.evaluate(
    async (_electron, request) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            callTerminalPanel: (id: string, method: string, args?: unknown) => Promise<unknown>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
      }
      return testApi.callTerminalPanel(request.panelId, request.method, request.args) as Promise<T>;
    },
    { panelId, method, args }
  );
}

/**
 * Wait for the app to be ready (shell loaded and initial panels rendered).
 */
export async function waitForAppReady(window: Page, timeout = 15000): Promise<void> {
  // Wait for the shell to load
  await window.waitForSelector('[data-testid="panel-tree"]', { timeout });
}

/**
 * Take a screenshot of the current window for debugging.
 */
export async function takeScreenshot(window: Page, name: string): Promise<Buffer> {
  const projectRoot = path.resolve(__dirname, "../..");
  const screenshotDir = path.join(projectRoot, "test-results", "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });
  return window.screenshot({
    path: path.join(screenshotDir, `${name}.png`),
  });
}
