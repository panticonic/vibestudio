import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  linkedClaudeMethods,
  type LinkedClaudeContinue,
  type LinkedClaudeStart,
  type LinkedClaudeSnapshot,
} from "@vibestudio/service-schemas/linkedClaude";
import {
  assertClaudeCodeVersion,
  materializeClaudeLaunch,
  reconcileClaudeLaunchCredential,
  removeMaterializedClaudeLaunch,
  type ClaudeCliRoute,
} from "@vibestudio/shared/claudeLaunchProfile";
import {
  prepareInstalledClaudeLaunch,
  installedClaudeCli,
} from "@vibestudio/shared/claudeInstalledLaunch";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";

import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { bindingForLiveAgentEntity } from "../hostCore/auth/agentEntity.js";

/** Credential verification happens at the owner store; every semantic launch
 * coordinate is then checked against the authoritative live entity graph. */
export function assertLinkedClaudeBinding(
  callerId: string,
  input: LinkedClaudeStart,
  authenticated: { entityId: string } | null,
  agentId: string,
  entity: EntityRecord | null,
  vessel: EntityRecord | null
) {
  const env = input.profile.environment;
  const binding = bindingForLiveAgentEntity(entity, agentId);
  const state = vessel?.stateArgs as
    | {
        linkedEntityId?: string;
        subagent?: { runId?: string; parentChannelId?: string };
      }
    | undefined;
  if (
    !authenticated ||
    authenticated.entityId !== env.VIBESTUDIO_ENTITY_ID ||
    !entity ||
    entity.parentId !== callerId ||
    !binding ||
    binding.contextId !== env.VIBESTUDIO_CONTEXT_ID ||
    binding.channelId !== env.VIBESTUDIO_CHANNEL_ID ||
    !vessel ||
    vessel.status !== "active" ||
    vessel.kind !== "do" ||
    vessel.parentId !== callerId ||
    vessel.contextId !== binding.contextId ||
    vessel.agentBinding?.entityId !== entity.id ||
    vessel.agentBinding?.channelId !== binding.channelId ||
    state?.linkedEntityId !== entity.id ||
    state.subagent?.runId !== env.VIBESTUDIO_SUBAGENT_RUN_ID ||
    state.subagent?.parentChannelId !== env.VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID
  )
    throw new Error(
      "Linked Claude requires the exact owned live session, credential and vessel binding"
    );
  return binding;
}

export interface LinkedClaudeResources {
  cleanup(): Promise<void>;
}
export interface LinkedClaudeExecution extends LinkedClaudeResources {
  child: ChildProcess;
  continue(input: LinkedClaudeContinue): Promise<ChildProcess>;
}
export interface LinkedClaudeServiceDeps {
  appRoot: string;
  profilesRoot: string;
  authorize(
    ctx: ServiceContext,
    input: LinkedClaudeStart
  ): Promise<{ contextDirectory: string; route: ClaudeCliRoute }>;
  launch?: (
    input: LinkedClaudeStart,
    paths: { contextDirectory: string; route: ClaudeCliRoute },
    retain: (resources: LinkedClaudeResources) => void
  ) => Promise<LinkedClaudeExecution>;
}

export function linkedClaudeHeadlessArguments(
  input: Pick<LinkedClaudeStart, "prompt" | "options">,
  resumeSessionId?: string,
  initialSessionId?: string
): string[] {
  const options = input.options ?? {};
  const args = ["--permission-mode", options.permissionMode ?? "auto"];
  for (const [key, flag] of [
    ["model", "--model"],
    ["fallbackModel", "--fallback-model"],
    ["effort", "--effort"],
    ["maxBudgetUsd", "--max-budget-usd"],
  ] as const) {
    if (options[key] !== undefined) args.push(flag, String(options[key]));
  }
  return [
    ...args,
    ...(resumeSessionId
      ? ["--resume", resumeSessionId]
      : initialSessionId
        ? ["--session-id", initialSessionId]
        : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    "mcp__vibestudio__say,mcp__vibestudio__complete",
    "--strict-mcp-config",
    "-p",
    input.prompt,
  ];
}

/** Local linked-provider owner. Policy inputs and machine credentials never come
 * from workspace paths. The RPC connection owns launch lifetime; generation IDs
 * never authorize another connection to inspect, stop, or reuse a launch. */
export function createLinkedClaudeService(
  deps: LinkedClaudeServiceDeps
): ServiceDefinition & { stop(): Promise<void> } {
  interface Session {
    owner: string;
    connection: AbortSignal;
    execution: LinkedClaudeExecution | null;
    resources: LinkedClaudeResources | null;
    snapshot: LinkedClaudeSnapshot;
    finishing: Promise<void> | null;
    pending: Promise<void>;
    retiring: Promise<void> | null;
  }
  const sessions = new Map<string, Session>();
  const connections = new WeakMap<AbortSignal, string>();
  let stopped = false;
  const owner = (ctx: ServiceContext) => {
    const connection = ctx.connectionSignal;
    if (
      stopped ||
      !connection ||
      connection.aborted ||
      ctx.signal?.aborted ||
      ctx.caller.runtime.kind !== "extension"
    )
      throw new Error("Linked Claude requires a live authenticated extension connection");
    let id = connections.get(connection);
    if (!id) {
      id = randomUUID();
      connections.set(connection, id);
      connection.addEventListener(
        "abort",
        () => {
          for (const session of sessions.values())
            if (session.connection === connection)
              void retire(session).catch((error) =>
                console.warn("Linked Claude retirement failed", error.message)
              );
        },
        { once: true }
      );
    }
    return {
      connection,
      key: JSON.stringify([ctx.caller.runtime.id, ctx.caller.code?.executionDigest ?? null, id]),
    };
  };
  const finish = (session: Session): Promise<void> => {
    if (session.finishing) return session.finishing;
    const work = (async () => {
      if (session.resources) await session.resources.cleanup();
      session.resources = null;
      session.execution = null;
    })();
    session.finishing = work;
    work.catch(() => {
      if (session.finishing === work) session.finishing = null;
    });
    return work;
  };
  const retire = (session: Session): Promise<void> => {
    if (session.retiring) return session.retiring;
    const work = (async () => {
      await session.pending;
      const child = session.execution?.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const end = Date.now() + 5000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < end)
          await new Promise((resolve) => setTimeout(resolve, 25));
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          const forced = Date.now() + 3000;
          while (child.exitCode === null && child.signalCode === null && Date.now() < forced)
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (child.exitCode === null && child.signalCode === null)
          throw new Error("Linked Claude exit is unconfirmed; profile retained");
      }
      await finish(session);
      sessions.delete(session.snapshot.generationId);
    })();
    session.retiring = work;
    work.catch(() => {
      if (session.retiring === work) session.retiring = null;
    });
    return work;
  };
  const launch: NonNullable<LinkedClaudeServiceDeps["launch"]> =
    deps.launch ??
    (async (input, paths, retain) => {
      await assertClaudeCodeVersion();
      const materialized = await materializeClaudeLaunch({
        profile: input.profile,
        profilesRoot: deps.profilesRoot,
        cliRoute: paths.route,
        cli: installedClaudeCli(deps.appRoot),
      });
      let started = false;
      let reconciled = false;
      const resources: LinkedClaudeResources = {
        async cleanup() {
          if (started && !reconciled) {
            await reconcileClaudeLaunchCredential(materialized, deps.appRoot);
            reconciled = true;
          }
          await removeMaterializedClaudeLaunch(materialized, deps.appRoot);
        },
      };
      // Register owner resources before any preparation can reject. The same
      // retirement operation retries them even when no child was ever created.
      retain(resources);
      const baseArgv = [...materialized.argv];
      const start = async (
        turn: Pick<LinkedClaudeStart, "prompt" | "options">,
        sessionId?: string,
        initialSessionId?: string
      ) => {
        materialized.argv = [
          ...baseArgv,
          ...linkedClaudeHeadlessArguments(turn, sessionId, initialSessionId),
        ];
        const confined = await prepareInstalledClaudeLaunch(
          materialized,
          paths.contextDirectory,
          deps.appRoot
        );
        const child = spawn(confined.command, confined.args, {
          cwd: paths.contextDirectory,
          env: confined.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        return child;
      };
      const child = await start(input, undefined, input.profile.launchId);
      started = true;
      return {
        child,
        cleanup: resources.cleanup,
        continue: (next) => start(next, next.sessionId),
      };
    });
  const requireSession = (
    ctx: ServiceContext,
    reference: { entityId: string; generationId: string }
  ) => {
    const identity = owner(ctx);
    const session = sessions.get(reference.generationId);
    if (
      !session ||
      session.owner !== identity.key ||
      session.snapshot.entityId !== reference.entityId
    )
      throw Object.assign(new Error("Linked Claude generation does not belong to this caller"), {
        code: "EACCES",
      });
    return session;
  };
  const observeChild = (session: Session, child: ChildProcess) => {
    session.execution!.child = child;
    session.snapshot = {
      ...session.snapshot,
      state: "running",
      pid: child.pid ?? null,
      exit: null,
      log: { bytes: 0, tail: "", truncated: false },
    };
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        const log = session.snapshot.log;
        log.bytes += Buffer.byteLength(chunk);
        log.tail = Buffer.from(log.tail + String(chunk))
          .subarray(-262144)
          .toString("utf8");
        log.truncated = log.bytes > Buffer.byteLength(log.tail);
      });
    const exited = (code: number | null, signal: string | null) => {
      session.snapshot.state = "exited";
      session.snapshot.exit = { code, signal, at: new Date().toISOString() };
    };
    child.once("close", exited);
    child.on("error", (error) => console.warn("Linked Claude process error", error.message));
    if (child.exitCode !== null || child.signalCode !== null)
      exited(child.exitCode, child.signalCode);
  };
  return {
    name: "linkedClaude",
    description: "Trusted linked Claude execution with receiver-owned host resources",
    authority: { principals: ["user", "code"] },
    methods: linkedClaudeMethods,
    handler: defineServiceHandler("linkedClaude", linkedClaudeMethods, {
      start: async (ctx, [input]) => {
        const identity = owner(ctx);
        const id = input.profile.launchId;
        const paths = await deps.authorize(ctx, input);
        if (stopped || identity.connection.aborted)
          throw new Error("Linked Claude owner retired during authorization");
        if (sessions.has(id)) throw new Error("Linked Claude generation already exists");
        if (sessions.size >= 32) throw new Error("Linked Claude concurrency limit reached");
        let prepared!: () => void;
        const pending = new Promise<void>((resolve) => {
          prepared = resolve;
        });
        const session: Session = {
          owner: identity.key,
          connection: identity.connection,
          execution: null,
          resources: null,
          finishing: null,
          pending,
          retiring: null,
          snapshot: {
            generationId: id,
            entityId: input.profile.environment.VIBESTUDIO_ENTITY_ID,
            state: "running",
            pid: null,
            exit: null,
            log: { bytes: 0, tail: "", truncated: false },
          },
        };
        sessions.set(id, session);
        try {
          try {
            session.execution = await launch(input, paths, (resources) => {
              session.resources = resources;
            });
            session.resources ??= session.execution;
          } finally {
            prepared();
          }
          observeChild(session, session.execution.child);
          if (stopped || identity.connection.aborted) {
            await retire(session);
            throw new Error("Linked Claude caller disconnected during startup");
          }
          return structuredClone(session.snapshot);
        } catch (error) {
          prepared();
          if (!session.execution) {
            session.snapshot.state = "exited";
            session.snapshot.exit = {
              code: null,
              signal: "startup-error",
              at: new Date().toISOString(),
            };
          }
          try {
            await retire(session);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Linked Claude startup and retirement failed; ownership retained"
            );
          }
          throw error;
        }
      },
      continue: async (ctx, [input]) => {
        const session = requireSession(ctx, input);
        if (session.snapshot.state !== "exited" || !session.execution)
          throw new Error("Linked Claude generation is not idle");
        const child = await session.execution.continue(input);
        observeChild(session, child);
        return structuredClone(session.snapshot);
      },
      interrupt: async (ctx, [reference]) => {
        const session = requireSession(ctx, reference);
        const child = session.execution?.child;
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill("SIGTERM");
          await closed;
        }
        return structuredClone(session.snapshot);
      },
      inspect: (ctx, [reference]) => structuredClone(requireSession(ctx, reference).snapshot),
      stop: async (ctx, [reference]) => {
        owner(ctx);
        if (!sessions.has(reference.generationId)) return { stopped: false };
        const session = requireSession(ctx, reference);
        await retire(session);
        return { stopped: true };
      },
    }),
    async stop() {
      stopped = true;
      const results = await Promise.allSettled([...sessions.values()].map(retire));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    },
  };
}
