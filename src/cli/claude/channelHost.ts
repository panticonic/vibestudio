/**
 * `vibestudio claude channel-host` — the bridge Claude Code spawns as its
 * channel MCP server (plan §7). One process, four relays:
 *
 *   1. stdio MCP toward Claude Code (channel events in, say/complete out),
 *   2. vessel attachment over WS RPC toward the workspace,
 *   3. permission relay (Claude Code permission_request ⇄ workspace approval),
 *   4. hook ingestion (unix socket ← `vibestudio claude emit`).
 *
 * With a launch profile env (VIBESTUDIO_AGENT_TOKEN et al) it attaches
 * directly; with none it ADOPTS (plan §8.3): discovers the context from the
 * cwd marker, calls the configured Claude Code provider's `prepare` under the
 * paired device credential (which gates on a workspace-side first-adoption approval),
 * and proceeds identically. All Claude-side protocol knowledge lives here and
 * nowhere else (plan §11 containment).
 */

import * as path from "node:path";
import { loadCliCredentials } from "../credentialStore.js";
import { RpcClient } from "../rpcClient.js";
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
  agentSocketPath,
  mapHookEvent,
  startHookSocketServer,
  type EmittedHookLine,
} from "./hookSocket.js";
import { findContextMarker } from "./context.js";

export const LINKED_AGENT_EVENT = "linked-agent:event";
const HEARTBEAT_INTERVAL_MS = 30_000;
const REATTACH_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const CLAUDE_CODE_PROVIDER = "claudeCode";

export interface BridgeConfig {
  mode: "launched" | "adopted";
  /** Canonical server base the RpcClient dials. */
  serverUrl: string;
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

export interface AdoptionEnvironment {
  cwd: string;
  channelFlag?: string;
  /** Test seams. */
  loadCredentials?: typeof loadCliCredentials;
  makeClient?: (creds: NonNullable<ReturnType<typeof loadCliCredentials>>) => RpcClient;
  warn?: (message: string) => void;
}

interface PreparedLaunch {
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  contextFolder: string;
  env: Record<string, string>;
  argv: string[];
}

/**
 * Resolve the bridge config. Precedence (plan §8.3 discovery order): the
 * launch-profile env wins; otherwise adopt via marker + device credential.
 */
export async function resolveBridgeConfig(
  env: NodeJS.ProcessEnv,
  adoption: AdoptionEnvironment
): Promise<BridgeConfig> {
  const token = env["VIBESTUDIO_AGENT_TOKEN"];
  if (token) {
    const serverUrl = env["VIBESTUDIO_SERVER_URL"];
    const entityId = env["VIBESTUDIO_ENTITY_ID"];
    const contextId = env["VIBESTUDIO_CONTEXT_ID"];
    const channelId = env["VIBESTUDIO_CHANNEL_ID"];
    const vesselRef = env["VIBESTUDIO_VESSEL_REF"];
    if (!serverUrl || !entityId || !contextId || !channelId || !vesselRef) {
      throw new CliError(
        "incomplete launch profile env: VIBESTUDIO_AGENT_TOKEN is set but " +
          "SERVER_URL/ENTITY_ID/CONTEXT_ID/CHANNEL_ID/VESSEL_REF are not all present"
      );
    }
    const profile = env["VIBESTUDIO_LAUNCH_PROFILE"];
    const subagent = subagentFromEnv(env);
    return {
      mode: "launched",
      serverUrl: normalizeServerUrl(serverUrl),
      agentToken: token,
      entityId,
      contextId,
      channelId,
      vesselRef,
      hookSocketPaths: [
        ...(profile ? [path.join(profile, "hook.sock")] : []),
        agentSocketPath(contextId),
      ],
      ...(subagent ? { subagent } : {}),
    };
  }
  return await adopt(adoption);
}

/** Adoption mode (plan §8.3): marker → prepare under the device credential. */
async function adopt(adoption: AdoptionEnvironment): Promise<BridgeConfig> {
  const warn = adoption.warn ?? ((message: string) => console.error(message));
  const load = adoption.loadCredentials ?? loadCliCredentials;
  const creds = load();
  if (!creds) {
    throw new AuthError(
      'adoption requires a paired device — run `vibestudio remote pair "<pair-link>"` first'
    );
  }
  const client = adoption.makeClient ? adoption.makeClient(creds) : new RpcClient(creds);

  const marker = findContextMarker(adoption.cwd);
  let channelId = adoption.channelFlag;
  if (!channelId) {
    if (!marker) {
      throw new CliError(
        "adoption refused: not inside a context folder (no .vibestudio-context.json found) " +
          "and no --channel given. Local file tools would operate on a different tree than " +
          "the workspace context — pass an explicit --channel <id> to bind anyway."
      );
    }
    const primary = await invokeExtension<{ channelId: string } | null>(
      client,
      "resolvePrimaryChannel",
      [{ contextId: marker.contextId }]
    );
    if (!primary?.channelId) {
      throw new CliError(
        `context ${marker.contextId} has no known conversation channel yet — ` +
          "launch once with an explicit --channel <id> to bind one"
      );
    }
    channelId = primary.channelId;
  }

  const prepared = await invokeExtension<PreparedLaunch>(client, "prepare", [{ channelId }]);

  // cwd/context divergence guard (plan §8.3): never silently bind a session to
  // a tree it isn't looking at.
  const inside = isInside(adoption.cwd, prepared.contextFolder);
  if (!inside) {
    if (!adoption.channelFlag) {
      throw new CliError(
        `adoption refused: cwd ${adoption.cwd} is outside the context folder ` +
          `${prepared.contextFolder} for channel ${channelId}. Claude's local file tools and ` +
          "`vibestudio fs/vcs` would see different bytes. Re-run with an explicit " +
          "--channel <id> to proceed anyway."
      );
    }
    warn(
      `WARNING: cwd ${adoption.cwd} is OUTSIDE the context folder ${prepared.contextFolder}. ` +
        "Local file tools and `vibestudio fs/vcs` are looking at DIFFERENT trees. " +
        "Proceeding because --channel was explicit. Consider `vibestudio context mirror` " +
        "or cd into the context folder."
    );
  }
  await client.close().catch(() => undefined);

  const env = prepared.env;
  const agentToken = env["VIBESTUDIO_AGENT_TOKEN"];
  const serverUrl = env["VIBESTUDIO_SERVER_URL"];
  if (!agentToken || !serverUrl || !prepared.vesselRef) {
    throw new CliError("extension prepare returned incomplete agent connection coordinates");
  }
  const profile = env["VIBESTUDIO_LAUNCH_PROFILE"];
  const subagent = subagentFromEnv(env);
  return {
    mode: "adopted",
    serverUrl: normalizeServerUrl(serverUrl),
    agentToken,
    entityId: prepared.entityId,
    contextId: prepared.contextId,
    channelId: prepared.channelId,
    vesselRef: prepared.vesselRef,
    hookSocketPaths: [
      // Adopted sessions' hooks have no profile env — they fall back to the
      // per-context socket; listen on the profile sock too for good measure.
      ...(profile ? [path.join(profile, "hook.sock")] : []),
      agentSocketPath(prepared.contextId),
    ],
    ...(subagent ? { subagent } : {}),
  };
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function invokeExtension<T>(client: RpcClient, method: string, args: unknown[]): Promise<T> {
  return await client.call<T>("extensions.invokeProvider", [CLAUDE_CODE_PROVIDER, method, args]);
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
>   everything else routes through the \`vibestudio\` CLI (\`fs\`/\`vcs\`/\`eval\`/
>   \`channel\`/\`panel\`). You cannot spawn subagents — \`say\` a delegation
>   request to the workspace agent in your conversation instead.
> - TypeScript snippets that import \`@workspace/*\` or call runtime bindings
>   (\`openPanel\`, \`getPanelHandle\`, \`services.*\`, \`chat\`, …) run INSIDE the
>   workspace via \`vibestudio eval run -e '...'\` — never in your local shell
>   or node.
> - Panel automation examples (\`handle.cdp.screenshot()\` etc.) map to
>   \`vibestudio panel screenshot/console\`, or eval
>   \`(await getPanelHandle(id)).cdp\`. Agents may only automate panels in
>   their own context; open your own preview instance for foreign UI.
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
      `(context ${config.contextId}, channel ${config.channelId}): \`vibestudio fs/vcs\` operate ` +
      "on the context tree, `vibestudio channel send/history/tail` on conversations, and " +
      "`vibestudio eval` executes TS/JS INSIDE the running workspace server (userland, " +
      "context-scoped) — the full-power surface for programmatic workspace access. The " +
      "`vibestudio-agent` skill installed in this project documents all of it (CLI, eval, and " +
      "the edit→commit workflow) — read it before file/VCS work.",
    "",
    "The context folder materializes repos on demand, so a fresh checkout can look almost " +
      "empty to local `ls`/glob. Discover the tree with `vibestudio fs ls /` (server-side, " +
      "authoritative) before concluding files are missing; `vibestudio fs` operations " +
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
    : new RpcClient({ url: config.serverUrl, token: config.agentToken });

  const vessel = {
    call: <T>(method: string, args: unknown[] = []): Promise<T> =>
      client.callTargetPush<T>(config.vesselRef, method, args),
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

  // ── Vessel push events ────────────────────────────────────────────────────
  const unsubscribe = await client.onEvent(LINKED_AGENT_EVENT, (payload) => {
    const event = (payload ?? {}) as Record<string, unknown>;
    const bridge = typeof event["bridge"] === "string" ? event["bridge"] : null;
    if (bridge && bridge !== sessionId) return;
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
      case "detach":
        log(`vessel detached us (${String(event["reason"] ?? "unknown")}); will re-attach`);
        scheduleReattach();
        return;
      default:
        return;
    }
  });

  // ── Attach / heartbeat / reattach ─────────────────────────────────────────
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reattachTimer: NodeJS.Timeout | null = null;
  let hookServer: ReturnType<typeof startHookSocketServer> | null = null;
  let backoffIdx = 0;

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

  const attach = async (): Promise<void> => {
    const result = await vessel.call<{ pendingCount: number }>("attach", [
      {
        sessionInfo: {
          bridge: sessionId,
          mode: config.mode,
          pid: process.pid,
          agentKind: "claude-code",
          permissionCapability: "claude-code.tool",
        },
      },
    ]);
    backoffIdx = 0;
    log(`attached (${result.pendingCount} pending event(s) will replay)`);
    ensureHookServer();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      void vessel.call("heartbeat").catch((err) => {
        log(`heartbeat failed: ${err instanceof Error ? err.message : err}`);
        scheduleReattach();
      });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  };

  const scheduleReattach = (): void => {
    if (shuttingDown || reattachTimer) return;
    const delay =
      REATTACH_BACKOFF_MS[Math.min(backoffIdx, REATTACH_BACKOFF_MS.length - 1)] ?? 30_000;
    backoffIdx += 1;
    reattachTimer = setTimeout(() => {
      reattachTimer = null;
      void attach().catch((err) => {
        log(`re-attach failed: ${err instanceof Error ? err.message : err}`);
        scheduleReattach();
      });
    }, delay);
    reattachTimer.unref?.();
  };

  await client.onRecovery(() => {
    log("transport recovered; re-attaching");
    scheduleReattach();
  });

  // ── Hook socket ───────────────────────────────────────────────────────────
  // Bound lazily after attach; a rejected duplicate bridge must not unlink the
  // active bridge's hook socket.

  // ── Shutdown ──────────────────────────────────────────────────────────────
  let resolveDone: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (reattachTimer) clearTimeout(reattachTimer);
    unsubscribe();
    await vessel.call("detachSelf").catch(() => undefined);
    await hookServer?.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    resolveDone(code);
  };
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
  // Claude Code exiting closes our stdin — the canonical MCP shutdown signal.
  process.stdin.once("end", () => void shutdown(0));
  process.stdin.once("close", () => void shutdown(0));

  try {
    await attach();
  } catch (err) {
    log(`initial attach failed: ${err instanceof Error ? err.message : err}`);
    scheduleReattach();
  }

  return await done;
}
