import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import type { ExtensionContext, UserlandApprovalRequest } from "@vibestudio/extension";
import {
  buildContextAttachApproval,
  buildExecApproval,
  buildOpenApproval,
  buildUrlOpenApproval,
} from "./approvals.js";
import { runExec } from "./exec.js";
import { SessionManager } from "./sessionManager.js";
import { prepareVscodeShellIntegrationLaunch } from "./shellIntegrationEnv.js";
import { SnugServer } from "./snugServer.js";
import { nodeSetInterval } from "./nodeTimers.js";
import { LaunchAdapterRegistry } from "./launchAdapters.js";
import {
  createContextRequestSchema,
  execRequestSchema,
  launchAdapterSchema,
  openRequestSchema,
  unregisterLaunchAdapterSchema,
} from "./types.js";

const BLOCKED_ENV = /^(LD_PRELOAD|NODE_OPTIONS|PYTHONSTARTUP|SHELL)$|^DYLD_/;
const SCRATCH_LIMIT_BYTES = 25 * 1024 * 1024;
export const SCRATCH_TTL_MS = 24 * 60 * 60_000;
const SCRATCH_JANITOR_INTERVAL_MS = 30 * 60_000;
const CONTEXT_ATTACH_TOKEN_TTL_MS = 2 * 60_000;

function error(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function resolveWithin(root: string, input?: string): string {
  const resolved = path.resolve(root, input ?? ".");
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw error("EACCES", `Path escapes workspace root: ${input ?? "."}`);
  }
  return resolved;
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TERM"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!BLOCKED_ENV.test(key)) env[key] = value;
  }
  return env;
}

function normalizeScratchExt(ext: string): string {
  const clean = ext.replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(clean) ? clean : "bin";
}

function isReservedMetaKey(key: string): boolean {
  return key === "snugOpenUrl" || key === "snugSpawn";
}

function scratchFilename(ext: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const suffix = randomBytes(4).toString("hex");
  return `${stamp}-${suffix}.${normalizeScratchExt(ext)}`;
}

function currentOwner(ctx: ExtensionContext): { callerId: string; callerKind: string } {
  const caller = ctx.invocation.current()?.caller;
  if (!caller) throw error("ENOCALLER", "shell extension requires a panel or worker caller");
  return { callerId: caller.callerId, callerKind: caller.callerKind };
}

function currentInvocationContextId(ctx: ExtensionContext): string | undefined {
  const invocation = ctx.invocation.current();
  return invocation?.chainCaller?.contextId ?? invocation?.caller.contextId;
}

function currentExtensionCaller(ctx: ExtensionContext, method: string): string {
  const caller = ctx.invocation.current()?.caller;
  if (!caller || caller.callerKind !== "extension") {
    throw error("EACCES", `shell.${method} is only available to extension callers`);
  }
  return caller.callerId;
}

async function requireApproval(
  ctx: ExtensionContext,
  kind: "exec" | "open",
  req: UserlandApprovalRequest
): Promise<void> {
  const choice = await ctx.approvals.request(req);
  if (choice.kind === "uncallable") {
    throw error("ENOCALLER", "shell extension requires a panel or worker caller");
  }
  if (choice.kind === "dismissed") {
    throw error("EACCES", `shell.${kind} denied by user`);
  }
  if (choice.choice === "deny") {
    throw error("EACCES", `shell.${kind} denied by user`);
  }
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@vibestudio/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/shell": Api;
  }
}

/** Build a compact semantic-state label for a context-scoped session. */
async function contextRevisionDisplay(
  ctx: ExtensionContext,
  contextId: string
): Promise<string | undefined> {
  try {
    const status = await ctx.rpc.call<{
      workingHead:
        | { kind: "event"; eventId: string }
        | { kind: "application"; applicationId: string };
      workingCounts: { workUnits: number };
    }>("main", "vcs.status", { contextId });
    const short = contextId.length > 12 ? `${contextId.slice(0, 8)}…` : contextId;
    const head =
      status.workingHead.kind === "event"
        ? status.workingHead.eventId
        : status.workingHead.applicationId;
    const work = status.workingCounts.workUnits;
    return `ctx:${short} @ ${head.slice(0, 10)}${work > 0 ? ` · ${work} work` : ""}`.slice(0, 120);
  } catch {
    return undefined;
  }
}

export async function activate(ctx: ExtensionContext) {
  const workspace = await ctx.workspace.getInfo();
  // Launch-adapter registry (§4.3) — the single mechanism for recognizing and
  // optionally enriching agent launches. Seeded with the built-in detect-only
  // adapters; extensions add/replace entries via registerLaunchAdapter.
  const launchAdapters = new LaunchAdapterRegistry();
  const launchAdapterOwners = new Map<string, string>();
  const launchCleanups = new Map<string, { extension: string; method: string; args: unknown[] }>();
  const runLaunchCleanup = (sessionId: string): void => {
    const cleanup = launchCleanups.get(sessionId);
    if (!cleanup) return;
    launchCleanups.delete(sessionId);
    void ctx.extensions
      .invoke(cleanup.extension, cleanup.method, cleanup.args)
      .catch((err: unknown) => {
        ctx.log.warn?.("launch adapter cleanup failed", {
          sessionId,
          extension: cleanup.extension,
          method: cleanup.method,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };
  const freshContextTokens = new Map<
    string,
    { contextId: string; callerId: string; expiresAt: number }
  >();
  let snug!: SnugServer;
  const sessions = new SessionManager(
    {
      onExit: (sessionId) => {
        snug.unregister(sessionId);
        runLaunchCleanup(sessionId);
      },
      onDispose: (sessionId) => {
        snug.unregister(sessionId);
        runLaunchCleanup(sessionId);
      },
    },
    {
      detectAgent: (argv) => launchAdapters.detect(argv),
      resolveContextRevision: (contextId) => contextRevisionDisplay(ctx, contextId),
    }
  );
  // Resolve the cwd-confinement root for a request: the context's materialized
  // working folder when contextId is set (§4.1), else the workspace root.
  const confinementRoot = async (contextId?: string): Promise<string> => {
    if (!contextId) return workspace.path;
    const { dir } = await ctx.workspace.ensureContextFolder(contextId);
    return dir;
  };
  const pruneFreshContextTokens = () => {
    const now = Date.now();
    for (const [token, claim] of freshContextTokens) {
      if (claim.expiresAt <= now) freshContextTokens.delete(token);
    }
  };
  const mintFreshContextToken = (callerId: string, contextId: string): string => {
    pruneFreshContextTokens();
    const token = randomUUID();
    freshContextTokens.set(token, {
      callerId,
      contextId,
      expiresAt: Date.now() + CONTEXT_ATTACH_TOKEN_TTL_MS,
    });
    return token;
  };
  const consumeFreshContextToken = (
    token: string | undefined,
    callerId: string,
    contextId: string
  ): boolean => {
    if (!token) return false;
    pruneFreshContextTokens();
    const claim = freshContextTokens.get(token);
    if (!claim || claim.callerId !== callerId || claim.contextId !== contextId) return false;
    freshContextTokens.delete(token);
    return true;
  };
  const requireContextAttachApproval = async (
    operation: "exec" | "open",
    contextId: string | undefined,
    contextAttachToken: string | undefined,
    owner: { callerId: string; callerKind: string }
  ): Promise<void> => {
    if (!contextId) return;
    if (currentInvocationContextId(ctx) === contextId) return;
    if (consumeFreshContextToken(contextAttachToken, owner.callerId, contextId)) return;
    if (sessions.list(owner.callerId).some((session) => session.contextId === contextId)) return;
    await requireApproval(
      ctx,
      operation,
      buildContextAttachApproval({ contextId, callerId: owner.callerId, operation })
    );
  };
  snug = new SnugServer({
    list: (ownerCallerId) => sessions.list(ownerCallerId),
    setMeta: (sessionId, key, value) => sessions.setMetaById(sessionId, key, value),
    getMeta: (sessionId, key) => sessions.getMetaById(sessionId, key),
    deleteMeta: (sessionId, key) => sessions.deleteMetaById(sessionId, key),
    setLabel: (sessionId, label) => sessions.setLabelById(sessionId, label),
    write: (sessionId, text) => sessions.writeById(sessionId, text),
    ownerOf: (sessionId) => sessions.ownerOf(sessionId),
    openSplit: async (sourceSessionId, direction, commandLine) => {
      const owner = sessions.ownerFor(sourceSessionId);
      if (!owner) throw error("ENOENT", "Unknown source session");
      const cwd = sessions.cwdOf(sourceSessionId) ?? workspace.path;
      const contextId = sessions.contextIdOf(sourceSessionId);
      const command = commandLine ? "/bin/sh" : (process.env["SHELL"] ?? "/bin/bash");
      const args = commandLine ? ["-c", commandLine] : [];
      ctx.log.info?.("snug category-c request", {
        action: "split",
        sourceSessionId,
        direction,
        command,
        args,
        cwd,
        caller: owner.callerId,
      });
      try {
        await requireApproval(
          ctx,
          "open",
          buildOpenApproval({ command, args, cwd, label: commandLine })
        );
      } catch (err) {
        ctx.log.info?.("snug category-c decision", {
          action: "split",
          sourceSessionId,
          decision: "deny",
          caller: owner.callerId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      ctx.log.info?.("snug category-c decision", {
        action: "split",
        sourceSessionId,
        decision: "allow",
        caller: owner.callerId,
      });
      const snugEnv = snug.envForSession(cleanEnv({}));
      try {
        const launch = await prepareVscodeShellIntegrationLaunch({
          command,
          args,
          env: snugEnv.env,
        });
        const result = sessions.open(
          {
            command: launch.command,
            args: launch.args,
            cwd,
            env: launch.env,
            cols: 80,
            rows: 24,
            label: commandLine ?? "Shell",
            ...(contextId ? { contextId } : {}),
          },
          owner
        );
        snug.register(snugEnv.token, result.sessionId);
        sessions.setMetaById(result.sessionId, "snugSpawn", {
          parentSessionId: sourceSessionId,
          direction,
        });
        return result.sessionId;
      } catch (err) {
        snug.discardPending(snugEnv.token);
        throw err;
      }
    },
    openUrl: async (_sessionId, url) => {
      if (!/^https?:\/\//.test(url)) throw error("EINVAL", "snug open only supports http(s) URLs");
      const owner = sessions.ownerFor(_sessionId);
      if (!owner) throw error("ENOENT", "Unknown source session");
      ctx.log.info?.("snug category-c request", {
        action: "open-url",
        sourceSessionId: _sessionId,
        url,
        caller: owner.callerId,
      });
      try {
        await requireApproval(ctx, "open", buildUrlOpenApproval({ url }));
      } catch (err) {
        ctx.log.info?.("snug category-c decision", {
          action: "open-url",
          sourceSessionId: _sessionId,
          decision: "deny",
          caller: owner.callerId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      ctx.log.info?.("snug category-c decision", {
        action: "open-url",
        sourceSessionId: _sessionId,
        decision: "allow",
        caller: owner.callerId,
      });
      sessions.setMetaById(_sessionId, "snugOpenUrl", {
        id: randomUUID(),
        url,
        requestedAt: Date.now(),
      });
    },
  });
  await snug.start();
  const scratchDir = path.join(workspace.path, ".snug", "scratch");
  void sweepScratch(scratchDir);
  const scratchJanitor = nodeSetInterval(
    () => void sweepScratch(scratchDir),
    SCRATCH_JANITOR_INTERVAL_MS
  );
  scratchJanitor.unref?.();
  if (sessions.ptyAvailable) {
    ctx.health.healthy({ summary: "Shell extension activated" });
  } else {
    ctx.health.degraded({
      summary: "Shell extension activated without node-pty",
      reasons: [
        "Interactive terminal sessions require node-pty and cannot start until it is installed and built.",
      ],
    });
  }

  return {
    async createContext(raw: unknown) {
      const parsed = createContextRequestSchema.parse(raw);
      const owner = currentOwner(ctx);
      const handle = await ctx.rpc.call<{ id?: string; contextId?: string }>(
        "main",
        "runtime.createEntity",
        {
          kind: "session",
          source: "terminal",
          title: parsed?.title ?? "Terminal context",
        }
      );
      const entityId = typeof handle?.id === "string" ? handle.id : undefined;
      const contextId =
        typeof handle?.contextId === "string"
          ? handle.contextId
          : entityId
            ? await ctx.rpc.call<string | null>("main", "runtime.resolveContext", entityId)
            : null;
      if (!contextId) throw error("EIO", "Failed to resolve new context id");
      return { contextId, contextAttachToken: mintFreshContextToken(owner.callerId, contextId) };
    },

    async exec(raw: unknown) {
      const parsed = execRequestSchema.parse(raw);
      const owner = currentOwner(ctx);
      await requireContextAttachApproval(
        "exec",
        parsed.contextId,
        parsed.contextAttachToken,
        owner
      );
      const root = await confinementRoot(parsed.contextId);
      const cwd = resolveWithin(root, parsed.cwd);
      const env = cleanEnv(parsed.env);
      const {
        env: _env,
        cwd: _cwd,
        contextId: _ctxId,
        contextAttachToken: _contextAttachToken,
        ...execReq
      } = parsed;
      await requireApproval(
        ctx,
        "exec",
        buildExecApproval({
          command: parsed.command,
          args: parsed.args,
          cwd,
          shell: parsed.shell,
        })
      );
      return runExec({ ...execReq, cwd, env });
    },

    async open(raw: unknown) {
      const parsed = openRequestSchema.parse(raw);
      const owner = currentOwner(ctx);
      await requireContextAttachApproval(
        "open",
        parsed.contextId,
        parsed.contextAttachToken,
        owner
      );
      const root = await confinementRoot(parsed.contextId);
      const cwd = resolveWithin(root, parsed.cwd);
      let command = parsed.command ?? process.env["SHELL"] ?? "/bin/bash";
      let args = parsed.args;
      const {
        env: _env,
        cwd: _cwd,
        command: _command,
        contextId: _ctxId,
        contextAttachToken: _contextAttachToken,
        launchIntent: _launchIntent,
        ...openReq
      } = parsed;
      // Launch-adapter enrichment (§4.3): for a context-scoped session whose
      // resolved argv matches an adapter with a handler, invoke the handler
      // BEFORE approval/spawn so its env/argv rewrites are what the user
      // approves and what runs. No context, no match, or a null handler launches
      // untouched; a matched handler failure aborts loudly.
      let handlerEnv: Record<string, string> = {};
      let pendingCleanup: { extension: string; method: string; args: unknown[] } | undefined;
      let snugToken: string | undefined;
      if (parsed.contextId) {
        const argv = [command, ...args];
        const handler = launchAdapters.matchHandler(argv);
        if (handler) {
          try {
            const rewrite = (await ctx.extensions.invoke(handler.extension, handler.method, [
              {
                contextId: parsed.contextId,
                argv,
                cwd,
                env: parsed.env,
                ...(parsed.launchIntent ? { intent: parsed.launchIntent } : {}),
              },
            ])) as
              | {
                  env?: Record<string, string>;
                  argv?: string[];
                  cleanup?: { method: string; args: unknown[] };
                }
              | null
              | undefined;
            if (rewrite?.argv && rewrite.argv.length > 0) {
              const [nextCommand, ...nextArgs] = rewrite.argv;
              command = nextCommand ?? command;
              args = nextArgs;
            }
            if (rewrite?.env) handlerEnv = rewrite.env;
            if (rewrite?.cleanup) {
              pendingCleanup = { extension: handler.extension, ...rewrite.cleanup };
            }
          } catch (err) {
            ctx.log.warn?.("launch adapter handler failed", {
              extension: handler.extension,
              method: handler.method,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        }
      }
      try {
        await requireApproval(
          ctx,
          "open",
          buildOpenApproval({
            command,
            args,
            cwd,
            label: parsed.label,
          })
        );
        const { env, token } = snug.envForSession(cleanEnv({ ...parsed.env, ...handlerEnv }));
        snugToken = token;
        const launch = await prepareVscodeShellIntegrationLaunch({
          command,
          args,
          env,
        });
        const result = sessions.open(
          {
            ...openReq,
            command: launch.command,
            args: launch.args,
            // Shell-integration rewrites are transport details. Never turn
            // their generated init-script paths into the user-facing name.
            label: parsed.label ?? (parsed.command ? [command, ...args].join(" ") : "Shell"),
            cwd,
            env: launch.env,
            ...(parsed.contextId ? { contextId: parsed.contextId } : {}),
          },
          owner
        );
        snug.register(token, result.sessionId);
        if (pendingCleanup) launchCleanups.set(result.sessionId, pendingCleanup);
        return result;
      } catch (err) {
        if (snugToken) snug.discardPending(snugToken);
        if (pendingCleanup) {
          await ctx.extensions
            .invoke(pendingCleanup.extension, pendingCleanup.method, pendingCleanup.args)
            .catch((cleanupError: unknown) => {
              ctx.log.warn?.("launch adapter cleanup failed", {
                extension: pendingCleanup?.extension,
                method: pendingCleanup?.method,
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              });
            });
        }
        throw err;
      }
    },

    /**
     * Register (or replace, by id) a launch adapter (§4.3). Extensions call
     * this on activation to teach the shell how to recognize and — for
     * context-scoped sessions — enrich their agent launches. Idempotent by id.
     */
    async registerLaunchAdapter(raw: unknown) {
      const adapter = launchAdapterSchema.parse(raw);
      const owner = currentExtensionCaller(ctx, "registerLaunchAdapter");
      if (adapter.id.startsWith("builtin:")) {
        throw error("EACCES", "Built-in launch adapters cannot be replaced");
      }
      const existingOwner = launchAdapterOwners.get(adapter.id);
      if (existingOwner && existingOwner !== owner) {
        throw error("EACCES", `Launch adapter ${adapter.id} is owned by another extension`);
      }
      if (adapter.handler && adapter.handler.extension !== owner) {
        throw error("EACCES", "Launch adapter handlers must be owned by the registering extension");
      }
      launchAdapters.register(adapter);
      launchAdapterOwners.set(adapter.id, owner);
    },

    /** Remove a previously-registered launch adapter by id. */
    async unregisterLaunchAdapter(raw: unknown) {
      const { id } = unregisterLaunchAdapterSchema.parse(raw);
      const owner = currentExtensionCaller(ctx, "unregisterLaunchAdapter");
      const existingOwner = launchAdapterOwners.get(id);
      if (!existingOwner) return;
      if (existingOwner !== owner) {
        throw error("EACCES", `Launch adapter ${id} is owned by another extension`);
      }
      launchAdapters.unregister(id);
      launchAdapterOwners.delete(id);
    },

    async dispose(sessionId: string) {
      snug.unregister(sessionId);
      let session;
      try {
        session = sessions.requireOwner(sessionId, currentOwner(ctx).callerId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      sessions.dispose(session);
    },

    async restart(sessionId: string, opts?: { cols?: number; rows?: number }) {
      const session = sessions.requireOwner(sessionId, currentOwner(ctx).callerId);
      const snugEnv = snug.envForSession(cleanEnv({}));
      try {
        const [command, ...args] = session.command.argv;
        const launch = await prepareVscodeShellIntegrationLaunch({
          command: command ?? process.env["SHELL"] ?? "/bin/bash",
          args,
          env: snugEnv.env,
        });
        const result = sessions.restart(session, {
          ...(opts?.cols ? { cols: opts.cols } : {}),
          ...(opts?.rows ? { rows: opts.rows } : {}),
          command: launch.command,
          args: launch.args,
          env: launch.env,
        });
        snug.register(snugEnv.token, result.sessionId);
        return result;
      } catch (err) {
        snug.discardPending(snugEnv.token);
        throw err;
      }
    },

    async write(sessionId: string, data: string) {
      sessions.write(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), data);
    },

    async acknowledgeDataEvent(sessionId: string, charCount: number) {
      sessions.acknowledgeDataEvent(
        sessions.requireOwner(sessionId, currentOwner(ctx).callerId),
        charCount
      );
    },

    async resize(sessionId: string, cols: number, rows: number) {
      sessions.resize(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), cols, rows);
    },

    async kill(sessionId: string, signal?: "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP") {
      sessions.kill(
        sessions.requireOwner(sessionId, currentOwner(ctx).callerId),
        signal ?? "SIGTERM"
      );
    },

    async list() {
      return sessions.list(currentOwner(ctx).callerId);
    },

    async get(sessionId: string) {
      return sessions.info(sessions.requireOwner(sessionId, currentOwner(ctx).callerId));
    },

    async getSessionInfo(sessionId: string) {
      return sessions.info(sessions.requireOwner(sessionId, currentOwner(ctx).callerId));
    },

    async watchSessionInfo(sessionId: string) {
      return sessions.watchInfo(sessions.requireOwner(sessionId, currentOwner(ctx).callerId));
    },

    async watchAllSessionInfo() {
      return sessions.watchAllInfo(currentOwner(ctx).callerId);
    },

    async attach(sessionId: string, opts?: { after?: string }) {
      return sessions.attach(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), opts);
    },

    async awaitExit(sessionId: string) {
      return sessions.awaitExit(sessions.requireOwner(sessionId, currentOwner(ctx).callerId));
    },

    async getScrollback(sessionId: string, maxBytes?: number) {
      return sessions.getScrollback(
        sessions.requireOwner(sessionId, currentOwner(ctx).callerId),
        maxBytes
      );
    },

    async setScrollbackLimit(sessionId: string, maxBytes: number) {
      sessions.setScrollbackLimit(
        sessions.requireOwner(sessionId, currentOwner(ctx).callerId),
        maxBytes
      );
    },

    async clearScrollback(sessionId: string) {
      sessions.clearScrollback(sessions.requireOwner(sessionId, currentOwner(ctx).callerId));
    },

    async stashScratch(bytes: Uint8Array, ext: string) {
      currentOwner(ctx);
      const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (payload.byteLength === 0) throw error("EINVAL", "Cannot stash an empty file");
      if (payload.byteLength > SCRATCH_LIMIT_BYTES)
        throw error("E2BIG", "Scratch file exceeds 25MB limit");
      await mkdir(scratchDir, { recursive: true });
      const filename = scratchFilename(ext);
      const absolutePath = path.join(scratchDir, filename);
      await writeFile(absolutePath, payload);
      return { absolutePath, workspaceRelative: path.relative(workspace.path, absolutePath) };
    },

    async setMeta(sessionId: string, key: string, value: unknown) {
      if (isReservedMetaKey(key)) throw error("EACCES", `Reserved shell metadata key: ${key}`);
      sessions.setMeta(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), key, value);
    },

    async getMeta(sessionId: string, key?: string) {
      return sessions.getMeta(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), key);
    },

    async deleteMeta(sessionId: string, key: string) {
      if (isReservedMetaKey(key)) throw error("EACCES", `Reserved shell metadata key: ${key}`);
      sessions.deleteMeta(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), key);
    },

    async setLabel(sessionId: string, label: string) {
      sessions.setLabel(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), label);
    },
  };
}

export async function sweepScratch(scratchDir: string, now = Date.now()): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(scratchDir);
  } catch {
    return;
  }
  const cutoff = now - SCRATCH_TTL_MS;
  await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(scratchDir, entry);
      try {
        const info = await stat(absolutePath);
        if (info.isFile() && info.mtimeMs < cutoff) await unlink(absolutePath);
      } catch {
        // Best-effort cleanup only.
      }
    })
  );
}
