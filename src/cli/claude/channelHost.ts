/**
 * `vibestudio claude channel-host` — the bridge Claude Code spawns as its
 * channel MCP server (plan §7). One process, four relays:
 *
 *   1. stdio MCP toward Claude Code (channel events in, say/complete out),
 *   2. vessel attachment over the ordinary authenticated RPC client,
 *   3. hook ingestion (unix socket ← `vibestudio claude emit`).
 *
 * Only the controlled `vibestudio claude` launcher may start this bridge. That
 * launcher places Claude behind the OS read-only projection boundary before
 * supplying the profile env. Unmanaged/plugin adoption is intentionally absent:
 * the bridge cannot retrofit filesystem containment around an already-running
 * process.
 */

import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { readChannelSubscriptionRecords } from "@vibestudio/service-schemas/channel";
import { loadCliCredentials, type CliAgentCredentials } from "../credentialStore.js";
import { RpcClient } from "../rpcClient.js";
import { CliError } from "../output.js";
import {
  McpStdioServer,
  toolText,
  type ChannelNotificationMeta,
  type McpResourceContents,
  type McpResourceDef,
  type McpToolDef,
  type McpToolResult,
} from "./mcpServer.js";
import {
  TurnTracker,
  mapHookEvent,
  startHookSocketServer,
  type EmittedHookLine,
} from "./hookSocket.js";

export interface BridgeConfig {
  mode: "launched";
  credentials: CliAgentCredentials;
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  /** Unix socket paths to listen on for hook emissions. */
  hookSocketPaths: string[];
  /** Present when this session was spawned as a subagent (launch profile carries
   *  VIBESTUDIO_SUBAGENT_*): the bridge states the duty definitively in the MCP
   *  instructions instead of hedging on "if this is a task channel". */
  subagent?: BridgeSubagentInfo;
}

export interface BridgeSubagentInfo {
  runId: string;
  parentChannelId: string;
  /** Rendered subagent operating contract (userland-owned text; the bridge
   *  embeds it verbatim — semantics live with the vessel, not here). */
  contract: string;
}

/** Parse the optional subagent duty out of a launch-profile env record. */
function subagentFromEnv(env: Record<string, string | undefined>): BridgeSubagentInfo | undefined {
  const runId = env["VIBESTUDIO_SUBAGENT_RUN_ID"];
  if (!runId) return undefined;
  return {
    runId,
    parentChannelId: env["VIBESTUDIO_SUBAGENT_PARENT_CHANNEL_ID"] ?? "",
    contract: env["VIBESTUDIO_SUBAGENT_CONTRACT"] ?? "",
  };
}

/**
 * Resolve a complete controlled-launch profile. There is no fallback path: an
 * already-running Claude process cannot be made read-only by this child MCP
 * server, so accepting one would reopen an unprovenanced native-write path.
 */
export interface BridgeEnvironment {
  loadCredentials?: typeof loadCliCredentials;
}

export async function resolveBridgeConfig(
  env: NodeJS.ProcessEnv,
  environment: BridgeEnvironment = {}
): Promise<BridgeConfig> {
  const entityId = env["VIBESTUDIO_ENTITY_ID"];
  const contextId = env["VIBESTUDIO_CONTEXT_ID"];
  const channelId = env["VIBESTUDIO_CHANNEL_ID"];
  const vesselRef = env["VIBESTUDIO_VESSEL_REF"];
  const profile = env["VIBESTUDIO_LAUNCH_PROFILE"];
  if (!entityId || !contextId || !channelId || !vesselRef || !profile) {
    throw new CliError(
      "unmanaged linked-Claude adoption is unsupported: launch with `vibestudio claude` so the managed context and CLI identity are owner-provisioned"
    );
  }
  const credentials = (environment.loadCredentials ?? loadCliCredentials)();
  if (!credentials || credentials.kind !== "agent") {
    throw new CliError("managed Claude channel host requires its canonical agent CLI profile");
  }
  if (credentials.entityId !== entityId || credentials.contextId !== contextId) {
    throw new CliError(
      "managed Claude launch coordinates do not match its canonical agent CLI profile"
    );
  }
  const subagent = subagentFromEnv(env);
  return {
    mode: "launched",
    credentials,
    entityId,
    contextId,
    channelId,
    vesselRef,
    hookSocketPaths: [path.join(profile, "hook.sock")],
    ...(subagent ? { subagent } : {}),
  };
}

// ---------------------------------------------------------------------------
// The running bridge
// ---------------------------------------------------------------------------

const SAY_TOOL: McpToolDef = {
  name: "say",
  description:
    "Send a message to the workspace conversation this session is linked to. " +
    "This is the deliberate act of addressing the workspace — terminal output " +
    "is only seen by the local human.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Message text (markdown)" },
      mentions: {
        type: "array",
        items: { type: "string" },
        description: "Participant handles to mention",
      },
    },
    required: ["text"],
  },
};

const COMPLETE_TOOL: McpToolDef = {
  name: "complete",
  description:
    "Complete the task this session was spawned for (task channels only): " +
    "publishes the final report and settles the parent's invocation. " +
    "A normal final message does NOT settle the run — only this tool does. " +
    "Use outcome 'success' only when the task is complete enough for the parent " +
    "to act on; 'failed' when blocked (report what you tried and whether partial " +
    "work exists).",
  inputSchema: {
    type: "object",
    properties: {
      report: { type: "string", description: "Final report for the parent agent" },
      outcome: { type: "string", enum: ["success", "failed"] },
    },
    required: ["report"],
  },
};

// ── Workspace skills as MCP resources ────────────────────────────────────────
// The workspace's own skill library (skills/* in the workspace tree, indexed by
// `workspace.listSkills`) is invisible to Claude Code's native .claude/skills
// discovery. Expose it through the standard MCP resources surface instead:
// resources/list = the catalog, resources/read = the SKILL.md wrapped in an
// addendum translating Pi-agent idioms into what a linked session actually has.

const SKILL_RESOURCE_SCHEME = "vibestudio-skill://";

export function skillResourceUri(name: string): string {
  return `${SKILL_RESOURCE_SCHEME}${encodeURIComponent(name)}`;
}

export function skillNameFromUri(uri: string): string | null {
  if (!uri.startsWith(SKILL_RESOURCE_SCHEME)) return null;
  const name = decodeURIComponent(uri.slice(SKILL_RESOURCE_SCHEME.length));
  return name.length > 0 ? name : null;
}

/**
 * Prepended to every workspace skill served over the bridge: workspace skills
 * are written for the in-process (Pi) agents, whose runtime differs from a
 * linked Claude Code session's in specific, predictable ways.
 */
export const WORKSPACE_SKILL_ADDENDUM = `> **You are reading a WORKSPACE skill as a linked Claude Code session.**
> It is written for the workspace's in-process (Pi) agents; translate as you read:
>
> - Pi loop tools named in skills (\`spawn_subagent\`, \`read_subagent\`,
>   \`inspect_subagent\`, \`merge_subagent\`, \`suspend_turn\`, \`ask_user\`, panel
>   \`handle.*\`) are NOT your tools. Your MCP tools are \`say\` and \`complete\`;
>   workspace skills are available as MCP resources. This session has an ordinary
>   entity-scoped \`vibestudio\` CLI login; commands are authorized exactly as
>   this linked agent, without a human device identity.
>   You cannot spawn subagents — \`say\` a delegation or implementation request to
>   the workspace agent in your conversation instead.
> - TypeScript snippets that import \`@workspace/*\` or call runtime bindings are
>   examples for in-process agents, not commands this linked session can execute.
> - Panel automation examples (\`handle.cdp.screenshot()\` etc.) may map to
>   ordinary \`vibestudio panel\` commands when the linked agent is authorized.
> - Approval examples do not map to a workspace relay in this checkpoint.
>   Interactive Claude Code permissions remain in its local terminal; headless
>   permissions follow the launcher's explicit permission mode.
> - Files a skill references beside its SKILL.md (RECIPES.md, references/…)
>   can be read through ordinary authorized \`vibestudio fs\` commands.

---

`;

/**
 * Build the MCP resources hooks over the bridge's authenticated RPC client.
 * The linked-session addendum is prepended to the FIRST skill read of this
 * bridge process only (one bridge process = one session): the translation
 * rules are session-wide context, not per-document content, so repeating them
 * on every read would just burn tokens.
 */
export function createSkillResources(call: <T>(method: string, args: unknown[]) => Promise<T>): {
  list(): Promise<McpResourceDef[]>;
  read(uri: string): Promise<McpResourceContents>;
} {
  let addendumServed = false;
  return {
    list: async () => {
      const skills = await call<Array<{ name: string; description?: string; dirPath?: string }>>(
        "workspace.listSkills",
        []
      );
      // Keyed by canonical repo path because skill display names are not unique.
      return skills.map((skill) => ({
        uri: skillResourceUri(skill.dirPath ?? skill.name),
        name: skill.name,
        description: `Workspace skill (${skill.dirPath ?? skill.name}): ${
          skill.description ?? skill.name
        }`,
        mimeType: "text/markdown",
      }));
    },
    read: async (uri) => {
      const name = skillNameFromUri(uri);
      if (!name) throw new Error(`not a workspace skill resource: ${uri}`);
      const content = await call<string>("workspace.readSkill", [name]);
      const withAddendum = addendumServed ? content : `${WORKSPACE_SKILL_ADDENDUM}${content}`;
      addendumServed = true;
      return {
        contents: [{ uri, mimeType: "text/markdown", text: withAddendum }],
      };
    },
  };
}

export function bridgeInstructions(config: BridgeConfig): string {
  const sections = [
    "You are linked to a vibestudio workspace conversation as a peer agent.",
    "",
    `Channel events arrive as <channel source="vibestudio"> blocks, queued to your next turn. ` +
      "meta attributes: channel_id (conversation), seq (durable position), from/from_handle " +
      "(sender), kind (event kind), turn_id (sender's turn).",
    "",
    "Etiquette: your terminal output is visible only to the local human. To address the " +
      "workspace conversation, call the `say` tool deliberately. Your prompts, tool use, and " +
      "final answers are mirrored into the conversation's trajectory automatically — `say` is " +
      "for messages the conversation should actually receive.",
    "",
    "This linked process has one ordinary entity-scoped `vibestudio` CLI login, pre-scoped " +
      "to the linked context. It may invoke any public CLI operation authorized to this " +
      "agent identity; it does not inherit a human device identity or device-management authority. " +
      "Native Edit/Write/Bash changes to projected repository bytes are not " +
      "semantic work and will be discarded by projection; do not use them. Ask the workspace " +
      "agent with `say` when an operation is not authorized. The `vibestudio-agent` skill " +
      "resource documents the exact boundary.",
    "",
    "The local context is a read-only projection and may begin sparse. Use authorized " +
      "`vibestudio fs` reads to inspect semantic workspace state and materialize repository " +
      "content for local read-only tools.",
    "",
    "The workspace's own skill library (how-to guides for working in THIS workspace: " +
      "subagents, testing, panel dev, provenance, …) is exposed as MCP resources on this " +
      "server — list them and read any that match your task. Each is served with an " +
      "addendum translating its Pi-agent idioms to your session's surfaces.",
  ];
  if (config.subagent) {
    sections.push(
      "",
      `You were spawned as a SUBAGENT (run ${config.subagent.runId}) working for a parent ` +
        "agent; this conversation is your task channel. Your task may also appear as a channel " +
        "event — it is the same task you already have, not a new instruction.",
      ...(config.subagent.contract ? ["", config.subagent.contract] : []),
      "",
      "This session is headless and supervised: finish with a concise final report. " +
        "The launcher consumes Claude Code's typed terminal result and settles the parent. " +
        "Do not print or imitate `complete({...})` tool syntax; that would only be text."
    );
  } else {
    sections.push(
      "",
      "If this is a task channel (you were spawned as a subagent), finish by calling " +
        "`complete` with your report."
    );
  }
  return sections.join("\n");
}

export interface ChannelHostDeps {
  makeClient?: (config: BridgeConfig) => RpcClient;
  log?: (message: string) => void;
}

export const CLAUDE_CHANNEL_READINESS = Object.freeze({
  mcpTransport: "initialized",
  channelRegistration: "unconfirmed",
  reason: "claude-protocol-has-no-registration-ack",
});

const OFFICIAL_CHANNEL_META_KEYS = [
  "channel_id",
  "seq",
  "from",
  "from_handle",
  "kind",
  "turn_id",
] as const;

/** Adapt durable event details to Claude's public string-only meta schema. */
export function channelNotificationMeta(
  raw: Record<string, unknown>,
  kind: "message" | "prompt" | "interrupt"
): ChannelNotificationMeta {
  const candidate: Record<string, unknown> = { ...raw, kind };
  const result: ChannelNotificationMeta = {};
  for (const key of OFFICIAL_CHANNEL_META_KEYS) {
    const value = candidate[key];
    if (typeof value === "string") {
      result[key] = value;
    } else if (key === "seq" && typeof value === "number" && Number.isFinite(value)) {
      result[key] = String(value);
    }
  }
  return result;
}

interface ChannelMcpDelivery {
  notifyChannel(content: string, meta: ChannelNotificationMeta): Promise<void>;
  notifyPermission(requestId: string, behavior: "allow" | "deny"): Promise<void>;
}

export class BridgeTurnBatcher {
  private nextBatch = 0;
  private pendingBatchId: string | null = null;
  private activeBatchId: string | null = null;

  constructor(private readonly bridgeSessionId: string) {}

  assignDelivery(): string {
    this.pendingBatchId ??= `${this.bridgeSessionId}:batch:${++this.nextBatch}`;
    return this.pendingBatchId;
  }

  coordinatesForHook(event: ReturnType<typeof mapHookEvent>): {
    batchId?: string;
    interruptedBatchId?: string;
    commit(): void;
  } {
    if (!event) return { commit: () => undefined };
    if (event.hook === "UserPromptSubmit") {
      const interruptedBatchId = this.activeBatchId ?? undefined;
      return {
        ...(interruptedBatchId ? { interruptedBatchId } : {}),
        commit: () => {
          if (interruptedBatchId && this.activeBatchId === interruptedBatchId) {
            this.activeBatchId = null;
          }
        },
      };
    }
    if (event.hook === "SessionEnd") {
      return {
        commit: () => {
          this.activeBatchId = null;
        },
      };
    }
    if (!("turnSource" in event) || event.turnSource === "local") {
      return { commit: () => undefined };
    }
    if (!this.activeBatchId) {
      if (!this.pendingBatchId) {
        throw new Error(`channel-driven ${event.hook} has no accepted delivery batch`);
      }
      this.activeBatchId = this.pendingBatchId;
      this.pendingBatchId = null;
    }
    const batchId = this.activeBatchId;
    const terminal = event.hook === "Stop" || event.hook === "StopFailure";
    return {
      batchId,
      commit: () => {
        if (terminal && this.activeBatchId === batchId) this.activeBatchId = null;
      },
    };
  }
}

export class OrderedHookIngestor {
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | null = null;

  enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      await operation();
    });
    this.tail = task.catch((error) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
    });
    return task;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

/** Deliver one bridge record without advancing its durable cursor prematurely. */
export async function deliverBridgePayload(
  payload: unknown,
  deps: {
    channelId: string;
    bridgeSessionId: string;
    attachmentGeneration: string;
    batcher: BridgeTurnBatcher;
    mcp: ChannelMcpDelivery;
    callVessel(method: string, args: unknown[]): Promise<unknown>;
  }
): Promise<void> {
  const event = (payload ?? {}) as Record<string, unknown>;
  switch (event["kind"]) {
    case "message":
    case "prompt": {
      const seq = Number(event["seq"]);
      const deliveryId = typeof event["deliveryId"] === "string" ? event["deliveryId"] : "";
      const eventSessionId =
        typeof event["bridgeSessionId"] === "string" ? event["bridgeSessionId"] : "";
      const eventGeneration =
        typeof event["attachmentGeneration"] === "string" ? event["attachmentGeneration"] : "";
      if (
        !Number.isFinite(seq) ||
        !deliveryId ||
        eventSessionId !== deps.bridgeSessionId ||
        eventGeneration !== deps.attachmentGeneration
      ) {
        throw new Error("linked delivery record has a stale or incomplete attachment identity");
      }
      const content = typeof event["content"] === "string" ? event["content"] : "";
      const meta = (event["meta"] ?? {}) as Record<string, unknown>;
      await deps.mcp.notifyChannel(
        content,
        channelNotificationMeta(meta, event["kind"] as "message" | "prompt")
      );
      const batchId = deps.batcher.assignDelivery();
      await deps.callVessel("acceptDelivery", [
        {
          bridgeSessionId: deps.bridgeSessionId,
          attachmentGeneration: deps.attachmentGeneration,
          deliveryId,
          batchId,
        },
      ]);
      return;
    }
    case "permission": {
      const requestId = typeof event["requestId"] === "string" ? event["requestId"] : "";
      const behavior = event["behavior"] === "allow" ? "allow" : "deny";
      if (requestId) await deps.mcp.notifyPermission(requestId, behavior);
      return;
    }
    case "interrupt":
      await deps.mcp.notifyChannel(
        "[interrupt requested from the workspace]",
        channelNotificationMeta({ channel_id: deps.channelId }, "interrupt")
      );
      return;
    default:
      return;
  }
}

export async function runChannelHostLoop(
  config: BridgeConfig,
  deps: ChannelHostDeps = {}
): Promise<number> {
  const log = deps.log ?? ((message: string) => console.error(`[channel-host] ${message}`));
  const client = deps.makeClient ? deps.makeClient(config) : new RpcClient(config.credentials);

  const vessel = {
    call: <T>(method: string, args: unknown[] = []): Promise<T> =>
      client.callTargetPush<T>(config.vesselRef, method, args),
    stream: (method: string, args: unknown[], signal: AbortSignal): Promise<Response> =>
      client.stream(config.vesselRef, method, args, { signal }),
  };

  // A random process-lifetime identity survives response recovery without
  // inheriting authority from a reused PID or wall-clock coordinate.
  const bridgeSessionId = randomUUID();
  const batcher = new BridgeTurnBatcher(bridgeSessionId);
  let hookSeq = 0;
  const turns = new TurnTracker();
  const pendingToolIds = new Map<string, string>();
  let shuttingDown = false;
  let requestShutdown: ((code: number) => void) | null = null;
  let pendingMcpFailure: Error | null = null;

  // ── MCP toward Claude Code ────────────────────────────────────────────────
  const mcp = new McpStdioServer(process.stdin, process.stdout, {
    serverName: "vibestudio",
    serverVersion: "1.0.0",
    instructions: bridgeInstructions(config),
    tools: [SAY_TOOL, COMPLETE_TOOL],
    resources: createSkillResources((method, args) => client.call(method, args)),
    log,
    onToolCall: async (name, args, requestId): Promise<McpToolResult> => {
      if (name === "say") {
        const text = typeof args["text"] === "string" ? args["text"] : "";
        if (!text.trim()) return toolText("say requires non-empty text", true);
        const result = await vessel.call<{ messageId: string; channelId: string }>("say", [
          {
            text,
            ...(Array.isArray(args["mentions"]) ? { mentions: args["mentions"] } : {}),
            idempotencyKey: `mcp:${bridgeSessionId}:${requestId}`,
          },
        ]);
        return toolText(`sent to ${result.channelId}`);
      }
      if (name === "complete") {
        const report = typeof args["report"] === "string" ? args["report"] : "";
        const outcome = args["outcome"] === "failed" ? "failed" : "success";
        await vessel.call("completeFromBridge", [{ report, outcome }]);
        return toolText("task completed — the parent has been settled");
      }
      return toolText(`unknown tool: ${name}`, true);
    },
    onTransportFailure: (error) => {
      log(`MCP transport failed: ${error.message}`);
      if (requestShutdown) requestShutdown(1);
      else pendingMcpFailure = error;
    },
  });
  // ── Ordered hook lifetime ─────────────────────────────────────────────────
  // Bind before MCP initialization can complete so SessionStart cannot race a
  // lazily-created socket. Each socket waits for this one durable ingestion tail.
  const hookIngestor = new OrderedHookIngestor();
  const hookServer = startHookSocketServer(
    config.hookSocketPaths,
    (line: EmittedHookLine) =>
      hookIngestor.enqueue(async () => {
        const mapped = mapHookEvent(line, turns, pendingToolIds);
        if (!mapped) return;
        const coordinates = batcher.coordinatesForHook(mapped);
        const seq = hookSeq + 1;
        await vessel.call("ingestHookEvent", [
          {
            bridgeSessionId,
            seq,
            ...(coordinates.batchId ? { batchId: coordinates.batchId } : {}),
            ...(coordinates.interruptedBatchId
              ? { interruptedBatchId: coordinates.interruptedBatchId }
              : {}),
            event: mapped,
          },
        ]);
        hookSeq = seq;
        coordinates.commit();
      }),
    log
  );
  try {
    await hookServer.ready;
  } catch (error) {
    await hookServer.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    throw error;
  }
  log(`listening for hooks on ${hookServer.paths.join(", ") || "(no sockets bound)"}`);
  mcp.start();

  // ── Response-owned bridge lifetime ────────────────────────────────────────

  interface ActiveBridge {
    generation: number;
    attachmentGeneration: string | null;
    controller: AbortController;
    terminal: Promise<void>;
  }
  let activeBridge: ActiveBridge | null = null;
  let bridgeGeneration = 0;
  let bridgeRefresh: Promise<void> = Promise.resolve();
  let stopRecovery = (): void => {};

  // An unexpected terminal response means the host no longer has a truthful
  // attachment. The bridge process exits instead of inventing a second
  // application-level reconnect loop. Actual transport recovery is the one
  // event that may replace the response below.
  let resolveDone: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopRecovery();
    // Stop hook admission and drain the exact in-flight durable hook before
    // closing its RPC authority or response-owned bridge.
    await hookServer.close().catch(() => undefined);
    await hookIngestor.drain();
    const bridge = activeBridge;
    activeBridge = null;
    bridge?.controller.abort();
    await bridge?.terminal.catch(() => {});
    await client.close().catch(() => undefined);
    resolveDone(code);
  };
  requestShutdown = (code) => void shutdown(code);
  if (pendingMcpFailure) requestShutdown(1);

  const openBridge = async (): Promise<void> => {
    const previous = activeBridge;
    const generation = ++bridgeGeneration;
    previous?.controller.abort();
    await previous?.terminal.catch(() => {});
    if (shuttingDown) return;

    const controller = new AbortController();
    let resolveAck!: (result: {
      pendingCount: number;
      bridgeSessionId: string;
      attachmentGeneration: string;
    }) => void;
    let rejectAck!: (error: Error) => void;
    let acknowledged = false;
    const ack = new Promise<{
      pendingCount: number;
      bridgeSessionId: string;
      attachmentGeneration: string;
    }>((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    const terminal = (async () => {
      try {
        const response = await vessel.stream(
          "openBridge",
          [
            {
              bridgeSessionId,
              sessionInfo: {
                bridge: bridgeSessionId,
                mode: config.mode,
                pid: process.pid,
                agentKind: "claude-code",
                channelReadiness: CLAUDE_CHANNEL_READINESS,
              },
            },
          ],
          controller.signal
        );
        for await (const record of readChannelSubscriptionRecords<
          {
            pendingCount: number;
            bridgeSessionId: string;
            attachmentGeneration: string;
          },
          Record<string, unknown>
        >(response)) {
          if (activeBridge?.generation !== generation) break;
          if (record.kind === "subscribed") {
            if (acknowledged) throw new Error("Linked bridge sent more than one ACK");
            if (
              record.result.bridgeSessionId !== bridgeSessionId ||
              !record.result.attachmentGeneration
            ) {
              throw new Error("Linked bridge ACK has a stale or incomplete attachment identity");
            }
            acknowledged = true;
            if (activeBridge?.generation === generation) {
              activeBridge.attachmentGeneration = record.result.attachmentGeneration;
            }
            resolveAck(record.result);
            continue;
          }
          if (!acknowledged) throw new Error("Linked bridge delivered data before its ACK");
          await deliverBridgePayload(record.payload, {
            channelId: config.channelId,
            bridgeSessionId,
            attachmentGeneration:
              activeBridge?.generation === generation
                ? (activeBridge.attachmentGeneration ?? "")
                : "",
            batcher,
            mcp,
            callVessel: (method, args) => vessel.call(method, args),
          });
        }
        if (!acknowledged) throw new Error("Linked bridge closed before its ACK");
        if (!controller.signal.aborted && activeBridge?.generation === generation) {
          throw new Error("Linked bridge closed unexpectedly");
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!acknowledged) rejectAck(failure);
        throw failure;
      }
    })();
    terminal.catch((error) => {
      if (!controller.signal.aborted && !shuttingDown && activeBridge?.generation === generation) {
        log(`bridge response ended: ${error instanceof Error ? error.message : error}`);
        void shutdown(1);
      }
    });
    activeBridge = { generation, attachmentGeneration: null, controller, terminal };
    const result = await ack;
    log(`attached (${result.pendingCount} pending event(s) will replay)`);
  };

  const queueBridgeOpen = (): Promise<void> => {
    const refresh = bridgeRefresh.then(() => openBridge());
    bridgeRefresh = refresh.catch(() => {});
    return refresh;
  };

  // ── Shutdown ──────────────────────────────────────────────────────────────
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
  // Claude Code exiting closes our stdin — the canonical MCP shutdown signal.
  process.stdin.once("end", () => void shutdown(0));
  process.stdin.once("close", () => void shutdown(0));

  const initialized = await Promise.race([
    mcp.whenInitialized().then(
      () => true,
      () => false
    ),
    done.then(() => false),
  ]);
  if (!initialized) return await done;
  log(
    "MCP initialized; Claude channel registration remains unconfirmed because the protocol has no registration acknowledgement"
  );
  await queueBridgeOpen();
  stopRecovery = await client.onRecovery(() => {
    log("transport recovered; replacing bridge response");
    return queueBridgeOpen();
  });

  return await done;
}
