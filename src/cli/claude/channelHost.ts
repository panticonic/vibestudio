/**
 * `vibestudio claude channel-host` — the bridge Claude Code spawns as its
 * channel MCP server (plan §7). One process, four relays:
 *
 *   1. stdio MCP toward Claude Code (channel events in, say/complete out),
 *   2. vessel attachment over WS RPC toward the workspace,
 *   3. permission relay (Claude Code permission_request ⇄ workspace approval),
 *   4. hook ingestion (unix socket ← `vibestudio claude emit`).
 *
 * Only the controlled `vibestudio claude` launcher may start this bridge. That
 * launcher places Claude behind the OS read-only projection boundary before
 * supplying the profile env. Unmanaged/plugin adoption is intentionally absent:
 * the bridge cannot retrofit filesystem containment around an already-running
 * process.
 */

import * as path from "node:path";
import { readChannelSubscriptionRecords } from "@vibestudio/service-schemas/channel";
import { loadCliCredentials, type CliStoredPairing } from "../credentialStore.js";
import { RpcClient, type RawTokenCredential } from "../rpcClient.js";
import { AuthError, CliError } from "../output.js";
import { normalizeServerBaseUrl } from "../serverUrl.js";
import {
  McpStdioServer,
  toolText,
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
  /** Current HTTP base or selected WebRTC route the RpcClient dials. */
  serverUrl: string;
  /** Present when an agent token rides the paired device's WebRTC route. */
  workspacePairing?: CliStoredPairing;
  agentToken: string;
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

/** One canonical bridge credential: agent auth plus transport reach. */
export function bridgeRpcCredential(config: BridgeConfig): RawTokenCredential {
  return {
    url: config.serverUrl,
    token: config.agentToken,
    ...(config.workspacePairing ? { workspacePairing: config.workspacePairing } : {}),
  };
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

/** Validate a canonical launch-profile server base URL. */
export function normalizeServerUrl(raw: string): string {
  return normalizeServerBaseUrl(raw);
}

export interface BridgeEnvironment {
  /** Test seam for resolving a paired WebRTC launch route. */
  loadCredentials?: typeof loadCliCredentials;
}

/**
 * Resolve a complete controlled-launch profile. There is no fallback path: an
 * already-running Claude process cannot be made read-only by this child MCP
 * server, so accepting one would reopen an unprovenanced native-write path.
 */
export async function resolveBridgeConfig(
  env: NodeJS.ProcessEnv,
  environment: BridgeEnvironment = {}
): Promise<BridgeConfig> {
  const token = env["VIBESTUDIO_AGENT_TOKEN"];
  if (token) {
    const serverUrl = env["VIBESTUDIO_SERVER_URL"];
    const entityId = env["VIBESTUDIO_ENTITY_ID"];
    const contextId = env["VIBESTUDIO_CONTEXT_ID"];
    const channelId = env["VIBESTUDIO_CHANNEL_ID"];
    const vesselRef = env["VIBESTUDIO_VESSEL_REF"];
    const profile = env["VIBESTUDIO_LAUNCH_PROFILE"];
    if (!serverUrl || !entityId || !contextId || !channelId || !vesselRef || !profile) {
      throw new CliError(
        "incomplete launch profile env: VIBESTUDIO_AGENT_TOKEN is set but " +
          "SERVER_URL/ENTITY_ID/CONTEXT_ID/CHANNEL_ID/VESSEL_REF/LAUNCH_PROFILE are not all present"
      );
    }
    const subagent = subagentFromEnv(env);
    const reach = launchReach(serverUrl, environment.loadCredentials ?? loadCliCredentials);
    return {
      mode: "launched",
      ...reach,
      agentToken: token,
      entityId,
      contextId,
      channelId,
      vesselRef,
      hookSocketPaths: [path.join(profile, "hook.sock")],
      ...(subagent ? { subagent } : {}),
    };
  }
  throw new CliError(
    "unmanaged linked-Claude adoption is unsupported: launch with `vibestudio claude` so the managed context is OS-read-only"
  );
}

function launchReach(
  serverUrl: string,
  load: typeof loadCliCredentials
): Pick<BridgeConfig, "serverUrl" | "workspacePairing"> {
  if (new URL(serverUrl).protocol !== "webrtc:") {
    return { serverUrl: normalizeServerUrl(serverUrl) };
  }
  const creds = load();
  if (!creds || creds.url !== serverUrl) {
    throw new AuthError(
      "launch profile selects a WebRTC route that does not match the paired CLI credential"
    );
  }
  return { serverUrl: creds.url, workspacePairing: creds.workspacePairing };
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
>   \`inspect_subagent\`, \`integrate_subagent\`, \`suspend_turn\`, \`ask_user\`, panel
>   \`handle.*\`) are NOT your tools. Your MCP tools are \`say\` and \`complete\`;
>   the \`vibestudio\` CLI is available for read-only \`fs\`/\`vcs\` orientation and
>   channel/panel diagnostics. Managed mutations and eval require an in-process
>   invocation edge that linked sessions do not have, so the server refuses them.
>   You cannot spawn subagents — \`say\` a delegation or implementation request to
>   the workspace agent in your conversation instead.
> - TypeScript snippets that import \`@workspace/*\` or call runtime bindings are
>   examples for in-process agents, not commands this linked session can execute.
> - Panel automation examples (\`handle.cdp.screenshot()\` etc.) map to
>   the linked session's read-only \`vibestudio panel screenshot/console\`
>   diagnostics. Mutation examples require an in-process agent.
> - Approval prompts skills mention resolve as workspace approval cards for
>   the user (or fail closed); do not expect an interactive prompt locally.
> - Files a skill references beside its SKILL.md (RECIPES.md, references/…)
>   live in the workspace tree next to it — the skill's repo path is in this
>   resource's description. Read them with \`vibestudio fs read <repoPath>/<file>\`.

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
    "The `vibestudio` CLI in this session is pre-scoped to this context " +
      `(context ${config.contextId}, channel ${config.channelId}): use \`vibestudio fs\` reads and ` +
      "`vibestudio vcs status/compare/history/blame` to inspect semantic state, and " +
      "`vibestudio channel send/history/tail` for conversations. This linked process has no " +
      "in-process tool-invocation edge, so managed fs/vcs mutations and `vibestudio eval` " +
      "fail closed. Native Edit/Write/Bash changes to projected repository bytes are not " +
      "semantic work and will be discarded by projection; do not use them. Ask the workspace " +
      "agent with `say` when implementation is required. The `vibestudio-agent` skill in this " +
      "MCP server's resources documents the exact boundary.",
    "",
    "The read-only context projection materializes repos on demand, so a fresh checkout can look almost " +
      "empty to local `ls`/glob. Discover the tree with `vibestudio fs ls /` (server-side, " +
      "authoritative) before concluding files are missing; `vibestudio fs` reads " +
      "materialize the repos they touch onto disk for your local tools.",
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
      "This session is headless: do NOT end your final reply without calling `complete` — " +
        "exiting without it leaves the run dangling and the parent never settles."
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

export async function runChannelHostLoop(
  config: BridgeConfig,
  deps: ChannelHostDeps = {}
): Promise<number> {
  const log = deps.log ?? ((message: string) => console.error(`[channel-host] ${message}`));
  const client = deps.makeClient
    ? deps.makeClient(config)
    : new RpcClient(bridgeRpcCredential(config));

  const vessel = {
    call: <T>(method: string, args: unknown[] = []): Promise<T> =>
      client.callTargetPush<T>(config.vesselRef, method, args),
    stream: (method: string, args: unknown[], signal: AbortSignal): Promise<Response> =>
      client.stream(config.vesselRef, method, args, { signal }),
  };

  const sessionId = `bridge:${process.pid}:${Date.now().toString(36)}`;
  let hookSeq = 0;
  const turns = new TurnTracker();
  const pendingToolIds = new Map<string, string>();
  let shuttingDown = false;

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
            idempotencyKey: `mcp:${sessionId}:${requestId}`,
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
    onPermissionRequest: (params) => {
      void vessel
        .call("requestPermission", [
          {
            requestId: params.request_id,
            toolName: params.tool_name,
            description: params.description,
            inputPreview: params.input_preview,
          },
        ])
        .catch((err) => {
          // Relay unavailable → fail closed immediately so the session isn't stuck.
          log(`permission relay failed (denying): ${err instanceof Error ? err.message : err}`);
          mcp.notifyPermission(params.request_id, "deny");
        });
    },
  });
  mcp.start();

  const handleBridgePayload = (payload: unknown): void => {
    const event = (payload ?? {}) as Record<string, unknown>;
    switch (event["kind"]) {
      case "message":
      case "prompt": {
        const seq = Number(event["seq"]);
        const content = typeof event["content"] === "string" ? event["content"] : "";
        const meta = (event["meta"] ?? {}) as Record<string, unknown>;
        mcp.notifyChannel(content, { ...meta, kind: event["kind"] });
        // Ack AFTER the notification is on stdout: ack = handed to Claude Code
        // (queued); turn.closed is the processed marker (plan §7.5).
        if (Number.isFinite(seq)) {
          void vessel.call("ackDelivery", [{ seq }]).catch((err) => {
            log(`ack ${seq} failed: ${err instanceof Error ? err.message : err}`);
          });
        }
        return;
      }
      case "permission": {
        const requestId = typeof event["requestId"] === "string" ? event["requestId"] : "";
        const behavior = event["behavior"] === "allow" ? "allow" : "deny";
        if (requestId) mcp.notifyPermission(requestId, behavior);
        return;
      }
      case "interrupt":
        // No MCP interrupt primitive exists; surface it as a channel event so
        // the model sees the request at the next turn boundary.
        mcp.notifyChannel("[interrupt requested from the workspace]", {
          channel_id: config.channelId,
          kind: "interrupt",
        });
        return;
      default:
        return;
    }
  };

  // ── Response-owned bridge lifetime ────────────────────────────────────────
  let hookServer: ReturnType<typeof startHookSocketServer> | null = null;

  const ensureHookServer = (): void => {
    if (hookServer) return;
    hookServer = startHookSocketServer(
      config.hookSocketPaths,
      (line: EmittedHookLine) => {
        const mapped = mapHookEvent(line, turns, pendingToolIds);
        if (!mapped) return;
        const seq = ++hookSeq;
        void vessel.call("ingestHookEvent", [{ sessionId, seq, event: mapped }]).catch((err) => {
          log(`hook ${mapped.hook} ingest failed: ${err instanceof Error ? err.message : err}`);
        });
      },
      log
    );
    log(`listening for hooks on ${hookServer.paths.join(", ") || "(no sockets bound)"}`);
  };

  interface ActiveBridge {
    generation: number;
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
    const bridge = activeBridge;
    activeBridge = null;
    bridge?.controller.abort();
    await bridge?.terminal.catch(() => {});
    await hookServer?.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    resolveDone(code);
  };

  const openBridge = async (): Promise<void> => {
    const previous = activeBridge;
    const generation = ++bridgeGeneration;
    previous?.controller.abort();
    await previous?.terminal.catch(() => {});
    if (shuttingDown) return;

    const controller = new AbortController();
    let resolveAck!: (result: { pendingCount: number }) => void;
    let rejectAck!: (error: Error) => void;
    let acknowledged = false;
    const ack = new Promise<{ pendingCount: number }>((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    const terminal = (async () => {
      try {
        const response = await vessel.stream(
          "openBridge",
          [
            {
              sessionInfo: {
                bridge: sessionId,
                mode: config.mode,
                pid: process.pid,
                agentKind: "claude-code",
                permissionCapability: "claude-code.tool",
              },
            },
          ],
          controller.signal
        );
        for await (const record of readChannelSubscriptionRecords<
          { pendingCount: number },
          Record<string, unknown>
        >(response)) {
          if (activeBridge?.generation !== generation) break;
          if (record.kind === "subscribed") {
            if (acknowledged) throw new Error("Linked bridge sent more than one ACK");
            acknowledged = true;
            resolveAck(record.result);
            continue;
          }
          if (!acknowledged) throw new Error("Linked bridge delivered data before its ACK");
          handleBridgePayload(record.payload);
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
    activeBridge = { generation, controller, terminal };
    const result = await ack;
    log(`attached (${result.pendingCount} pending event(s) will replay)`);
    ensureHookServer();
  };

  const queueBridgeOpen = (): Promise<void> => {
    const refresh = bridgeRefresh.then(() => openBridge());
    bridgeRefresh = refresh.catch(() => {});
    return refresh;
  };

  // ── Hook socket ───────────────────────────────────────────────────────────
  // Bound lazily only after the bridge ACK proves the response resource exists.

  // ── Shutdown ──────────────────────────────────────────────────────────────
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
  // Claude Code exiting closes our stdin — the canonical MCP shutdown signal.
  process.stdin.once("end", () => void shutdown(0));
  process.stdin.once("close", () => void shutdown(0));

  await queueBridgeOpen();
  stopRecovery = await client.onRecovery(() => {
    log("transport recovered; replacing bridge response");
    return queueBridgeOpen();
  });

  return await done;
}
