/**
 * Electron E2E test setup utilities.
 *
 * Provides helpers for launching the app with isolated test workspaces,
 * waiting for panels, and cleaning up after tests.
 */

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execFileSync } from "child_process";
import {
  WORKSPACE_SOURCE_DIRS,
  WORKSPACE_STATE_DIRS,
} from "@vibestudio/workspace-contracts/sourceDirs";
import type { PanelLifecycleResult } from "@vibestudio/shared/types";
import { CentralDataManager } from "@vibestudio/shared/centralData";

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
  /** Clean up the app and test workspace */
  cleanup: () => Promise<void>;
}

export interface TestExtensionRegistryEntry {
  name: string;
  status: "running" | "available" | "stopped" | "error" | "pending-approval" | "building";
  lastError: string | null;
}

interface TestPendingApproval {
  approvalId: string;
  kind: string;
  options?: Array<{ value: string; tone?: string; label?: string }>;
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
  /** Timeout for app launch in milliseconds (default: 30000) */
  launchTimeout?: number;
}

interface ManagedWorkspaceInfo {
  workspaceName: string;
  testRoot: string;
  env: Record<string, string>;
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

  try {
    for (const dir of Object.values(env)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(stateRoot, { recursive: true });

    for (const dir of WORKSPACE_SOURCE_DIRS) {
      const src = path.join(templateDir, dir);
      const dest = path.join(sourceRoot, dir);
      if (fs.existsSync(src)) {
        fs.cpSync(src, dest, { recursive: true });
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
      // The harness owns the isolated hub, so exercise deterministic ordered
      // shutdown instead of opening the interactive desktop quit-policy dialog.
      centralData.setKeepServerOnQuit(false);
    } finally {
      centralData.close();
    }

    return workspaceDir;
  } catch (error) {
    fs.rmSync(testRoot, { recursive: true, force: true });
    throw error;
  }
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
  const { workspace, initialPanel, devTools = false, env = {}, launchTimeout = 120000 } = options;

  const projectRoot = path.resolve(__dirname, "../..");
  const workspacePath = workspace ?? createManagedTestWorkspace(projectRoot);
  const workspaceInfo = getWorkspaceInfo(workspacePath);
  const ownsWorkspace = workspace === undefined;

  let app: ElectronApplication | undefined;
  let child: ReturnType<ElectronApplication["process"]> | undefined;
  let cleaned = false;
  const output: string[] = [];

  // Cleanup function with timeout to prevent hanging
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const appProcess = child;
    const mainPid = appProcess?.pid;
    const readyFile = path.join(
      getCentralDataDirFromEnv(workspaceInfo.env),
      "server-auth",
      "hub-ready.json"
    );
    const detachedServerPid = readReadyFilePid(readyFile);
    // Capture dedicated descendant process groups before graceful shutdown can
    // reparent their members. Workspace servers deliberately own detached
    // groups so native builds, workerd, model engines, and extension children
    // can be drained as one lifecycle unit even if the group leader exits first.
    const ownedProcessGroups = collectOwnedProcessGroups([mainPid, detachedServerPid]);
    // Use a timeout to prevent hanging on app.close()
    const closeWithTimeout = async (timeoutMs: number): Promise<void> => {
      return Promise.race([
        app.close(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("App close timed out")), timeoutMs)
        ),
      ]);
    };

    if (app) {
      try {
        // Main owns an ordered 15-second shutdown budget. Give that path time
        // to stop the local hub before falling back to a process-tree kill.
        await closeWithTimeout(20_000);
      } catch (error) {
        console.warn("[TestSetup] Graceful close failed, force killing:", error);
        // Force kill the whole process tree if graceful close fails. Killing only the Electron
        // parent can orphan workerd/extension children under the user session.
        try {
          killProcessTree(mainPid, "SIGKILL");
          await waitForProcessExit(mainPid, 3000);
        } catch {
          // Process may already be dead
        }
      }
    }

    await stopOwnedProcessGroups(ownedProcessGroups);
    await cleanupKnownChildProcesses(mainPid);
    killProcessTree(detachedServerPid, "SIGTERM");
    if (!(await waitForProcessExit(detachedServerPid, 3000))) {
      killProcessTree(detachedServerPid, "SIGKILL");
      await waitForProcessExit(detachedServerPid, 3000);
    }
    // A server forced out during its shutdown budget can leave workerd
    // reparented before the process-tree walk observes it. The config path is
    // server-PID-specific, so clean and await those exact children as the final
    // ownership-safe fallback.
    await cleanupKnownChildProcesses(detachedServerPid);

    if (ownsWorkspace) {
      try {
        await removeManagedTestWorkspaceWithRetry(workspacePath);
      } catch (error) {
        console.warn("[TestSetup] Error removing workspace:", error);
      }
    }
  };

  try {
    // Determine the main entry point
    const mainPath = path.resolve(projectRoot, "dist", "main.cjs");

    if (!fs.existsSync(mainPath)) {
      throw new Error(
        `Main entry point not found at ${mainPath}. Make sure to run 'pnpm build' before running E2E tests.`
      );
    }

    if (!hasElectronDisplay()) {
      throw new Error(ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);
    }

    // Build electron args - first arg is the app entry point
    const electronPath = require("electron") as string;
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

    app = await electron.launch({
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
    child = app.process();
    child.stdout?.on("data", (chunk) => output.push(String(chunk)));
    child.stderr?.on("data", (chunk) => output.push(String(chunk)));

    const window = await app.firstWindow({ timeout: launchTimeout });
    await window.waitForLoadState("domcontentloaded");
    await waitForTestApiReady(app, launchTimeout, output);

    if (devTools) {
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.openDevTools();
      });
    }

    return { app, window, workspacePath, cleanup };
  } catch (error) {
    const details = tailDiagnosticText(output.join(""));
    const hubLog = readDiagnosticFileTail(
      path.join(getCentralDataDirFromEnv(workspaceInfo.env), "logs", "hub.log")
    );
    await cleanup();
    const message = error instanceof Error ? error.message : String(error);
    if ((!details && !hubLog) || message.includes("Electron output before")) throw error;
    const diagnostics = [
      hubLog ? `Detached hub log before launch failure:\n${hubLog}` : "",
      details ? `Electron output before launch failure:\n${details}` : "",
    ].filter(Boolean);
    throw new Error(`${message}\n\n${diagnostics.join("\n\n")}`, { cause: error });
  }
}

function readDiagnosticFileTail(file: string): string {
  try {
    return tailDiagnosticText(fs.readFileSync(file, "utf8"));
  } catch {
    return "";
  }
}

function tailDiagnosticText(value: string, maxChars = 24_000): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `[... ${trimmed.length - maxChars} earlier characters omitted ...]\n${trimmed.slice(-maxChars)}`;
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
    return true;
  } catch {
    return false;
  }
}

function collectOwnedProcessGroups(rootPids: Array<number | undefined>): number[] {
  if (process.platform === "win32") return [];
  const ownedPids = new Set<number>();
  for (const rootPid of rootPids) {
    if (!rootPid || rootPid <= 0) continue;
    ownedPids.add(rootPid);
    for (const childPid of collectChildPids(rootPid)) ownedPids.add(childPid);
  }
  if (ownedPids.size === 0) return [];

  let stdout = "";
  try {
    stdout = execFileSync("ps", ["-o", "pid=,pgid=", "-p", [...ownedPids].join(",")], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }

  const groups = new Set<number>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!match) continue;
    const pgid = Number(match[2]);
    // A dedicated group is owned only when its leader is inside the captured
    // process tree. This excludes Playwright's/session shell's ambient group.
    if (pgid > 1 && ownedPids.has(pgid)) groups.add(pgid);
  }
  return [...groups];
}

async function stopOwnedProcessGroups(groups: number[]): Promise<void> {
  if (process.platform === "win32" || groups.length === 0) return;
  for (const pgid of groups) signalProcessGroup(pgid, "SIGTERM");
  await Promise.all(groups.map((pgid) => waitForProcessGroupExit(pgid, 3000)));
  const survivors = groups.filter(isProcessGroupAlive);
  for (const pgid of survivors) signalProcessGroup(pgid, "SIGKILL");
  await Promise.all(survivors.map((pgid) => waitForProcessGroupExit(pgid, 3000)));
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pgid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessGroupAlive(pgid);
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

async function cleanupKnownChildProcesses(ownerPid: number | undefined): Promise<void> {
  if (!ownerPid || process.platform === "win32") return;
  const workerdConfigPath = `/tmp/vibestudio-workerd-${ownerPid}/config.capnp`;
  const pids = findPidsByCommand(workerdConfigPath);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await Promise.all(pids.map((pid) => waitForProcessExit(pid, 3000)));
  const survivors = pids.filter(isProcessAlive);
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await Promise.all(survivors.map((pid) => waitForProcessExit(pid, 3000)));
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
export async function getPanelTree(
  app: ElectronApplication
): Promise<
  Array<{ id: string; title: string; children: unknown[]; snapshot?: { source?: string } }>
> {
  return app.evaluate(() => {
    const testApi = (globalThis as { __testApi?: { getPanelTree: () => unknown[] } }).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.getPanelTree();
  }) as Promise<
    Array<{ id: string; title: string; children: unknown[]; snapshot?: { source?: string } }>
  >;
}

/** Read extension lifecycle state through the same authenticated RPC path as the shell. */
export async function getExtensionRegistry(
  app: ElectronApplication
): Promise<TestExtensionRegistryEntry[]> {
  return testRpcCall(app, "extensions", "list", []) as Promise<TestExtensionRegistryEntry[]>;
}

/** Call server RPC through the main-process test bridge and its authenticated shell path. */
export async function testRpcCall(
  app: ElectronApplication,
  service: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return app.evaluate(
    async (_electron, request) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
      }
      return testApi.rpcCall(request.service, request.method, request.args);
    },
    { service, method, args }
  );
}

/** Resolve every currently presented shell approval using its primary non-dangerous choice. */
export async function resolvePendingShellApprovals(app: ElectronApplication): Promise<void> {
  const pending = (await testRpcCall(app, "shellApproval", "listPending", []).catch(
    () => []
  )) as Array<{
    approvalId: string;
    kind: string;
    options?: Array<{ value: unknown; tone?: unknown; label?: unknown }>;
  }>;
  for (const raw of pending) {
    const approval: TestPendingApproval = {
      approvalId: raw.approvalId,
      kind: raw.kind,
      options: Array.isArray(raw.options)
        ? raw.options.map((option) => ({
            value: String(option.value),
            tone: typeof option.tone === "string" ? option.tone : undefined,
            label: typeof option.label === "string" ? option.label : undefined,
          }))
        : undefined,
    };
    if (approval.kind === "userland") {
      const choice =
        approval.options?.find((option) => option.tone === "primary")?.value ??
        approval.options?.find((option) => option.tone !== "danger")?.value ??
        approval.options?.[0]?.value;
      if (!choice) throw new Error(`Userland approval ${approval.approvalId} has no options`);
      await testRpcCall(app, "shellApproval", "resolveUserland", [approval.approvalId, choice]);
    } else {
      await testRpcCall(app, "shellApproval", "resolve", [approval.approvalId, "session"]);
    }
  }
}

/** Cross the native workspace/host-target startup gate, then resolve queued shell approvals. */
export async function approvePendingStartupWork(app: ElectronApplication): Promise<void> {
  const launchSession = await testRpcCall(app, "workspace", "hostTargets.beginLaunch", [
    "electron",
  ]).catch(() => null);
  if (
    launchSession &&
    typeof launchSession === "object" &&
    "sessionId" in launchSession &&
    typeof launchSession.sessionId === "string" &&
    "approvals" in launchSession &&
    Array.isArray(launchSession.approvals) &&
    launchSession.approvals.length > 0
  ) {
    await testRpcCall(app, "workspace", "hostTargets.resolveLaunchSessionApproval", [
      launchSession.sessionId,
      "once",
    ]);
  }
  await resolvePendingShellApprovals(app);
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

/**
 * Check if a panel's view is loaded.
 */
export async function isPanelLoaded(app: ElectronApplication, panelId: string): Promise<boolean> {
  return app.evaluate((_electron, id) => {
    const testApi = (globalThis as { __testApi?: { isPanelLoaded: (id: string) => boolean } })
      .__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure VIBESTUDIO_TEST_MODE=1 is set.");
    }
    return testApi.isPanelLoaded(id);
  }, panelId);
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
