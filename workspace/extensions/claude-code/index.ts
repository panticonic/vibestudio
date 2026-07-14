import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext, UserlandApprovalRequest } from "@vibestudio/extension";
import type { MirrorObjectsResult, MirrorTarget } from "@vibestudio/service-schemas/mirror";
import type { VcsEditResult } from "@vibestudio/service-schemas/vcs";
import {
  ContextWorkspaceSession,
  type ContextWorkspaceAdapters,
} from "@vibestudio/context-workspace";
import { createNativeChildEnvironment } from "@vibestudio/shared/nativeProcessEnvironment";
import {
  launchAgentIntoChannel,
  subagentRuntimePrompt,
  type AgentLaunchRpc,
} from "@workspace/agentic-core";
import {
  assertClaudeCodeVersion,
  removeLaunchProfile,
  toServerBaseUrl,
  writeLaunchProfile,
  type LaunchEnv,
} from "./profile.js";

const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
const LINKED_AGENT_SOURCE = "workers/linked-agent";
const LINKED_AGENT_CLASS = "LinkedAgentWorker";
const CONTEXT_MARKER = ".vibestudio-context.json";
const processExitCleanups = new Set<() => void>();
let processExitHandlerInstalled = false;

function registerProcessExitCleanup(cleanup: () => void): () => void {
  processExitCleanups.add(cleanup);
  if (!processExitHandlerInstalled) {
    processExitHandlerInstalled = true;
    process.once("exit", () => {
      for (const current of processExitCleanups) current();
      processExitCleanups.clear();
    });
  }
  return () => processExitCleanups.delete(cleanup);
}

function error(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Durable per-launch bookkeeping, stored in extension storage. */
interface LaunchRecord {
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  agentId: string;
  profileDir: string;
  preparedAt: string;
}

interface LaunchIndex {
  version: 1;
  channels: Record<string, LaunchRecord>;
  entities: Record<string, string>;
  contexts: Record<string, string>;
}

/** Subagent task-duty binding threaded into the linked vessel's state
 *  (docs/claude-code-channels-plan.md §8.2). When present, the vessel owns
 *  `complete` → terminal-settle back to the parent, and the per-launch approval
 *  gate is skipped (the parent's spawn is the authorization; depth/fan-out gate
 *  it, not a human prompt). Shape mirrors agentic-core's SubagentIdentity. */
export interface PrepareSubagentBinding {
  runId: string;
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
  contextFolder: string;
  env: LaunchEnv;
  argv: string[];
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
  task: string;
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
  pid: number | null;
  logPath: string;
}

interface ResolvedService {
  kind: string;
  targetId?: string;
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
export type PublicApi = Pick<Api, "adaptLaunch">;
declare module "@vibestudio/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/claude-code": PublicApi;
  }
}

function buildLaunchApproval(input: {
  channelId: string;
  contextId: string;
  argv: string[];
}): UserlandApprovalRequest {
  return {
    subject: {
      id: `claude-code.launch.${input.channelId}`,
      label: `Launch Claude Code in ${input.channelId}`,
    },
    title: "Launch Claude Code agent",
    summary: [
      "Let a Claude Code session join this conversation as a linked agent.",
      "It runs in the conversation's context working tree with the `vibestudio` CLI",
      "auto-scoped to that context. Its tool-use permission prompts flow into approvals.",
    ].join(" "),
    warning:
      "The session receives an agent credential and can act on the channel and context on your behalf.",
    details: [
      { label: "Channel", value: input.channelId },
      { label: "Context", value: input.contextId },
      { label: "Command", value: `\`\`\`sh\n${input.argv.join(" ")}\n\`\`\``, format: "markdown" },
    ],
    severity: "dangerous",
    defaultAction: "deny",
    options: [
      { value: "allow", label: "Launch", tone: "primary" },
      { value: "deny", label: "Cancel", tone: "danger" },
    ],
  };
}

export async function activate(ctx: ExtensionContext) {
  interface HeadlessLaunch {
    entityId: string;
    launchId: string;
    runId: string;
    vesselRef: string;
    child: ChildProcess;
    logPath: string;
  }

  const headlessLaunches = new Map<string, HeadlessLaunch>();
  const workspaceSessions = new Map<string, ContextWorkspaceSession>();
  const disposeProcessExitCleanup = registerProcessExitCleanup(() => {
    for (const launch of headlessLaunches.values()) {
      try {
        launch.child.kill("SIGTERM");
      } catch {
        /* process is already gone */
      }
    }
  });
  ctx.subscriptions?.push({ dispose: disposeProcessExitCleanup });

  const rpc: AgentLaunchRpc = {
    call: <T>(target: string, method: string, args: unknown[]): Promise<T> =>
      ctx.rpc.call<T>(target, method, ...args),
  };

  // One exact registry is the commit point for channel↔context↔entity
  // bookkeeping. A launch is never partially visible through three separately
  // written pointer files.
  const launchIndexKey = "launch-index.json";

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

  async function readLaunchIndex(): Promise<LaunchIndex> {
    const current = await readJson<LaunchIndex>(launchIndexKey);
    if (
      !current ||
      current.version !== 1 ||
      !current.channels ||
      !current.entities ||
      !current.contexts
    ) {
      return { version: 1, channels: {}, entities: {}, contexts: {} };
    }
    return current;
  }

  async function commitLaunchRecord(record: LaunchRecord): Promise<void> {
    const current = await readLaunchIndex();
    await writeJson(launchIndexKey, {
      version: 1,
      channels: { ...current.channels, [record.channelId]: record },
      entities: { ...current.entities, [record.entityId]: record.channelId },
      contexts: { ...current.contexts, [record.contextId]: record.channelId },
    } satisfies LaunchIndex);
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

  async function readServerUrlFromMarker(contextFolder: string): Promise<string> {
    // ctx.storage is sandboxed to extension storage; the marker lives in the
    // context working tree, so read it directly through node fs.
    const markerPath = path.join(contextFolder, CONTEXT_MARKER);
    let raw: string;
    try {
      raw = await readFile(markerPath, "utf8");
    } catch (err) {
      throw error(
        "ENOMARKER",
        `Context marker not found at ${markerPath} (${
          err instanceof Error ? err.message : String(err)
        }). It is written when the context folder is materialized.`
      );
    }
    const parsed = JSON.parse(raw) as { serverUrl?: string };
    if (!parsed.serverUrl) {
      throw error("ENOMARKER", `Context marker at ${markerPath} has no serverUrl`);
    }
    return parsed.serverUrl;
  }

  async function resolveHostPlugin(): Promise<string> {
    const toolchainDir = process.env["VIBESTUDIO_TOOLCHAIN_DIR"];
    const hostBuildId = process.env["VIBESTUDIO_HOST_BUILD_ID"];
    if (!toolchainDir || !hostBuildId) {
      throw error("ETOOLCHAIN", "Claude Code requires the active host-owned Vibestudio toolchain");
    }
    const manifest = JSON.parse(await readFile(path.join(toolchainDir, "manifest.json"), "utf8")) as {
      hostBuildId?: unknown;
      plugin?: { relativePath?: unknown };
    };
    if (manifest.hostBuildId !== hostBuildId || typeof manifest.plugin?.relativePath !== "string") {
      throw error("ETOOLCHAIN", "Active toolchain manifest does not match this host or name its Claude plugin");
    }
    const pluginDir = path.resolve(toolchainDir, manifest.plugin.relativePath);
    if (path.relative(path.resolve(toolchainDir), pluginDir).startsWith("..")) {
      throw error("ETOOLCHAIN", "Toolchain Claude plugin escapes its immutable host build");
    }
    await access(path.join(pluginDir, ".claude-plugin", "plugin.json"));
    return pluginDir;
  }

  function contextWorkspaceAdapters(contextId: string): ContextWorkspaceAdapters {
    return {
      readState: async (_repoPath, stateHash) => {
        const files = [] as Array<{ path: string; bytes: Uint8Array; mode: 0o644 | 0o755 }>;
        let cursor: string | undefined;
        do {
          const page = await ctx.rpc.call<MirrorObjectsResult>("main", "mirror.objects", {
            stateHash,
            ...(cursor ? { cursor } : {}),
          });
          for (const file of page.files) {
            if (file.mode !== 33188 && file.mode !== 33261) {
              throw error("EFIDELITY", `Unsupported canonical mode ${file.mode} for ${file.path}`);
            }
            files.push({
              path: file.path,
              bytes: Buffer.from(file.content, "base64"),
              mode: file.mode === 33261 ? 0o755 : 0o644,
            });
          }
          cursor = page.next;
        } while (cursor);
        return files;
      },
      edit: async ({ repoPath, baseStateHash, clientEditId, edits }) => {
        const result = await ctx.rpc.call<VcsEditResult>("main", "vcs.edit", {
          head: `ctx:${contextId}`,
          repoPath,
          baseStateHash,
          clientEditId,
          edits: edits.map((edit) =>
            edit.kind === "delete"
              ? edit
              : {
                  kind: "write",
                  path: edit.path,
                  content: { kind: "bytes", base64: Buffer.from(edit.bytes).toString("base64") },
                  mode: edit.mode === 0o755 ? 33261 : 33188,
                }
          ),
        });
        if (!result.stateHash) throw error("ESYNC", "vcs.edit returned no repository state hash");
        return { stateHash: result.stateHash };
      },
    };
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
    if (!input.task.trim()) {
      throw error("EINVAL", "launchSubagent requires a non-empty task");
    }
  }

  function killHeadlessLaunch(entityId: string): boolean {
    const launch = headlessLaunches.get(entityId);
    if (!launch) return false;
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

  function spawnHeadlessClaude(
    prepared: PrepareResult,
    input: LaunchSubagentInput
  ): LaunchSubagentResult {
    killHeadlessLaunch(prepared.entityId);
    const launchId = `claude-code:${input.subagent.runId}`;
    const logPath = path.join(prepared.env.VIBESTUDIO_LAUNCH_PROFILE, "headless.log");
    mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "a");
    let child: ChildProcess | null = null;
    try {
      const argv = [...prepared.argv, ...subagentCliArgs(input.options), "-p", input.task];
      const command = argv[0] ?? "claude";
      const args = argv.slice(1);
      const { VIBESTUDIO_AGENT_TOKEN, ...declared } = prepared.env;
      const childEnvironment = createNativeChildEnvironment({
        purpose: "claude",
        declared,
        purposeCredential: {
          name: "VIBESTUDIO_AGENT_TOKEN",
          value: VIBESTUDIO_AGENT_TOKEN,
        },
      });
      child = spawn(command, args, {
        cwd: prepared.contextFolder,
        env: childEnvironment.env,
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
      launchId,
      runId: input.subagent.runId,
      vesselRef: prepared.vesselRef,
      child,
      logPath,
    };
    headlessLaunches.set(prepared.entityId, launch);
    child.on("exit", (code, signal) => {
      const current = headlessLaunches.get(prepared.entityId);
      const tracked = current?.launchId === launchId;
      if (tracked) headlessLaunches.delete(prepared.entityId);
      ctx.log.info?.("Claude Code headless process exited", {
        entityId: prepared.entityId,
        launchId,
        code,
        signal,
      });
      // Still tracked = the session ended on its own (a deliberate release/
      // cancel kill removes the entry first). If the model never called
      // `complete`, the parent's run must not dangle as "running" forever —
      // report the exit so the vessel settles it (no-op past a real complete).
      if (tracked) {
        void (async () => {
          let reportedCode = code ?? null;
          try {
            const sync = workspaceSessions.get(prepared.entityId);
            if (sync) {
              await sync.stop();
              workspaceSessions.delete(prepared.entityId);
            }
          } catch (syncError) {
            reportedCode = reportedCode ?? 74;
            ctx.log.warn?.("Claude Code final workspace flush failed", {
              entityId: prepared.entityId,
              error: syncError instanceof Error ? syncError.message : String(syncError),
            });
          }
          await ctx.rpc.call(prepared.vesselRef, "reportExternalExit", {
            runId: input.subagent.runId,
            code: reportedCode,
            signal: signal ?? null,
          });
        })().catch((err: unknown) => {
          ctx.log.warn?.("Claude Code exit report failed", {
            entityId: prepared.entityId,
            launchId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
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

    // 0. Fail loudly on an unsupported Claude Code (plan §11).
    await assertClaudeCodeVersion();

    // 1. Context is the channel's context — never create a channel.
    const contextId = await resolveContextFromChannel(channelId);

    const priorForChannel = (await readLaunchIndex()).channels[channelId] ?? null;
    const isFirstPrepare = priorForChannel === null;

    // 2. Approval gate on the FIRST prepare for this channel only. A subagent
    //    launch skips it: the parent agent's spawn (depth/fan-out gated) is the
    //    authorization, and the caller is a headless `do`/`worker` that cannot
    //    answer an interactive prompt anyway. This runs before runtime/context
    //    side effects so denial leaves no launch artifacts.
    if (isFirstPrepare && !input.subagent) {
      const argvPreview = [
        "claude",
        "--channels",
        "server:vibestudio",
        "--dangerously-load-development-channels",
      ];
      const choice = await ctx.approvals.request(
        buildLaunchApproval({ channelId, contextId, argv: argvPreview })
      );
      if (choice.kind === "uncallable") {
        throw error("ENOCALLER", "Claude Code launch requires an interactive caller");
      }
      if (choice.kind === "dismissed" || choice.choice !== "allow") {
        throw error("EACCES", "Claude Code launch denied by user");
      }
    }

    // 3. Ensure the runtime session entity (idempotent by canonical key) and
    //    eagerly materialize the context folder.
    const workspace = await ctx.workspace.getInfo();
    const sessionHandle = await ctx.rpc.call<{ id: string; contextId?: string }>(
      "main",
      "runtime.createEntity",
      {
        kind: "session",
        source: "claude-code",
        key: channelId,
        contextId,
        ...(input.title ? { title: input.title } : {}),
      }
    );
    const entityId = sessionHandle.id;
    let managedWorkspace: ContextWorkspaceSession | null = null;
    let mintedCredential: { agentId: string; agentToken: string } | null = null;
    let writtenProfileDir: string | null = null;
    try {
      await ctx.workspace.ensureContextFolder(contextId);
      const projectionFolder = path.join(workspace.contextsPath, contextId);

      // 4. Ensure the linked-agent vessel and invite it into the channel with the
      //    standard launch primitives (idempotent: reuses the deterministic key).
      const launch = await launchAgentIntoChannel(rpc, {
        channelId,
        contextId,
        source: LINKED_AGENT_SOURCE,
        className: LINKED_AGENT_CLASS,
        key: `linked:${entityId}`,
        agentBinding: { entityId, channelId },
        stateArgs: {
          linkedEntityId: entityId,
          ...(input.subagent ? { subagent: input.subagent } : {}),
        },
      });
      const vesselRef = launch.handle.targetId;
      const vesselEntityId = launch.handle.id ?? vesselRef;
      const vesselParticipantId = launch.subscription.participantId ?? null;
      const serverUrl = toServerBaseUrl(await readServerUrlFromMarker(projectionFolder));

      // 5. Native tools run only in the managed writable mirror. Its checkpoint
      // must exactly match the current GAD targets before any credential or
      // process is created.
      const targets = await ctx.rpc.call<MirrorTarget[]>("main", "mirror.targets", { contextId });
      const contextFolder = path.join(
        workspace.statePath,
        "context-workspaces",
        workspace.id,
        contextId
      );
      const priorWorkspace = workspaceSessions.get(entityId);
      if (priorWorkspace) {
        await priorWorkspace.stop();
        workspaceSessions.delete(entityId);
      }
      managedWorkspace = await ContextWorkspaceSession.open({
        root: contextFolder,
        targets,
        adapters: contextWorkspaceAdapters(contextId),
      });
      await writeFile(
        path.join(contextFolder, CONTEXT_MARKER),
        `${JSON.stringify({ contextId, workspaceId: workspace.id, serverUrl }, null, 2)}\n`,
        { mode: 0o600 }
      );
      managedWorkspace.start({
        readTargets: () => ctx.rpc.call<MirrorTarget[]>("main", "mirror.targets", { contextId }),
        onError: (message, syncError) =>
          ctx.log.warn?.(`Claude Code ${message}`, {
            contextId,
            error: syncError instanceof Error ? syncError.message : String(syncError),
          }),
      });
      workspaceSessions.set(entityId, managedWorkspace);

      // 6. Mint first and revoke the prior credential only after the new profile
      // and durable pointers commit. A failed rotation leaves the last prepared
      // generation usable and never leaks the candidate credential.
      mintedCredential = await ctx.rpc.call<{ agentId: string; agentToken: string }>(
        "main",
        "auth.mintAgentCredential",
        { entityId, channelId }
      );

      // 7. One canonical plugin owns MCP, hooks, channel support and skill.
      const pluginDir = await resolveHostPlugin();
      const written = await writeLaunchProfile({
        statePath: workspace.statePath,
        entityId,
        generationId: mintedCredential.agentId,
        pluginDir,
        env: {
          VIBESTUDIO_SERVER_URL: serverUrl,
          VIBESTUDIO_AGENT_TOKEN: mintedCredential.agentToken,
          VIBESTUDIO_ENTITY_ID: entityId,
          VIBESTUDIO_CONTEXT_ID: contextId,
          VIBESTUDIO_CHANNEL_ID: channelId,
          VIBESTUDIO_VESSEL_REF: vesselRef,
          VIBESTUDIO_PLUGIN_DIR: pluginDir,
          ...(input.subagent
            ? {
                VIBESTUDIO_SUBAGENT_RUN_ID: input.subagent.runId,
                VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID: input.subagent.parentChannelId,
                VIBESTUDIO_SUBAGENT_CONTRACT: subagentRuntimePrompt(input.subagent),
              }
            : {}),
        },
      });
      writtenProfileDir = written.profileDir;

      const record: LaunchRecord = {
        entityId,
        contextId,
        channelId,
        vesselRef,
        agentId: mintedCredential.agentId,
        profileDir: written.profileDir,
        preparedAt: new Date().toISOString(),
      };
      await commitLaunchRecord(record);

      if (priorForChannel?.agentId && priorForChannel.agentId !== mintedCredential.agentId) {
        await ctx.rpc
          .call("main", "auth.revokeAgentCredential", priorForChannel.agentId)
          .catch(() => undefined);
      }
      if (priorForChannel?.profileDir && priorForChannel.profileDir !== written.profileDir) {
        await rm(priorForChannel.profileDir, { recursive: true, force: true }).catch(() => undefined);
      }

      return {
        entityId,
        contextId,
        channelId,
        vesselRef,
        vesselEntityId,
        vesselParticipantId,
        contextFolder,
        env: written.env,
        argv: written.argv,
      };
    } catch (caught) {
      if (workspaceSessions.get(entityId) === managedWorkspace) workspaceSessions.delete(entityId);
      if (managedWorkspace) {
        await managedWorkspace.stop().catch(() => undefined);
      }
      if (mintedCredential) {
        await ctx.rpc
          .call("main", "auth.revokeAgentCredential", mintedCredential.agentId)
          .catch(() => undefined);
      }
      if (writtenProfileDir) {
        await rm(writtenProfileDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw caught;
    }
  }

  async function release(input: { entityId: string }): Promise<{ released: boolean }> {
    const { entityId } = input;
    if (!entityId) throw error("EINVAL", "release requires an entityId");
    const killed = killHeadlessLaunch(entityId);
    const index = await readLaunchIndex();
    const channelId = index.entities[entityId];
    const record = channelId ? index.channels[channelId] ?? null : null;
    let synchronizationError: unknown = null;
    const managedWorkspace = workspaceSessions.get(entityId);
    if (managedWorkspace) {
      try {
        await managedWorkspace.stop();
        workspaceSessions.delete(entityId);
      } catch (caught) {
        synchronizationError = caught;
      }
    }
    if (record?.agentId) {
      await ctx.rpc
        .call("main", "auth.revokeAgentCredential", record.agentId)
        .catch(() => undefined);
    }
    const workspace = await ctx.workspace.getInfo();
    await removeLaunchProfile(workspace.statePath, entityId).catch(() => undefined);
    // Vessel + channel membership persist for reattach; presence goes offline via
    // the vessel heartbeat. Storage records are left as the reattach anchor.
    if (synchronizationError) throw synchronizationError;
    return { released: record !== null || killed || managedWorkspace !== undefined };
  }

  async function launchSubagent(input: LaunchSubagentInput): Promise<LaunchSubagentResult> {
    assertHeadlessSubagentCaller(input);
    const prepared = await prepare({
      channelId: input.channelId,
      title: input.title,
      subagent: input.subagent,
    });
    try {
      return spawnHeadlessClaude(prepared, input);
    } catch (err) {
      await release({ entityId: prepared.entityId }).catch(() => undefined);
      throw err;
    }
  }

  async function resolvePrimaryChannel(input: {
    contextId: string;
  }): Promise<{ channelId: string } | null> {
    if (!input.contextId) return null;
    const channelId = (await readLaunchIndex()).contexts[input.contextId];
    return channelId ? { channelId } : null;
  }

  async function adaptLaunch(input: {
    contextId: string;
    argv: string[];
    cwd: string;
    env: Record<string, string>;
  }): Promise<{ env: Record<string, string>; argv: string[]; cwd: string } | null> {
    // Launch-adapter handler (§4.3): a bare `claude` in a context terminal. With
    // no known conversation channel for the context we return null so the shell
    // extension launches the session untouched — channels are never created here.
    const primary = await resolvePrimaryChannel({ contextId: input.contextId });
    if (!primary) return null;
    const prepared = await prepare({ channelId: primary.channelId });
    return {
      env: { ...input.env, ...prepared.env },
      argv: prepared.argv,
      cwd: prepared.contextFolder,
    };
  }

  // Register the launch adapter so a bare `claude` in a context-scoped terminal
  // is upgraded into a connected agent (§4.3). Best-effort: the shell extension
  // (W3a) owns `registerLaunchAdapter`; if it isn't available yet, detection just
  // falls back to launching Claude Code untouched.
  try {
    await ctx.extensions.invoke("@workspace-extensions/shell", "registerLaunchAdapter", [
      {
        id: "claude-code",
        match: { pattern: "\\bclaude(-code)?\\b" },
        detect: { kind: "claude-code" },
        handler: { extension: "@workspace-extensions/claude-code", method: "adaptLaunch" },
      },
    ]);
  } catch (err) {
    ctx.log.info?.("claude-code launch adapter not registered", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const healthReasons: string[] = [];
  await assertClaudeCodeVersion().catch((healthError: unknown) => {
    healthReasons.push(healthError instanceof Error ? healthError.message : String(healthError));
  });
  await resolveHostPlugin().catch((healthError: unknown) => {
    healthReasons.push(healthError instanceof Error ? healthError.message : String(healthError));
  });
  if (healthReasons.length > 0) {
    ctx.health.degraded({ summary: "Claude Code is unavailable", reasons: healthReasons });
  } else {
    ctx.health.healthy({ summary: "Claude Code and its host-owned plugin are ready" });
  }

  return {
    providerContracts: {
      claudeCode: { prepare, launchSubagent, release, resolvePrimaryChannel },
    },
    adaptLaunch,
  };
}
