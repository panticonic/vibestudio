/**
 * Terminal app launch service and the per-person terminal session registry.
 *
 * A terminal app is a panel hosted by terminals (`terminal-apps/<name>`): the
 * same unit kind, build, admission, identity and per-instance stateArgs as a
 * panel, run as a Node program in a workspace PTY instead of a browser view.
 * This trusted service is its host, as the desktop shell is a panel's host:
 *
 * - it activates the app's runtime entity (`kind: "panel"`, no slot, owned by
 *   the person, its own context) and holds its panel-runtime lease;
 * - it mints the program's connection grant on the person's behalf;
 * - it starts the program through the Base shell extension, as the person, so
 *   the PTY belongs to them and any of their terminal clients can attach;
 * - it hands the program its launch material through a one-shot file (the
 *   only launch variable names the file; the program removes it on start), so
 *   no standing credential sits in the process environment. Inside one native
 *   runtime processes are not separate security domains
 *   (docs/isolation-plan.md): this is attribution, not isolation.
 *
 * The lease follows the program's authoritative lifecycle: the service waits
 * on the shell extension for the PTY's exit and then retires the entity (and
 * so the lease); closing a session does the same. A relaunch creates a new
 * incarnation in the same session context and carries its stateArgs over.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  terminalAppsMethods,
  TERMINAL_APPS_RUN_CAPABILITY,
  TERMINAL_APPS_RUN_PREPARATION,
  TERMINAL_SESSIONS_CHANGED_EVENT,
  type TerminalSessionEntry,
} from "@vibestudio/service-schemas/terminalApps";
import { isTerminalAppLocation } from "@vibestudio/workspace-contracts/sourceDirs";
import {
  fixedPreparedAuthoritySelection,
  type ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  createHostCaller,
  verifiedInitiatingUserId,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import type { UserSubject } from "@vibestudio/identity/types";
import type {
  RuntimeEntityCreateSpec,
  RuntimeEntityHandle,
} from "@vibestudio/shared/runtime/entitySpec";
import { writeFileAtomicSync } from "../../atomicFile.js";

export const SHELL_EXTENSION = "@workspace-extensions/shell";
export const TERMINAL_LAUNCH_ENV = "VIBESTUDIO_TERMINAL_LAUNCH";
const HOST_CALLER_ID = "terminal-apps";
const MAX_SETTINGS_BYTES = 4096;
const MAX_TITLE_LENGTH = 80;

/** What the program reads from its one-shot launch file (`@workspace/terminal-app`). */
export interface TerminalAppLaunchMaterial {
  gatewayUrl: string;
  principalId: string;
  connectionId: string;
  grant: string;
  sessionId: string;
  contextId: string;
  state: Record<string, unknown>;
  /** The app's display title; the program names its runtime with it. */
  title: string;
  approvalsKey?: string;
}

export interface TerminalAppUnit {
  source: string;
  title: string;
  icon?: string;
  effectiveVersion: string;
}

interface StoredSession {
  sessionId: string;
  userId: string;
  kind: "app" | "shell";
  source?: string;
  title: string;
  icon?: string;
  /** The session's own context (kept across relaunches); its folder is the cwd. */
  contextId?: string;
  /** Shells: what to run instead of the login shell (kept for relaunch). */
  program?: { command: string; args: string[] };
  /** Shells: the working directory inside the context's folder (kept for relaunch). */
  cwd?: string;
  /**
   * App sessions: the latest runtime incarnation. It is active while the
   * program runs and retired afterwards; its stateArgs carry over to the next.
   */
  entityId?: string;
  shellSessionId: string | null;
  running: boolean;
  exit?: { code: number | null; signal?: string };
  createdAt: number;
  lastActiveAt: number;
}

interface RegistryFile {
  version: 1;
  sessions: StoredSession[];
  settings: Record<string, Record<string, unknown>>;
}

export interface TerminalAppsServiceDeps {
  /** The person-facing workspace label for approvals ("Personal", "System", or its name). */
  workspaceLabel(): string;
  /** Registry file (inside the workspace's protected state). */
  registryPath: string;
  /** Launch-file directory inside the native runtime's writable home. */
  launchDirectory: string;
  /** The Node executable of the native runtime (same path inside the sandbox). */
  nodeExecutable(): string;
  /** Gateway URL the program connects to (loopback, reachable from the runtime). */
  gatewayUrl(): string;
  /** The terminal app at `source`, from the current workspace graph. */
  resolveUnit(source: string): Promise<TerminalAppUnit | null>;
  createEntity(
    caller: ReturnType<typeof createHostCaller>,
    spec: RuntimeEntityCreateSpec
  ): Promise<RuntimeEntityHandle>;
  retireEntity(id: string): Promise<void>;
  /** A fresh workspace context for a login shell session (its working folder). */
  createContext(caller: ReturnType<typeof createHostCaller>): Promise<string>;
  /** The stateArgs an incarnation last held (retired or active). */
  entityStateArgs(id: string): Promise<Record<string, unknown> | null>;
  /** Absolute path of a build's primary artifact. */
  primaryArtifactPath(buildKey: string): Promise<string>;
  grantConnection(principalId: string, issuedBy: string, subject: UserSubject): string;
  holdLease(input: {
    runtimeEntityId: string;
    connectionId: string;
    authorizedBy: string;
    holderLabel: string;
  }): void;
  dispatch(ctx: ServiceContext, service: string, method: string, args: unknown[]): Promise<unknown>;
  emitToUser(
    userId: string,
    event: typeof TERMINAL_SESSIONS_CHANGED_EVENT,
    payload: { sessions: TerminalSessionEntry[] }
  ): void;
  log?(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void;
}

function userSubject(ctx: ServiceContext): UserSubject {
  const userId = verifiedInitiatingUserId(ctx);
  if (!userId) {
    throw Object.assign(
      new Error("Terminal sessions belong to a person; this caller acts for no one"),
      {
        code: "EACCES",
      }
    );
  }
  const subject = ctx.authorizingCaller?.subject ?? ctx.caller.subject;
  if (!subject) throw new Error("Terminal sessions require an authenticated person");
  return subject;
}

function entryOf(session: StoredSession): TerminalSessionEntry {
  return {
    sessionId: session.sessionId,
    kind: session.kind,
    ...(session.source ? { source: session.source } : {}),
    title: session.title,
    ...(session.icon ? { icon: session.icon } : {}),
    ...(session.running && session.entityId ? { principalId: session.entityId } : {}),
    shellSessionId: session.running ? session.shellSessionId : null,
    running: session.running,
    ...(session.exit ? { exit: session.exit } : {}),
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
  };
}

function cleanTitle(title: string): string {
  return (
    title
      // oxlint-disable-next-line eslint/no-control-regex -- titles are shown in terminal chrome.
      .replace(/[\x00-\x1f\x7f]/gu, " ")
      .trim()
      .slice(0, MAX_TITLE_LENGTH) || "Terminal"
  );
}

export function createTerminalAppsService(
  deps: TerminalAppsServiceDeps
): ServiceDefinition & { stop(): Promise<void> } {
  let loaded: RegistryFile | null = null;
  /** The registry, loaded on first use (constructing the service does no I/O). */
  const registryFile = (): RegistryFile => {
    if (loaded) return loaded;
    const registry = loadRegistry(deps.registryPath);
    loaded = registry;
    // The server (and with it the shell extension and every PTY) restarted:
    // no session's program is running any more. State and context remain.
    for (const session of registry.sessions) {
      session.running = false;
      session.shellSessionId = null;
    }
    saveRegistry();
    // Incarnations from before the restart hold no PTY any more.
    const stale = registry.sessions.flatMap((session) =>
      session.entityId ? [session.entityId] : []
    );
    void Promise.allSettled(stale.map((id) => deps.retireEntity(id))).then((results) => {
      for (const result of results)
        if (result.status === "rejected")
          deps.log?.(
            "warn",
            "Could not retire a terminal app incarnation from before the restart",
            {
              error: String(result.reason),
            }
          );
    });
    return registry;
  };
  let stopped = false;
  // Cancels the service's own pending shell calls (exit watches) when it stops.
  const lifetime = new AbortController();
  const exitWatches = new Set<Promise<void>>();

  function saveRegistry(): void {
    fs.mkdirSync(path.dirname(deps.registryPath), { recursive: true });
    writeFileAtomicSync(deps.registryPath, JSON.stringify(registryFile(), null, 2));
  }

  function sessionsOf(userId: string): StoredSession[] {
    return registryFile()
      .sessions.filter((session) => session.userId === userId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  function changed(userId: string): void {
    saveRegistry();
    deps.emitToUser(userId, TERMINAL_SESSIONS_CHANGED_EVENT, {
      sessions: sessionsOf(userId).map(entryOf),
    });
  }

  function requireSession(userId: string, sessionId: string): StoredSession {
    const session = registryFile().sessions.find((s) => s.sessionId === sessionId);
    if (!session || session.userId !== userId) {
      throw Object.assign(new Error(`There is no terminal session ${sessionId}`), {
        code: "ENOENT",
      });
    }
    return session;
  }

  /** The shell extension, as the person (host-originated: this service already gated the run). */
  function shellAs(subject: UserSubject, method: string, args: unknown[]): Promise<unknown> {
    return deps.dispatch(
      { caller: createHostCaller(HOST_CALLER_ID, "server", subject), signal: lifetime.signal },
      "extensions",
      "invoke",
      [SHELL_EXTENSION, method, args]
    );
  }

  /**
   * The caller that creates a session's context. It acts as the server for the
   * person, and a launch made under a system-test policy keeps that policy: the
   * context it creates, and every agent the app starts in it, are then decided
   * by the same test authority rules as any other test context.
   */
  function contextCreator(ctx: ServiceContext, subject: UserSubject) {
    const testPolicy = ctx.caller.testPolicy ?? ctx.caller.executionSession?.testPolicy;
    return {
      ...createHostCaller(HOST_CALLER_ID, "server", subject),
      ...(testPolicy ? { testPolicy } : {}),
    };
  }

  /** Retire the latest incarnation (idempotent); its record keeps the stateArgs. */
  async function retireIncarnation(session: StoredSession): Promise<void> {
    if (session.entityId) await deps.retireEntity(session.entityId);
  }

  /** Whether the shell extension still runs this PTY (its authoritative state). */
  async function ptyAlive(subject: UserSubject, shellSessionId: string): Promise<boolean> {
    try {
      const info = (await shellAs(subject, "get", [shellSessionId])) as { alive: boolean };
      return info.alive;
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Follow the PTY to its exit (the shell extension's authoritative lifecycle). */
  function watchExit(session: StoredSession, subject: UserSubject, shellSessionId: string): void {
    const watch = (async () => {
      let exit: { code: number | null; signal?: string } | undefined;
      try {
        const result = (await shellAs(subject, "awaitExit", [shellSessionId])) as {
          exitCode: number | null;
          signal?: string;
        };
        exit = { code: result.exitCode, ...(result.signal ? { signal: result.signal } : {}) };
      } catch (error) {
        // The shell extension (and so the PTY) went away, or the session was
        // disposed: either way the program is no longer running.
        if (stopped) return;
        deps.log?.("warn", "Terminal session PTY ended without an exit status", {
          sessionId: session.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (stopped || session.shellSessionId !== shellSessionId) return;
      session.running = false;
      session.shellSessionId = null;
      if (exit) session.exit = exit;
      session.lastActiveAt = Date.now();
      try {
        await retireIncarnation(session);
      } finally {
        if (registryFile().sessions.includes(session)) changed(session.userId);
      }
    })().catch((error: unknown) =>
      deps.log?.("error", "Terminal session exit handling failed", {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    exitWatches.add(watch);
    void watch.finally(() => exitWatches.delete(watch));
  }

  async function start(
    ctx: ServiceContext,
    session: StoredSession,
    size: { cols: number; rows: number },
    approvalsKey: string | undefined
  ): Promise<void> {
    const subject = userSubject(ctx);
    let command: string | undefined;
    let args: string[] = [];
    let env: Record<string, string> = { COLORTERM: "truecolor" };
    let launchFile: string | null = null;
    // The session's context is created once, by this call, so it is the call's
    // test policy (if any) that the context, and so everything the app or
    // shell runs in it, is decided under. An app incarnation is then created
    // into that context; a context a runtime creates for itself would carry
    // no policy.
    session.contextId ??= await deps.createContext(contextCreator(ctx, subject));
    if (session.kind === "app") {
      const source = session.source!;
      const previousState = session.entityId ? await deps.entityStateArgs(session.entityId) : null;
      await retireIncarnation(session);
      const handle = await deps.createEntity(createHostCaller(HOST_CALLER_ID, "server", subject), {
        kind: "panel",
        execution: { surface: "code", source },
        key: `nav-term-${randomUUID()}`,
        contextId: session.contextId,
        ...(previousState ? { stateArgs: previousState } : {}),
      });
      session.entityId = handle.id;
      session.contextId = handle.contextId;
      if (!handle.buildKey) throw new Error(`${source} has no built program`);
      const connectionId = `terminal-${session.sessionId}-${randomUUID().slice(0, 8)}`;
      deps.holdLease({
        runtimeEntityId: handle.id,
        connectionId,
        authorizedBy: ctx.caller.runtime.id,
        holderLabel: "terminal session",
      });
      const material: TerminalAppLaunchMaterial = {
        gatewayUrl: deps.gatewayUrl(),
        principalId: handle.id,
        connectionId,
        grant: deps.grantConnection(handle.id, ctx.caller.runtime.id, subject),
        sessionId: session.sessionId,
        contextId: handle.contextId,
        state: previousState ?? {},
        title: session.title,
        ...(approvalsKey ? { approvalsKey } : {}),
      };
      await mkdir(deps.launchDirectory, { recursive: true, mode: 0o700 });
      launchFile = path.join(deps.launchDirectory, `${randomUUID()}.json`);
      await writeFile(launchFile, JSON.stringify(material), { mode: 0o600, flag: "wx" });
      command = deps.nodeExecutable();
      args = [await deps.primaryArtifactPath(handle.buildKey)];
      env = { ...env, [TERMINAL_LAUNCH_ENV]: launchFile };
    } else {
      if (session.program) {
        command = session.program.command;
        args = session.program.args;
      }
    }
    try {
      const opened = (await shellAs(subject, "open", [
        {
          ...(command ? { command, args } : {}),
          env,
          cols: size.cols,
          rows: size.rows,
          label: session.title,
          ...(session.cwd ? { cwd: session.cwd } : {}),
          ...(session.contextId ? { contextId: session.contextId } : {}),
        },
      ])) as { sessionId: string };
      session.shellSessionId = opened.sessionId;
      session.running = true;
      delete session.exit;
      session.lastActiveAt = Date.now();
      watchExit(session, subject, opened.sessionId);
    } catch (error) {
      if (launchFile) await rm(launchFile, { force: true });
      await retireIncarnation(session);
      throw error;
    }
  }

  async function prepareRun(ctx: ServiceContext, args: unknown[]) {
    const input = (args[0] ?? {}) as {
      source?: string;
      sessionId?: string;
      command?: string;
      args?: string[];
    };
    const userId = verifiedInitiatingUserId(ctx);
    const source =
      input.source ??
      (input.sessionId && userId
        ? registryFile().sessions.find(
            (s) => s.sessionId === input.sessionId && s.userId === userId
          )?.source
        : undefined);
    const unit = source ? await deps.resolveUnit(source) : null;
    if (source && !unit) throw new Error(`There is no terminal app at ${source}`);
    const stored =
      !source && input.sessionId
        ? registryFile().sessions.find((s) => s.sessionId === input.sessionId)?.program
        : undefined;
    const shellCommand = input.command
      ? [input.command, ...(input.args ?? [])].join(" ")
      : stored
        ? [stored.command, ...stored.args].join(" ")
        : undefined;
    const what = unit
      ? `${unit.title} ${unit.effectiveVersion.slice(0, 12)}`
      : shellCommand
        ? `\`${shellCommand.slice(0, 120)}\``
        : "a shell";
    const resource = {
      type: "terminal-app",
      label: unit ? unit.title : "Shell",
      value: `terminal-app:${source ?? "shell"}`,
    };
    return {
      selections: [
        fixedPreparedAuthoritySelection({
          capability: TERMINAL_APPS_RUN_CAPABILITY,
          resourceKey: resource.value,
          challenge: {
            title: `Run ${what} in ${deps.workspaceLabel()}?`,
            description: unit
              ? `${unit.title} runs as you in this workspace's native runtime, with its own connection to the workspace. It can do what its declared authority allows; anything further asks you first.`
              : shellCommand
                ? "This command runs as you in a terminal in this workspace's native runtime."
                : "A login shell runs as you in this workspace's native runtime.",
            deniedReason: "Running it was not approved",
            resource,
            operation: { kind: "unknown", verb: "Run", object: resource },
            details: [
              {
                label: "Program",
                value: unit ? `${unit.title} (${source})` : (shellCommand ?? "Login shell"),
              },
              ...(unit ? [{ label: "Version", value: unit.effectiveVersion.slice(0, 12) }] : []),
            ],
          },
        }),
      ],
      payload: { source: source ?? null },
    };
  }

  function requirePrepared(ctx: ServiceContext, source: string | undefined): void {
    const prepared = ctx.preparedAuthority;
    if (
      prepared?.resolver !== TERMINAL_APPS_RUN_PREPARATION ||
      (prepared.payload as { source?: unknown } | null)?.source !== (source ?? null)
    ) {
      throw new Error(
        "Running a terminal program requires the dispatcher's approved prepared state"
      );
    }
  }

  return {
    name: "terminalApps",
    description: "Terminal apps in workspace PTYs and each person's terminal sessions",
    authority: { principals: ["user", "code"] },
    methods: terminalAppsMethods,
    authorityPreparation: {
      [TERMINAL_APPS_RUN_PREPARATION]: prepareRun,
    },
    handler: defineServiceHandler("terminalApps", terminalAppsMethods, {
      list: (ctx) => sessionsOf(userSubject(ctx).userId).map(entryOf),
      launch: async (ctx, [input]) => {
        const subject = userSubject(ctx);
        requirePrepared(ctx, input.source);
        let unit: TerminalAppUnit | null = null;
        if (input.source !== undefined) {
          if (!isTerminalAppLocation(input.source)) {
            throw new Error(
              `${input.source} is not a terminal app (terminal apps live in terminal-apps/)`
            );
          }
          unit = await deps.resolveUnit(input.source);
          if (!unit) throw new Error(`There is no terminal app at ${input.source}`);
        }
        if (unit && (input.command || input.cwd || input.contextId)) {
          throw new Error("A terminal app takes no command, cwd or context of its own");
        }
        const now = Date.now();
        const session: StoredSession = {
          sessionId: randomUUID(),
          userId: subject.userId,
          kind: unit ? "app" : "shell",
          ...(unit ? { source: unit.source } : {}),
          ...(input.contextId ? { contextId: input.contextId } : {}),
          ...(input.command ? { program: { command: input.command, args: input.args ?? [] } } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          title: cleanTitle(unit ? unit.title : (input.label ?? input.command ?? "Shell")),
          ...(unit?.icon ? { icon: unit.icon } : {}),
          shellSessionId: null,
          running: false,
          createdAt: now,
          lastActiveAt: now,
        };
        await start(ctx, session, input, input.approvalsKey);
        registryFile().sessions.push(session);
        changed(subject.userId);
        return entryOf(session);
      },
      resume: async (ctx, [input]) => {
        const subject = userSubject(ctx);
        const session = requireSession(subject.userId, input.sessionId);
        requirePrepared(ctx, session.source);
        // Ask the PTY's owner, not this service's exit watch: the program may
        // have exited a moment before the watch reported it.
        if (
          session.running &&
          session.shellSessionId &&
          !(await ptyAlive(subject, session.shellSessionId))
        ) {
          session.running = false;
          session.shellSessionId = null;
          await retireIncarnation(session);
        }
        if (!session.running) await start(ctx, session, input, input.approvalsKey);
        session.lastActiveAt = Date.now();
        changed(subject.userId);
        return entryOf(session);
      },
      restart: async (ctx, [input]) => {
        const subject = userSubject(ctx);
        const session = requireSession(subject.userId, input.sessionId);
        requirePrepared(ctx, session.source);
        const previous = session.running ? session.shellSessionId : null;
        // Detach the exit watch first (it ignores a PTY that is no longer the
        // session's), then end the old PTY and start the program again.
        session.running = false;
        session.shellSessionId = null;
        try {
          if (previous) await shellAs(subject, "dispose", [previous]);
        } finally {
          await retireIncarnation(session);
        }
        await start(ctx, session, input, input.approvalsKey);
        session.lastActiveAt = Date.now();
        changed(subject.userId);
        return entryOf(session);
      },
      close: async (ctx, [sessionId]) => {
        const subject = userSubject(ctx);
        const session = requireSession(subject.userId, sessionId);
        const shellSessionId = session.running ? session.shellSessionId : null;
        session.running = false;
        session.shellSessionId = null;
        registryFile().sessions = registryFile().sessions.filter((s) => s !== session);
        try {
          if (shellSessionId) await shellAs(subject, "dispose", [shellSessionId]);
        } finally {
          await retireIncarnation(session);
          changed(subject.userId);
        }
      },
      getSettings: (ctx) => registryFile().settings[userSubject(ctx).userId] ?? {},
      setSettings: (ctx, [settings]) => {
        const userId = userSubject(ctx).userId;
        if (Buffer.byteLength(JSON.stringify(settings), "utf8") > MAX_SETTINGS_BYTES) {
          throw new Error(`Terminal settings must be at most ${MAX_SETTINGS_BYTES} bytes`);
        }
        registryFile().settings[userId] = settings;
        saveRegistry();
      },
    }),
    async stop() {
      stopped = true;
      lifetime.abort(new Error("The terminal launch service stopped"));
      await Promise.allSettled([...exitWatches]);
    },
  };
}

function loadRegistry(file: string): RegistryFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, sessions: [], settings: {} };
    }
    throw error;
  }
  const value = JSON.parse(raw) as Partial<RegistryFile>;
  if (value.version !== 1 || !Array.isArray(value.sessions)) {
    throw new Error(`Unrecognized terminal session registry at ${file}`);
  }
  return {
    version: 1,
    sessions: value.sessions,
    settings: value.settings && typeof value.settings === "object" ? value.settings : {},
  };
}
