import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertClaudeCodeVersion } from "@vibestudio/shared/claudeLaunchProfile";
import { canonicalJson } from "@vibestudio/content-addressing";
import { domainHash } from "@vibestudio/shared/execution/identity";
import {
  NativeDevelopmentExecutorUnavailableError,
  UnavailableNativeDevelopmentToolDriver,
  type NativeDevelopmentProcessIdentity,
  type NativeDevelopmentToolDriver,
  type NativeDevelopmentToolHandle,
} from "./nativeDevelopmentExecutor.js";
import { NativeDevelopmentTerminalRegistry } from "./nativeDevelopmentTerminal.js";

const execFileAsync = promisify(execFile);
const GROUP_SETTLE_TIMEOUT_MS = 5_000;
const GRACEFUL_STOP_TIMEOUT_MS = 5_000;

interface ExactClaudeExecutable {
  cliPath: string;
  cliDigest: string;
  executablePath: string;
  executableDigest: string;
  argvPrefix: string[];
  version: string;
  identityDigest: string;
}

/**
 * Resolve a real local Claude Code driver once. The returned driver never
 * consults PATH again; every launch re-verifies the sealed executable bytes.
 */
export async function createLocalClaudeCodeDevelopmentDriver(input: {
  executorId: string;
  candidatePaths?: readonly string[];
  hostClaudeConfigDirectory?: string;
  terminalRegistry?: NativeDevelopmentTerminalRegistry;
}): Promise<NativeDevelopmentToolDriver> {
  if (process.platform !== "linux") {
    return new UnavailableNativeDevelopmentToolDriver(
      "claude-code",
      input.executorId,
      "platform-unsupported"
    );
  }
  try {
    const executable = await resolveExactClaudeExecutable(input.candidatePaths);
    return new LocalClaudeCodeDevelopmentDriver({
      executorId: input.executorId,
      executable,
      hostClaudeConfigDirectory:
        input.hostClaudeConfigDirectory ??
        process.env["CLAUDE_CONFIG_DIR"] ??
        (process.env["HOME"] ? path.join(process.env["HOME"], ".claude") : null),
      terminalRegistry: input.terminalRegistry ?? new NativeDevelopmentTerminalRegistry(),
    });
  } catch (error) {
    if (error instanceof NativeDevelopmentExecutorUnavailableError) {
      return new UnavailableNativeDevelopmentToolDriver(
        "claude-code",
        input.executorId,
        error.reason
      );
    }
    return new UnavailableNativeDevelopmentToolDriver(
      "claude-code",
      input.executorId,
      "not-installed"
    );
  }
}

class LocalClaudeCodeDevelopmentDriver implements NativeDevelopmentToolDriver {
  readonly toolId = "claude-code" as const;
  readonly executorId: string;
  readonly terminalSurface: NativeDevelopmentTerminalRegistry;

  constructor(
    private readonly config: {
      executorId: string;
      executable: ExactClaudeExecutable;
      hostClaudeConfigDirectory: string | null;
      terminalRegistry: NativeDevelopmentTerminalRegistry;
    }
  ) {
    this.executorId = config.executorId;
    this.terminalSurface = config.terminalRegistry;
  }

  async availability(): Promise<
    | { available: true }
    | {
        available: false;
        reason: NativeDevelopmentExecutorUnavailableError["reason"];
      }
  > {
    try {
      await verifyExactExecutable(this.config.executable);
      return { available: true };
    } catch {
      return { available: false, reason: "not-installed" };
    }
  }

  async launch(input: {
    sessionId: string;
    ownedRootId: string;
    repositoryRoot: string;
    homeRoot: string;
  }): Promise<NativeDevelopmentToolHandle> {
    await verifyExactExecutable(this.config.executable);
    const claudeConfigRoot = path.join(input.homeRoot, ".claude");
    await fs.mkdir(claudeConfigRoot, { recursive: true, mode: 0o700 });
    await copyCredentialIfPresent(this.config.hostClaudeConfigDirectory, claudeConfigRoot);
    const environment = nativeClaudeEnvironment(input.homeRoot, claudeConfigRoot);
    const projected = await projectExactExecutable(this.config.executable, input.homeRoot);
    const projectionRoot = path.join(input.homeRoot, ".vibestudio-toolchain");
    let launchedTerminalId: string | null = null;
    try {
      const terminal = this.terminalSurface.launch({
        ownerSessionId: input.sessionId,
        executable: projected.executablePath,
        args: projected.argvPrefix,
        cwd: input.repositoryRoot,
        env: environment,
      });
      launchedTerminalId = terminal.terminalSessionId;
      const pid = terminal.pid;
      const processCoordinate = await waitForExactProcessGroupLeader(pid);
      const identity: NativeDevelopmentProcessIdentity = {
        ownershipToken: domainHash(
          "vibestudio/native-claude-process-owner/v1",
          canonicalJson({
            executorId: this.executorId,
            sessionId: input.sessionId,
            ownedRootId: input.ownedRootId,
            executableIdentity: this.config.executable.identityDigest,
            pid,
            startTime: processCoordinate.startTime,
            nonce: randomBytes(24).toString("base64url"),
          })
        ),
        processId: `linux-pgid:${pid}:start:${processCoordinate.startTime}`,
        terminalSessionId: terminal.terminalSessionId,
      };
      return new LocalClaudeCodeHandle({
        pid,
        startTime: processCoordinate.startTime,
        identity,
        exit: terminal.exit,
        terminalRegistry: this.terminalSurface,
        terminalSessionId: terminal.terminalSessionId,
        ownerSessionId: input.sessionId,
        projectionRoot,
      });
    } catch (error) {
      if (launchedTerminalId) {
        try {
          this.terminalSurface.abortLaunch(launchedTerminalId, input.sessionId);
        } catch {
          // The provider records the launch failure; a separately observed
          // cleanup failure remains represented by the owned root repair.
        }
      }
      // No live exact handle will exist for the provider to retire. Restore
      // write permission on only this session-owned projection so rollback can
      // remove the private home tree.
      await fs.chmod(projectionRoot, 0o700).catch(() => undefined);
      throw error;
    }
  }
}

class LocalClaudeCodeHandle implements NativeDevelopmentToolHandle {
  readonly identity: NativeDevelopmentProcessIdentity;
  private stopped = false;
  private frozen = false;
  private readonly exit: Promise<void>;

  constructor(
    private readonly owned: {
      pid: number;
      startTime: string;
      identity: NativeDevelopmentProcessIdentity;
      exit: Promise<void>;
      terminalRegistry: NativeDevelopmentTerminalRegistry;
      terminalSessionId: string;
      ownerSessionId: string;
      projectionRoot: string;
    }
  ) {
    this.identity = owned.identity;
    this.exit = owned.exit;
  }

  async freezeForCheckpoint(): Promise<void> {
    this.assertLive();
    await this.assertExactLeader();
    signalExactGroup(this.owned.pid, "SIGSTOP");
    try {
      await waitForProcessGroupState(
        this.owned.pid,
        (members) => members.length > 0 && members.every(({ state }) => isStoppedState(state))
      );
      this.frozen = true;
    } catch (error) {
      // A failed proof must not strand a group we may have stopped.
      try {
        signalExactGroup(this.owned.pid, "SIGCONT");
      } catch {
        // The caller records the primary freeze failure and recovery outcome.
      }
      throw error;
    }
  }

  async resumeCheckpoint(): Promise<void> {
    this.assertLive();
    await this.assertExactLeader();
    signalExactGroup(this.owned.pid, "SIGCONT");
    await waitForProcessGroupState(
      this.owned.pid,
      (members) => members.length > 0 && members.every(({ state }) => !isStoppedState(state))
    );
    this.frozen = false;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if ((await processGroupMembers(this.owned.pid)).length === 0) {
      this.stopped = true;
      return;
    }
    try {
      await this.assertExactLeader();
    } catch (error) {
      // The terminal can exit after the group scan but before the coordinate
      // proof. Absence is a settled stop, never evidence that a replacement
      // process should be signalled.
      if ((error as { code?: unknown }).code === "EPROCESS_EXITED") {
        this.stopped = true;
        return;
      }
      throw error;
    }
    if (this.frozen) {
      signalExactGroup(this.owned.pid, "SIGCONT");
      this.frozen = false;
    }
    signalExactGroup(this.owned.pid, "SIGTERM");
    const graceful = await Promise.race([
      this.exit.then(() => true),
      delay(GRACEFUL_STOP_TIMEOUT_MS).then(() => false),
    ]);
    const remaining = await processGroupMembers(this.owned.pid);
    if (!graceful || remaining.length > 0) {
      if (!graceful) await this.assertExactLeader();
      signalExactGroup(this.owned.pid, "SIGKILL");
      await this.exit;
    }
    await waitForProcessGroupState(this.owned.pid, (members) => members.length === 0);
    this.stopped = true;
  }

  async retire(): Promise<void> {
    await this.stop();
    // The exact projection is deliberately non-writable while the tool can
    // execute it. Retirement restores write permission only on this
    // session-owned directory so the provider can remove the owned home tree.
    await fs.chmod(this.owned.projectionRoot, 0o700);
    this.owned.terminalRegistry.retire(this.owned.terminalSessionId, this.owned.ownerSessionId);
  }

  private assertLive(): void {
    if (this.stopped) {
      throw coded("EPROCESS_EXITED", "Owned Claude Code process has exited");
    }
  }

  private async assertExactLeader(): Promise<void> {
    const coordinate = await readProcessCoordinate(this.owned.pid);
    if (
      coordinate.processGroupId !== this.owned.pid ||
      coordinate.startTime !== this.owned.startTime
    ) {
      throw coded("EOWNERSHIP", "Claude Code process-group identity no longer matches");
    }
  }
}

async function resolveExactClaudeExecutable(
  explicitCandidates: readonly string[] | undefined
): Promise<ExactClaudeExecutable> {
  const candidates =
    explicitCandidates && explicitCandidates.length > 0
      ? [...explicitCandidates]
      : executableCandidates("claude");
  let cliPath: string | null = null;
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const resolved = await fs.realpath(candidate);
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) continue;
      await fs.access(resolved, fsConstants.X_OK);
      cliPath = resolved;
      break;
    } catch {
      // Try the next host-owned candidate.
    }
  }
  if (!cliPath) {
    throw new NativeDevelopmentExecutorUnavailableError("claude-code", "local", "not-installed");
  }
  const cliBytes = await fs.readFile(cliPath);
  const cliDigest = sha256(cliBytes);
  const nodeScript = /^#![^\n]*(?:env\s+)?node(?:\s|$)/u.test(
    cliBytes.subarray(0, 256).toString("utf8")
  );
  const executablePath = nodeScript ? await fs.realpath(process.execPath) : cliPath;
  const executableDigest = sha256(await fs.readFile(executablePath));
  const argvPrefix = nodeScript ? [cliPath] : [];
  let version: string;
  try {
    version = await assertClaudeCodeVersion(async () => {
      const result = await execFileAsync(executablePath, [...argvPrefix, "--version"], {
        env: exactVersionEnvironment(executablePath),
        timeout: 15_000,
        windowsHide: true,
      });
      return result.stdout.trim();
    });
  } catch {
    throw new NativeDevelopmentExecutorUnavailableError(
      "claude-code",
      "local",
      "version-unsupported"
    );
  }
  const identityDigest = domainHash(
    "vibestudio/native-claude-executable/v1",
    canonicalJson({
      cliPath,
      cliDigest,
      executablePath,
      executableDigest,
      version,
      platform: process.platform,
      arch: process.arch,
    })
  );
  return {
    cliPath,
    cliDigest,
    executablePath,
    executableDigest,
    argvPrefix,
    version,
    identityDigest,
  };
}

async function verifyExactExecutable(executable: ExactClaudeExecutable): Promise<void> {
  const [cliPath, executablePath] = await Promise.all([
    fs.realpath(executable.cliPath),
    fs.realpath(executable.executablePath),
  ]);
  if (
    cliPath !== executable.cliPath ||
    executablePath !== executable.executablePath ||
    sha256(await fs.readFile(cliPath)) !== executable.cliDigest ||
    sha256(await fs.readFile(executablePath)) !== executable.executableDigest
  ) {
    throw coded("EIDENTITYDRIFT", "The reviewed Claude Code executable changed");
  }
}

async function projectExactExecutable(
  executable: ExactClaudeExecutable,
  homeRoot: string
): Promise<{ executablePath: string; argvPrefix: string[] }> {
  await verifyExactExecutable(executable);
  const projectionRoot = path.join(homeRoot, ".vibestudio-toolchain");
  await fs.mkdir(projectionRoot, { mode: 0o700 });
  const projectedCli = path.join(projectionRoot, "claude-code");
  await ensureExactProjection(executable.cliPath, projectedCli, executable.cliDigest);
  if (executable.argvPrefix.length === 0) {
    await fs.chmod(projectionRoot, 0o500);
    return { executablePath: projectedCli, argvPrefix: [] };
  }
  const projectedExecutable = path.join(projectionRoot, "node");
  await ensureExactProjection(
    executable.executablePath,
    projectedExecutable,
    executable.executableDigest
  );
  await fs.chmod(projectionRoot, 0o500);
  return { executablePath: projectedExecutable, argvPrefix: [projectedCli] };
}

async function ensureExactProjection(
  source: string,
  destination: string,
  expectedDigest: string
): Promise<void> {
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || sha256(await fs.readFile(destination)) !== expectedDigest) {
      throw coded("EIDENTITYDRIFT", "Existing projected tool bytes do not match the reviewed tool");
    }
    await fs.chmod(destination, 0o500);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
  if (sha256(await fs.readFile(destination)) !== expectedDigest) {
    throw coded("EIDENTITYDRIFT", "Projected tool bytes failed verification");
  }
  await fs.chmod(destination, 0o500);
}

function executableCandidates(name: string): string[] {
  const pathValue = process.env["PATH"] ?? "";
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.resolve(directory, name));
}

function nativeClaudeEnvironment(homeRoot: string, claudeConfigRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    CLAUDE_CONFIG_DIR: claudeConfigRoot,
    PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  };
  for (const key of ["LANG", "LC_ALL", "TERM", "COLORTERM"] as const) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

function exactVersionEnvironment(executablePath: string): NodeJS.ProcessEnv {
  return {
    PATH: `${path.dirname(executablePath)}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  };
}

async function copyCredentialIfPresent(
  hostClaudeConfigDirectory: string | null,
  isolatedClaudeConfigDirectory: string
): Promise<void> {
  if (!hostClaudeConfigDirectory) return;
  try {
    const bytes = await fs.readFile(path.join(hostClaudeConfigDirectory, ".credentials.json"));
    await fs.writeFile(path.join(isolatedClaudeConfigDirectory, ".credentials.json"), bytes, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function signalExactGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

interface ProcessCoordinate {
  processGroupId: number;
  state: string;
  startTime: string;
}

async function readProcessCoordinate(pid: number): Promise<ProcessCoordinate> {
  let text: string;
  try {
    text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      throw coded("EPROCESS_EXITED", `Owned process ${pid} no longer exists`);
    }
    throw error;
  }
  const close = text.lastIndexOf(")");
  if (close < 0) throw coded("EINTEGRITY", `Invalid /proc coordinate for ${pid}`);
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  const processGroupId = Number(fields[2]);
  const startTime = fields[19];
  if (!state || !Number.isSafeInteger(processGroupId) || processGroupId < 0 || !startTime) {
    throw coded("EINTEGRITY", `Invalid /proc coordinate for ${pid}`);
  }
  return { processGroupId, state, startTime };
}

async function waitForExactProcessGroupLeader(pid: number): Promise<ProcessCoordinate> {
  const deadline = Date.now() + GROUP_SETTLE_TIMEOUT_MS;
  let startTime: string | null = null;
  for (;;) {
    const coordinate = await readProcessCoordinate(pid);
    startTime ??= coordinate.startTime;
    if (coordinate.startTime !== startTime) {
      throw coded("EOWNERSHIP", "Claude Code process identity changed during launch");
    }
    if (coordinate.processGroupId === pid) return coordinate;
    if (Date.now() >= deadline) {
      throw coded("EOWNERSHIP", "Claude Code did not become its own process-group leader");
    }
    await delay(10);
  }
}

async function processGroupMembers(
  processGroupId: number
): Promise<Array<{ pid: number; state: string }>> {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const observed = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        try {
          const coordinate = await readProcessCoordinate(pid);
          return coordinate.processGroupId === processGroupId
            ? { pid, state: coordinate.state }
            : null;
        } catch (error) {
          if ((error as { code?: unknown }).code === "EPROCESS_EXITED") return null;
          throw error;
        }
      })
  );
  return observed
    .filter((member): member is { pid: number; state: string } => member !== null)
    .sort((left, right) => left.pid - right.pid);
}

async function waitForProcessGroupState(
  processGroupId: number,
  predicate: (members: Array<{ pid: number; state: string }>) => boolean
): Promise<void> {
  const deadline = Date.now() + GROUP_SETTLE_TIMEOUT_MS;
  do {
    if (predicate(await processGroupMembers(processGroupId))) return;
    await delay(10);
  } while (Date.now() < deadline);
  throw coded(
    "EPROCESS_STATE",
    `Owned process group ${processGroupId} did not reach the required state`
  );
}

function isStoppedState(state: string): boolean {
  return state === "T" || state === "t";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
