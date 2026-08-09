import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@vibestudio/extension";
import {
  assertClaudeCodeVersion,
  claudeLaunchProfile,
  materializeClaudeLaunch,
  reconcileClaudeLaunchCredential,
  removeMaterializedClaudeLaunch,
  type ClaudeLaunchProfile,
  type MaterializedClaudeLaunch,
} from "@vibestudio/shared/claudeLaunchProfile";
import { confineClaudeReadOnly } from "@vibestudio/shared/claudeReadOnlyLaunch";
import {
  launchAgentIntoChannel,
  subagentFirstTaskPrompt,
  subagentRuntimePrompt,
  type AgentLaunchRpc,
} from "@workspace/agentic-core";
import { toServerBaseUrl } from "./gateway.js";

const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
const LINKED_AGENT_SOURCE = "workers/linked-agent";
const LINKED_AGENT_CLASS = "LinkedAgentWorker";

function error(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Durable per-launch bookkeeping, stored in extension storage. */
interface LaunchRecord {
  launchId: string;
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  agentId: string | null;
  preparedAt: string;
}

/** Subagent task-duty binding threaded into the linked vessel's state
 *  (docs/claude-code-channels-plan.md §8.2). When present, the vessel owns
 *  `complete` → terminal-settle back to the parent, and the per-launch approval
 *  gate is skipped (the parent's spawn is the authorization; depth/fan-out gate
 *  it, not a human prompt). Shape mirrors agentic-core's SubagentIdentity. */
export interface PrepareSubagentBinding {
  runId: string;
  task: string;
  parentRef: string;
  parentChannelId: string;
  parentContextId: string;
  depth: number;
  mode?: "fresh" | "fork";
}

/** The awaited return of {@link prepare}. */
export interface PrepareResult {
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  /** Canonical entity id of the linked vessel DO (its RPC caller identity) —
   *  used by a spawning parent as the subagent run's childEntityId. */
  vesselEntityId: string;
  /** The linked vessel's participant id on the channel (task-seed addressing). */
  vesselParticipantId: string | null;
  /** Portable semantic declaration. Host reach and paths are materialized only
   * on the machine that actually executes Claude. */
  profile: ClaudeLaunchProfile;
}

/** Claude Code CLI options a parent may set per subagent launch (the
 *  `spawn_subagent` tool's `config` for agentKind 'claude-code'). Whitelisted:
 *  unknown keys are dropped, values are validated so a config value can never
 *  smuggle an extra flag into the argv. */
export interface SubagentCliOptions {
  /** `--model`: alias ('opus', 'sonnet', 'haiku') or a full model name. */
  model?: string;
  /** `--effort`: reasoning effort for the session. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** `--permission-mode`. Defaults to 'auto': the child runs autonomously —
   *  the parent's spawn is the authorization, and a headless `-p` run blocked
   *  on interactive permission prompts would hang the subagent. */
  permissionMode?: "auto" | "acceptEdits" | "bypassPermissions" | "manual" | "dontAsk" | "plan";
  /** `--fallback-model`: automatic fallback when the model is overloaded. */
  fallbackModel?: string;
  /** `--max-budget-usd`: hard spend ceiling for the session. */
  maxBudgetUsd?: number;
}

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const PERMISSION_MODES = new Set([
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
]);

/** Map whitelisted {@link SubagentCliOptions} onto `claude` argv flags. */
export function subagentCliArgs(options: Record<string, unknown> | undefined): string[] {
  const o = (options ?? {}) as Record<string, unknown>;
  // A value that parses as a flag would reorder the argv contract; refuse it.
  const flagSafe = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0 && !v.startsWith("-");
  const args: string[] = [];
  const mode =
    typeof o["permissionMode"] === "string" && PERMISSION_MODES.has(o["permissionMode"])
      ? o["permissionMode"]
      : "auto";
  args.push("--permission-mode", mode);
  if (flagSafe(o["model"])) args.push("--model", o["model"]);
  if (typeof o["effort"] === "string" && EFFORT_LEVELS.has(o["effort"])) {
    args.push("--effort", o["effort"]);
  }
  if (flagSafe(o["fallbackModel"])) args.push("--fallback-model", o["fallbackModel"]);
  const budget = o["maxBudgetUsd"];
  if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
    args.push("--max-budget-usd", String(budget));
  }
  return args;
}

export interface LaunchSubagentInput {
  channelId: string;
  title?: string;
  /** Launcher CLI options (see {@link SubagentCliOptions}); forwarded from the
   *  parent's `spawn_subagent` config, whitelisted here. */
  options?: Record<string, unknown>;
  subagent: PrepareSubagentBinding;
}

export interface LaunchSubagentResult {
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  vesselEntityId: string;
  vesselParticipantId: string | null;
  launchId: string;
  /** Exact preparation generation owned by this process. */
  generationId: string;
  pid: number | null;
  logPath: string;
}

export interface InspectLaunchResult {
  entityId: string;
  generationId: string;
  launchId: string;
  runId: string;
  state: "running" | "exited";
  pid: number | null;
  exit?: {
    code: number | null;
    signal: string | null;
    at: string;
  };
  completion?: {
    source: "stream-result";
    outcome: "success" | "failed";
    report: string;
  };
  log: {
    bytes: number;
    tail: string;
    truncated: boolean;
  };
}

interface ResolvedService {
  kind: string;
  targetId?: string;
}

const CONTROLLER_CALLER_ID = "@workspace-extensions/claude-code";
const MAX_COMPLETION_REPORT_BYTES = 16_384;

export interface ClaudeStreamCompletion {
  source: "stream-result";
  outcome: "success" | "failed";
  report: string;
}

function boundedUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  return `…${bytes.subarray(bytes.byteLength - maxBytes + 3).toString("utf8")}`;
}

/**
 * Extract Claude Code's authoritative terminal record from a bounded JSONL
 * tail. Stderr may be interleaved with stdout, so malformed/non-JSON lines are
 * ignored and only an outer `type:"result"` record can settle a run.
 */
export function parseClaudeStreamCompletion(logTail: string): ClaudeStreamCompletion | null {
  const lines = logTail.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith("{")) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record["type"] !== "result") continue;
    const success = record["subtype"] === "success" && record["is_error"] !== true;
    const rawReport =
      typeof record["result"] === "string" && record["result"].trim()
        ? record["result"].trim()
        : success
          ? "Claude Code completed successfully without a textual report."
          : `Claude Code terminal result reported ${String(record["subtype"] ?? "failure")}.`;
    return {
      source: "stream-result",
      outcome: success ? "success" : "failed",
      report: boundedUtf8Tail(rawReport, MAX_COMPLETION_REPORT_BYTES),
    };
  }
  return null;
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;

export async function activate(ctx: ExtensionContext) {
  interface HeadlessLaunch {
    entityId: string;
    generationId: string;
    launchId: string;
    runId: string;
    vesselRef: string;
    child: ChildProcess;
    logPath: string;
  }

  const headlessLaunches = new Map<string, HeadlessLaunch>();
  const terminalLaunches = new Map<string, InspectLaunchResult>();
  const materializedLaunches = new Map<string, MaterializedClaudeLaunch>();
  const terminateHeadlessLaunches = () => {
    for (const launch of headlessLaunches.values()) {
      try {
        launch.child.kill("SIGTERM");
      } catch {
        /* process is already gone */
      }
    }
  };
  process.once("exit", terminateHeadlessLaunches);
  ctx.subscriptions.push({
    dispose() {
      process.off("exit", terminateHeadlessLaunches);
      terminateHeadlessLaunches();
    },
  });

  const rpc: AgentLaunchRpc = {
    call: <T>(target: string, method: string, args: unknown[]): Promise<T> =>
      ctx.rpc.call<T>(target, method, ...args),
  };

  // ── Storage helpers (bidirectional channel↔context↔entity bookkeeping) ──
  // Context→channel has no host enumeration surface (there is no channel
  // registry and entity records carry no channelId), so we record the binding
  // here at prepare time and serve resolvePrimaryChannel/adaptLaunch from it.
  const enc = (v: string): string => encodeURIComponent(v);
  const channelKey = (id: string): string => `channels/${enc(id)}.json`;
  const entityKey = (id: string): string => `entities/${enc(id)}.json`;
  const contextKey = (id: string): string => `contexts/${enc(id)}.json`;
  const launchKey = (id: string): string => `launches/${enc(id)}.json`;
  const terminalLaunchKey = (entityId: string, generationId: string): string =>
    `${entityId}\u0000${generationId}`;

  async function readJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await ctx.storage.readFile(key, "utf8");
      return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as T;
    } catch {
      return null;
    }
  }
  async function writeJson(key: string, value: unknown): Promise<void> {
    const dir = path.posix.dirname(key);
    await ctx.storage.mkdir(dir, { recursive: true });
    await ctx.storage.writeFile(key, JSON.stringify(value, null, 2));
  }

  async function resolveChannelTarget(channelId: string): Promise<string> {
    const resolved = (await ctx.workers.resolveService(
      CHANNEL_SERVICE_PROTOCOL,
      channelId
    )) as ResolvedService;
    if (resolved?.kind !== "durable-object" || !resolved.targetId) {
      throw error("ENOENT", `Channel service did not resolve to a Durable Object for ${channelId}`);
    }
    return resolved.targetId;
  }

  async function resolveContextFromChannel(channelId: string): Promise<string> {
    const target = await resolveChannelTarget(channelId);
    const contextId = await ctx.rpc.call<string | null>(target, "getContextId");
    if (!contextId) {
      throw error("ENOCTX", `Channel ${channelId} is not bound to a context`);
    }
    return contextId;
  }

  function currentServerUrl(): string {
    const gatewayUrl = process.env["VIBESTUDIO_EXTENSION_GATEWAY_URL"];
    if (!gatewayUrl) {
      throw error(
        "ENOGATEWAY",
        "Claude Code extension host did not receive VIBESTUDIO_EXTENSION_GATEWAY_URL"
      );
    }
    return toServerBaseUrl(gatewayUrl);
  }

  function assertHeadlessSubagentCaller(input: LaunchSubagentInput): void {
    const invocation = ctx.invocation.current();
    const callerKind = invocation?.caller.callerKind;
    if (callerKind !== "do" && callerKind !== "worker") {
      throw error("EACCES", "Claude Code subagent launch requires a parent agent vessel caller");
    }
    if (!input.subagent?.runId || !input.subagent.parentChannelId || !input.subagent.parentRef) {
      throw error("EINVAL", "launchSubagent requires a complete subagent binding");
    }
    if (!input.subagent.task.trim()) {
      throw error("EINVAL", "launchSubagent requires a non-empty task");
    }
  }

  function killHeadlessLaunch(entityId: string, generationId?: string): boolean {
    const launch = headlessLaunches.get(entityId);
    if (!launch || (generationId !== undefined && launch.generationId !== generationId)) {
      return false;
    }
    headlessLaunches.delete(entityId);
    try {
      launch.child.kill("SIGTERM");
    } catch (err) {
      ctx.log.warn?.("Claude Code headless process kill failed", {
        entityId,
        launchId: launch.launchId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  function readLaunchLog(logPath: string, maxLogBytes: number): InspectLaunchResult["log"] {
    let bytes = 0;
    let tail = "";
    try {
      bytes = statSync(logPath).size;
      const length = Math.min(bytes, maxLogBytes);
      if (length > 0) {
        const fd = openSync(logPath, "r");
        try {
          const buffer = Buffer.alloc(length);
          const read = readSync(fd, buffer, 0, length, bytes - length);
          tail = buffer.subarray(0, read).toString("utf8");
        } finally {
          closeSync(fd);
        }
      }
    } catch (err) {
      ctx.log.warn?.("Claude Code launch log inspection failed", {
        log: path.basename(logPath),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { bytes, tail, truncated: bytes > maxLogBytes };
  }

  function inspectLaunch(input: {
    entityId: string;
    generationId: string;
    maxLogBytes?: number;
  }): InspectLaunchResult {
    const { entityId, generationId } = input;
    if (!entityId || !generationId) {
      throw error("EINVAL", "inspectLaunch requires entityId and generationId");
    }
    const requested =
      typeof input.maxLogBytes === "number" && Number.isInteger(input.maxLogBytes)
        ? input.maxLogBytes
        : 16_384;
    const maxLogBytes = Math.max(1_024, Math.min(65_536, requested));
    const launch = headlessLaunches.get(entityId);
    if (!launch || launch.generationId !== generationId) {
      const terminal = terminalLaunches.get(terminalLaunchKey(entityId, generationId));
      if (!terminal) {
        throw error("ENOENT", `No Claude launch ${generationId} for entity ${entityId}`);
      }
      const tailBytes = Buffer.byteLength(terminal.log.tail);
      const tail =
        tailBytes <= maxLogBytes
          ? terminal.log.tail
          : Buffer.from(terminal.log.tail)
              .subarray(tailBytes - maxLogBytes)
              .toString("utf8");
      return {
        ...terminal,
        log: {
          bytes: terminal.log.bytes,
          tail,
          truncated: terminal.log.bytes > maxLogBytes,
        },
      };
    }
    return {
      entityId,
      generationId,
      launchId: launch.launchId,
      runId: launch.runId,
      // The exit listener removes the launch before it reports terminal state;
      // membership in this generation-checked registry therefore means active.
      state: "running",
      pid: launch.child.pid ?? null,
      log: readLaunchLog(launch.logPath, maxLogBytes),
    };
  }

  function spawnHeadlessClaude(
    prepared: PrepareResult,
    input: LaunchSubagentInput,
    materialized: MaterializedClaudeLaunch,
    contextFolder: string
  ): LaunchSubagentResult {
    killHeadlessLaunch(prepared.entityId);
    const launchId = `claude-code:${input.subagent.runId}`;
    const logPath = path.join(materialized.profileDir, "headless.log");
    mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "a");
    let child: ChildProcess | null = null;
    try {
      const argv = [
        ...materialized.argv,
        ...subagentCliArgs(input.options),
        // Give headless supervision a machine-readable execution trace and
        // explicitly pre-authorize the two lifecycle tools. This keeps normal
        // repository tools under Claude's configured auto policy while making
        // `say`/`complete` unambiguously callable in print mode.
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        "mcp__vibestudio__say,mcp__vibestudio__complete",
        // A managed subagent must not inherit arbitrary user/project MCP
        // servers. They add unreviewed tools, startup latency, and processes
        // outside the launch contract. The one explicit config is the linked
        // Vibestudio bridge.
        "--strict-mcp-config",
        "-p",
        subagentFirstTaskPrompt(input.subagent),
      ];
      const confined = confineClaudeReadOnly({
        argv,
        profileDir: materialized.profileDir,
        contextDirectory: contextFolder,
      });
      child = spawn(confined.command, confined.args, {
        cwd: contextFolder,
        env: { ...process.env, ...materialized.env, ...confined.env },
        stdio: ["ignore", logFd, logFd],
        detached: false,
      });
    } finally {
      try {
        closeSync(logFd);
      } catch {
        /* noop */
      }
    }
    if (!child) throw error("ESPAWN", "Claude Code headless process did not start");

    const launch: HeadlessLaunch = {
      entityId: prepared.entityId,
      generationId: prepared.profile.launchId,
      launchId,
      runId: input.subagent.runId,
      vesselRef: prepared.vesselRef,
      child,
      logPath,
    };
    headlessLaunches.set(prepared.entityId, launch);
    child.on("exit", (code, signal) => {
      const current = headlessLaunches.get(prepared.entityId);
      const tracked = current?.generationId === prepared.profile.launchId;
      const inspectedLog = readLaunchLog(launch.logPath, 262_144);
      const completion =
        code === 0 && signal === null ? parseClaudeStreamCompletion(inspectedLog.tail) : null;
      if (tracked) {
        headlessLaunches.delete(prepared.entityId);
        const terminal: InspectLaunchResult = {
          entityId: launch.entityId,
          generationId: launch.generationId,
          launchId: launch.launchId,
          runId: launch.runId,
          state: "exited",
          pid: launch.child.pid ?? null,
          exit: { code: code ?? null, signal: signal ?? null, at: new Date().toISOString() },
          ...(completion ? { completion } : {}),
          log: {
            ...inspectedLog,
            tail: boundedUtf8Tail(inspectedLog.tail, 65_536),
            truncated: inspectedLog.bytes > 65_536,
          },
        };
        terminalLaunches.set(terminalLaunchKey(terminal.entityId, terminal.generationId), terminal);
        while (terminalLaunches.size > 64) {
          const oldest = terminalLaunches.keys().next().value as string | undefined;
          if (!oldest) break;
          terminalLaunches.delete(oldest);
        }
      }
      ctx.log.info?.("Claude Code headless process exited", {
        entityId: prepared.entityId,
        launchId,
        code,
        signal,
      });
      // Still tracked = the session ended on its own (a deliberate release/
      // cancel kill removes the entry first). A successful print-mode session
      // owns an authoritative typed result; settle from that result rather than
      // depending on the model to voluntarily call an MCP lifecycle tool.
      // Missing/malformed results and non-zero exits remain explicit failures.
      // Both vessel methods are idempotent past an early bridge completion.
      if (tracked) {
        void (async () => {
          try {
            if (completion) {
              await ctx.rpc.call(prepared.vesselRef, "reportExternalResult", {
                runId: input.subagent.runId,
                outcome: completion.outcome,
                report: completion.report,
                code: code ?? null,
              });
            } else {
              await ctx.rpc.call(prepared.vesselRef, "reportExternalExit", {
                runId: input.subagent.runId,
                code: code ?? null,
                signal: signal ?? null,
              });
            }
          } catch (err) {
            ctx.log.warn?.("Claude Code exit report failed", {
              entityId: prepared.entityId,
              launchId,
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            await release({
              entityId: prepared.entityId,
              generationId: prepared.profile.launchId,
            }).catch((err: unknown) => {
              ctx.log.warn?.("Claude Code launch cleanup failed", {
                entityId: prepared.entityId,
                launchId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        })();
      }
    });
    child.on("error", (err) => {
      ctx.log.warn?.("Claude Code headless process error", {
        entityId: prepared.entityId,
        launchId,
        error: err.message,
      });
    });

    return {
      entityId: prepared.entityId,
      contextId: prepared.contextId,
      channelId: prepared.channelId,
      vesselRef: prepared.vesselRef,
      vesselEntityId: prepared.vesselEntityId,
      vesselParticipantId: prepared.vesselParticipantId,
      launchId,
      generationId: prepared.profile.launchId,
      pid: child.pid ?? null,
      logPath,
    };
  }

  async function prepare(input: {
    channelId: string;
    title?: string;
    subagent?: PrepareSubagentBinding;
  }): Promise<PrepareResult> {
    const { channelId } = input;
    if (!channelId) throw error("EINVAL", "prepare requires a channelId");
    const priorForChannel = await readJson<LaunchRecord>(channelKey(channelId));
    // 1. Context is the channel's context — never create a channel.
    const contextId = await resolveContextFromChannel(channelId);

    // The development/runtime receivers independently enforce the launch and
    // context effects before they occur.
    // 2. Ensure the runtime session entity (idempotent by canonical key) and
    //    eagerly materialize the context folder.
    const sessionHandle = await ctx.rpc.call<{ id: string; contextId?: string }>(
      "main",
      "runtime.createEntity",
      {
        kind: "session",
        execution: { surface: "inert" },
        source: "claude-code",
        key: channelId,
        contextId,
        agentChannelId: channelId,
        ...(input.title ? { title: input.title } : {}),
      }
    );
    const entityId = sessionHandle.id;

    // 4. Ensure the linked-agent vessel and invite it into the channel with the
    //    standard launch primitives (idempotent: reuses the deterministic key).
    const launch = await launchAgentIntoChannel(rpc, {
      channelId,
      contextId,
      source: LINKED_AGENT_SOURCE,
      className: LINKED_AGENT_CLASS,
      key: `linked:${entityId}`,
      agentBinding: { entityId, channelId },
      // `subagent` gives the linked vessel task duty (complete → terminal-settle
      // to the parent, §8.2); `linkedEntityId` binds the bridge credential.
      stateArgs: {
        linkedEntityId: entityId,
        externalControllerCallerId: CONTROLLER_CALLER_ID,
        ...(input.subagent ? { subagent: input.subagent } : {}),
      },
    });
    const vesselRef = launch.handle.targetId;
    const vesselEntityId = launch.handle.id ?? vesselRef;
    const vesselParticipantId = launch.subscription.participantId ?? null;

    // 5. Mint the agent credential (rotate on re-prepare so a stale token is
    //    revoked). Bound to entity + host-derived context + channel.
    if (priorForChannel?.agentId) {
      await ctx.rpc.call("main", "auth.revokeAgentCredential", priorForChannel.agentId);
    }
    const credential = await ctx.rpc.call<{ agentId: string; agentToken: string }>(
      "main",
      "auth.mintAgentCredential",
      { entityId }
    );

    try {
      // 6. Return a path-free launch declaration. Workspace skills are exposed
      //    by the bridge as MCP resources; prepare never edits the context tree.
      const profile = claudeLaunchProfile({
        launchId: randomUUID(),
        environment: {
          VIBESTUDIO_AGENT_TOKEN: credential.agentToken,
          VIBESTUDIO_ENTITY_ID: entityId,
          VIBESTUDIO_CONTEXT_ID: contextId,
          VIBESTUDIO_CHANNEL_ID: channelId,
          VIBESTUDIO_VESSEL_REF: vesselRef,
          // Subagent launches carry their duty into the session env so the bridge
          // states it definitively in the MCP instructions (§8.2): the contract is
          // the SAME text a Pi child gets as its immediate prompt.
          ...(input.subagent
            ? {
                VIBESTUDIO_SUBAGENT_RUN_ID: input.subagent.runId,
                VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID: input.subagent.parentChannelId,
                VIBESTUDIO_SUBAGENT_CONTRACT: subagentRuntimePrompt(input.subagent, {
                  completionMode: "supervised-process",
                }),
              }
            : {}),
        },
      });

      const record: LaunchRecord = {
        launchId: profile.launchId,
        entityId,
        contextId,
        channelId,
        vesselRef,
        agentId: credential.agentId,
        preparedAt: new Date().toISOString(),
      };
      await writeJson(launchKey(record.launchId), record);
      await writeJson(channelKey(channelId), record);
      await writeJson(entityKey(entityId), { channelId });
      await writeJson(contextKey(contextId), { channelId });

      return {
        entityId,
        contextId,
        channelId,
        vesselRef,
        vesselEntityId,
        vesselParticipantId,
        profile,
      };
    } catch (error) {
      try {
        await ctx.rpc.call("main", "auth.revokeAgentCredential", credential.agentId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Claude launch preparation failed and credential revocation also failed"
        );
      }
      throw error;
    }
  }

  async function materializeLocalLaunch(prepared: PrepareResult): Promise<{
    launch: MaterializedClaudeLaunch;
    contextFolder: string;
  }> {
    await assertClaudeCodeVersion();
    const workspace = await ctx.workspace.getInfo();
    const { dir: contextFolder } = await ctx.workspace.ensureContextFolder(prepared.contextId);
    const launch = await materializeClaudeLaunch({
      profile: prepared.profile,
      profilesRoot: path.join(workspace.statePath, "agent-launch"),
      serverUrl: currentServerUrl(),
    });
    materializedLaunches.set(prepared.profile.launchId, launch);
    return { launch, contextFolder };
  }

  async function release(input: {
    entityId: string;
    generationId: string;
  }): Promise<{ released: boolean }> {
    const { entityId, generationId } = input;
    if (!entityId || !generationId) {
      throw error("EINVAL", "release requires entityId and generationId");
    }
    const killed = killHeadlessLaunch(entityId, generationId);
    const record = await readJson<LaunchRecord>(launchKey(generationId));
    if (record && record.entityId !== entityId) {
      throw error("EINVAL", `Launch ${generationId} does not belong to entity ${entityId}`);
    }
    const materialized = materializedLaunches.get(generationId);
    let cleanupError: unknown;
    if (record?.agentId) {
      try {
        await ctx.rpc.call("main", "auth.revokeAgentCredential", record.agentId);
        await writeJson(launchKey(generationId), { ...record, agentId: null });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (materialized) {
      try {
        if (!killed) {
          const credential = await reconcileClaudeLaunchCredential(materialized);
          if (credential.status === "conflict") {
            ctx.log.warn?.(
              "Claude refreshed its isolated credential, but the host login changed concurrently; preserving the newer host state",
              { entityId, generationId }
            );
          }
        }
        await removeMaterializedClaudeLaunch(materialized);
        materializedLaunches.delete(generationId);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) throw cleanupError;
    // Vessel + channel membership persist for reattach; ending the owned bridge
    // response takes presence offline. Storage records remain the reattach anchor.
    return { released: record !== null || killed || materialized !== undefined };
  }

  async function launchSubagent(input: LaunchSubagentInput): Promise<LaunchSubagentResult> {
    assertHeadlessSubagentCaller(input);
    const prepared = await prepare({
      channelId: input.channelId,
      title: input.title,
      subagent: input.subagent,
    });
    try {
      const { launch, contextFolder } = await materializeLocalLaunch(prepared);
      return spawnHeadlessClaude(prepared, input, launch, contextFolder);
    } catch (err) {
      await release({
        entityId: prepared.entityId,
        generationId: prepared.profile.launchId,
      }).catch(() => undefined);
      throw err;
    }
  }

  async function resolvePrimaryChannel(input: {
    contextId: string;
  }): Promise<{ channelId: string } | null> {
    if (!input.contextId) return null;
    const rec = await readJson<{ channelId: string }>(contextKey(input.contextId));
    return rec?.channelId ? { channelId: rec.channelId } : null;
  }

  ctx.health.healthy({ summary: "Claude Code launch orchestrator activated" });

  return {
    providerContracts: {
      claudeCode: { prepare, launchSubagent, inspectLaunch, release, resolvePrimaryChannel },
    },
  };
}
