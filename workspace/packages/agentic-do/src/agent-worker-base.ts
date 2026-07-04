/**
 * AgentWorkerBase — workspace-default channel agent DO base.
 *
 * The reusable event-sourced vessel lives in `AgentVesselBase`; this subclass
 * binds the workspace defaults (model, credential presets) and the standard
 * agent method roster.
 */

import { createRpcFs, type DurableObjectContext } from "@workspace/runtime/worker";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createProvenanceTool,
  createWriteTool,
  createCommitTool,
  createRecordClaimTool,
  createRelateClaimsTool,
  createReviseClaimTool,
  createRetractClaimTool,
  createSuspendTurnTool,
  createEvalTool,
  createDocsSearchTool,
  createDocsOpenTool,
  createWebTools,
  createToolVcs,
  loadVibez1Resources,
} from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import type {
  ParticipantDescriptor,
  KnowledgeToolDeps,
  RecordClaimResult,
} from "@workspace/harness";
import type { AgentTurnContextPolicy, ThinkingLevel } from "@workspace/agent-loop";
import { ids } from "@workspace/agent-loop";
import { createVcsUserlandClient, type RpcCallerLike } from "@vibez1/shared/userlandServiceRpc";
import type {
  VcsProvenanceForFileResult,
  VcsProvenanceForSessionResult,
} from "@vibez1/shared/serviceSchemas/vcs";
import { AgentVesselBase, type AgentPromptResources, type ApprovalLevel } from "./agent-vessel.js";
import { AgentHeartbeatLoop, type AgentHeartbeatLoopDeps } from "./agent-heartbeat-loop.js";
import {
  DEFAULT_APPROVAL_LEVEL,
  DEFAULT_MODEL,
  DEFAULT_RESPOND_POLICY,
  DEFAULT_THINKING_LEVEL,
  OPENAI_CODEX_ACCOUNT_CLAIM,
  PROVIDER_CREDENTIAL_SETUPS,
} from "./agent-config.js";
import type { RespondPolicy } from "@workspace/agent-loop";

type StandardAgentMethodName =
  | "pause"
  | "resume"
  | "scheduleResumeAtReset"
  | "credentialConnected"
  | "connectModelCredential"
  | "setModel"
  | "setThinkingLevel"
  | "setApprovalLevel"
  | "setRespondPolicy"
  | "setModelStreamIdleTimeoutMs"
  | "refreshPromptArtifacts"
  | "getAgentSettings"
  | "getDebugState"
  | "inspectMethodSuspensions";

type StandardAgentMethodOptions = {
  include?: readonly StandardAgentMethodName[];
  exclude?: readonly StandardAgentMethodName[];
};

const PROMPT_RESOURCE_CACHE_TTL_MS = 5_000;
const DEFAULT_WORKSPACE_AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS = 90_000;

export abstract class AgentWorkerBase extends AgentVesselBase {
  private promptResourceCache: { value: AgentPromptResources; expiresAt: number } | null = null;
  private promptResourceLoad: Promise<AgentPromptResources> | null = null;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected override getDefaultModel(): string {
    return DEFAULT_MODEL;
  }

  protected override getDefaultThinkingLevel(): ThinkingLevel {
    return DEFAULT_THINKING_LEVEL as ThinkingLevel;
  }

  protected override getDefaultApprovalLevel(): ApprovalLevel {
    return DEFAULT_APPROVAL_LEVEL as ApprovalLevel;
  }

  protected override getDefaultRespondPolicy(): RespondPolicy {
    return DEFAULT_RESPOND_POLICY as RespondPolicy;
  }

  protected override getDefaultModelStreamIdleTimeoutMs(): number | null {
    return DEFAULT_WORKSPACE_AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS;
  }

  protected override getModelCredentialSetupProps(
    providerId: string
  ): Record<string, unknown> | null {
    return (
      (PROVIDER_CREDENTIAL_SETUPS as Record<string, Record<string, unknown>>)[providerId] ?? null
    );
  }

  protected override async loadPromptResources(_channelId: string): Promise<AgentPromptResources> {
    const now = Date.now();
    if (this.promptResourceCache && this.promptResourceCache.expiresAt > now) {
      return this.promptResourceCache.value;
    }
    if (this.promptResourceLoad) return this.promptResourceLoad;

    const load = loadVibez1Resources({ rpc: this.rpc })
      .then(
        (resources): AgentPromptResources => ({
          workspacePrompt: resources.systemPrompt,
          skillIndex: resources.skillIndex,
        })
      )
      .then((value) => {
        this.promptResourceCache = {
          value,
          expiresAt: Date.now() + PROMPT_RESOURCE_CACHE_TTL_MS,
        };
        return value;
      })
      .finally(() => {
        if (this.promptResourceLoad === load) this.promptResourceLoad = null;
      });
    this.promptResourceLoad = load;
    return load;
  }

  protected override invalidatePromptResources(_channelId?: string): void {
    this.promptResourceCache = null;
    this.promptResourceLoad = null;
  }

  protected createHeartbeatLoop(options: {
    namespace: string;
    defaultPromptText?: string;
    evaluate: AgentHeartbeatLoopDeps["evaluate"];
    channelId: () => string | null;
    registry?: {
      participantHandle?: () => string | null;
      enabled?: boolean;
    };
  }): AgentHeartbeatLoop {
    const sourceId = `heartbeat:${options.namespace.replace(/[^a-zA-Z0-9_]/gu, "_")}`;
    const loop = new AgentHeartbeatLoop({
      sql: this.sql,
      namespace: options.namespace,
      defaultPromptText: options.defaultPromptText,
      evaluate: options.evaluate,
      scheduleWakeAt: (id, timeMs) => this.scheduleAgentAlarm(id, timeMs),
      clearWake: (id) => this.clearAgentAlarm(id),
      isTurnInFlight: () => {
        const channelId = options.channelId();
        return channelId ? this.driver.hasOpenTurn(channelId) : false;
      },
      enqueueTurn: async (turn) => {
        const channelId = options.channelId();
        if (!channelId) throw new Error(`heartbeat ${options.namespace} has no bound channel`);
        const content =
          turn.kind === "prompt"
            ? turn.promptText
            : (options.defaultPromptText ?? "Continue this heartbeat turn.");
        const contextPolicy = await this.resolveHeartbeatContextPolicy(turn.decision.contextPolicy);
        await this.submitAgentInitiatedTurn(
          channelId,
          { content },
          {
            mode: "sequential",
            steeringId: `${sourceId}:${turn.trigger.kind}:${Date.now()}`,
            origin: "heartbeat",
            delivery: turn.decision.delivery ?? "none",
            ...(turn.decision.ackToken ? { ackToken: turn.decision.ackToken } : {}),
            ...(turn.decision.silentOk !== undefined ? { silentOk: turn.decision.silentOk } : {}),
            ...(turn.decision.maxModelCalls !== undefined
              ? { loopConfigPatch: { maxModelCallsPerTurn: turn.decision.maxModelCalls } }
              : { loopConfigPatch: { maxModelCallsPerTurn: 1 } }),
            contextPolicy,
          }
        );
        if (options.registry?.enabled !== false) {
          await this.registerGenericHeartbeat(options.namespace, channelId, loop, options);
        }
      },
    });
    this.registerAgentAlarmSource({
      id: sourceId,
      nextWakeAt: () => loop.nextWakeAt(),
      fire: async (now) => {
        await loop.onAlarm(now);
        const channelId = options.channelId();
        if (channelId && options.registry?.enabled !== false) {
          await this.registerGenericHeartbeat(options.namespace, channelId, loop, options);
        }
      },
    });
    return loop;
  }

  private async registerGenericHeartbeat(
    namespace: string,
    channelId: string,
    loop: AgentHeartbeatLoop,
    options?: {
      registry?: {
        participantHandle?: () => string | null;
      };
    }
  ): Promise<void> {
    const state = loop.getState();
    const ref = this.identity.ref;
    await this.rpc
      .call("main", "workspace-state.heartbeatRegister", [
        {
          name: `${namespace}-${channelId}`,
          source: ref.source,
          className: ref.className,
          objectKey: ref.objectKey,
          channelId,
          participantHandle: options?.registry?.participantHandle?.() ?? null,
          kind: "code-owned",
          status: state.status,
          nextRunAt: state.nextRunAt,
          lastWakeAt: state.lastWakeAt || null,
          lastActionSummary: state.lastActionSummary || null,
          lastError: state.lastError || null,
          specHash: state.specHash || null,
          updatedAt: Date.now(),
        },
      ])
      .catch((err) => {
        console.warn("[AgentWorkerBase] heartbeat registry update failed:", err);
      });
  }

  private async resolveHeartbeatContextPolicy(
    decisionPolicy?: AgentTurnContextPolicy
  ): Promise<AgentTurnContextPolicy> {
    const contextPolicy: AgentTurnContextPolicy = {
      mode: "heartbeat",
      includeWorkspacePrompt: false,
      includeSkillIndex: false,
      tokenBudget: 12_000,
      ...decisionPolicy,
    };
    if (contextPolicy.promptFile) {
      try {
        const fs = createRpcFs(this.rpc as never);
        const path = contextPolicy.promptFile.startsWith("/")
          ? contextPolicy.promptFile
          : `/${contextPolicy.promptFile}`;
        const raw = await fs.readFile(path, "utf8");
        contextPolicy.promptFileContent = typeof raw === "string" ? raw : raw.toString("utf8");
      } catch (err) {
        console.warn(
          "[AgentWorkerBase] failed to read heartbeat promptFile:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    return contextPolicy;
  }

  /** The six workerd-clean file tools over the agent's context folder
   *  (fs RPC scopes paths to the caller's context). Without them, agents
   *  whose prompts say `read("skills/...")` can only flail. */
  protected override getLoopTools(channelId: string): AgentTool[] {
    const fs = createRpcFs(this.rpc as never);
    const cwd = "/";
    // Reads come from the materialized working tree (fs RPC, scoped to the
    // caller's context); writes go through GAD's edit-first commit so the head
    // is authoritative and disk is its projection.
    // Push is userland-dispatched (P3): route it to the gad-store DO via the
    // `vcs` manifest service on `this.rpc`, with THIS agent's context head as
    // the source (the same head its edit/commit land on).
    const userlandRpc = this.rpc as unknown as RpcCallerLike;
    const vcs = createToolVcs(
      <T>(method: string, methodArgs: unknown[]) => this.rpc.call<T>("main", method, methodArgs),
      {
        rpc: userlandRpc,
        // Lazy: the channel subscription is only guaranteed at push time.
        sourceHead: () => `ctx:${this.subscriptions.getContextId(channelId)}`,
      }
    );
    // §6/§7 provenance: the read attachment + the drill-down `provenance` tool
    // reach the gad-store DO's provenanceFor* @rpc surface via the same userland
    // `vcs` manifest service the history reads / push use. Session identity is
    // THIS agent's trajectory branch (logId === head for the loop), distinct
    // from the vcs `head` (ctx:<contextId>) where files live.
    const provClient = createVcsUserlandClient(userlandRpc);
    const sessionLogId = ids.logIdForChannel(channelId);
    // Lazy + throw-safe: getContextId throws until the channel is subscribed;
    // an empty head makes the provenance call skip (best-effort, never fatal).
    const headFor = () => {
      try {
        return `ctx:${this.subscriptions.getContextId(channelId)}`;
      } catch {
        return "";
      }
    };
    const provenanceForFile = (input: {
      repoPath: string;
      path: string;
      head: string;
      tier: "none" | "moderate" | "deep";
      sessionLogId: string;
      sessionHead: string;
      invocationId?: string | null;
      recallKeywords?: string[] | null;
      after?: string | null;
      skipSuppression?: boolean | null;
    }) => provClient.call<VcsProvenanceForFileResult>("provenanceForFile", input);
    const provenanceForClaim = (input: {
      claimId: string;
      sessionLogId: string;
      sessionHead: string;
      invocationId?: string | null;
      after?: string | null;
    }) => provClient.call<VcsProvenanceForFileResult>("provenanceForClaim", input);
    const provenanceForSession = (input: {
      sessionLogId: string;
      sessionHead: string;
      after?: string | null;
    }) => provClient.call<VcsProvenanceForSessionResult>("provenanceForSession", input);
    // §8 knowledge capture: the commit tool's `claims:` + the standalone
    // record/relate/revise/retract tools write to the gad-store DO's knowledge
    // @rpc surface on THIS agent's own trajectory (logId === head for the loop),
    // reached via the SAME userland manifest service the provenance reads use
    // (both `gad` and `vcs` resolve to the one DO; dispatch is by method name,
    // gated by the 'do' caller kind in the knowledge* @rpc allowlist). Claim
    // content NEVER travels through vcsService (strict §8 layering).
    const knowledge: KnowledgeToolDeps = {
      recordClaim: (input) => provClient.call<RecordClaimResult>("knowledgeRecordClaim", input),
      relateClaims: (input) =>
        provClient.call<{ ledgerEntryId: string; related: number }>("knowledgeRelateClaims", input),
      reviseClaim: (input) =>
        provClient.call<{ claimId: string; ledgerEntryId: string }>("knowledgeReviseClaim", input),
      retractClaim: (input) =>
        provClient.call<{ claimId: string; ledgerEntryId: string }>("knowledgeRetractClaim", input),
      logId: sessionLogId,
      head: sessionLogId,
    };
    const base = [
      createReadTool(cwd, fs, {
        provenance: {
          provenanceForFile,
          head: headFor,
          sessionLogId,
          sessionHead: sessionLogId,
        },
      }),
      createProvenanceTool(cwd, {
        provenanceForFile,
        provenanceForClaim,
        provenanceForSession,
        head: headFor,
        sessionLogId,
        sessionHead: sessionLogId,
      }),
      createLsTool(cwd, fs),
      createGrepTool(cwd, fs),
      createFindTool(cwd, fs),
      createEditTool(cwd, vcs),
      createWriteTool(cwd, vcs),
      createCommitTool(vcs, knowledge),
      createRecordClaimTool(knowledge),
      createRelateClaimsTool(knowledge),
      createReviseClaimTool(knowledge),
      createRetractClaimTool(knowledge),
      createEvalTool(
        <T>(method: string, methodArgs: unknown[]) => this.rpc.call<T>("main", method, methodArgs),
        // Scope the agent's EvalDO per channel (matches the old per-(channel,panel) scope),
        // so one multi-channel agent doesn't share REPL scope/db across unrelated chats.
        { subKey: channelId }
      ),
      // Capability discovery: search/open the caller-aware catalog (services
      // and runtime APIs) with typed schemas + access rules.
      createDocsSearchTool(<T>(method: string, methodArgs: unknown[]) =>
        this.rpc.call<T>("main", method, methodArgs)
      ),
      createDocsOpenTool(<T>(method: string, methodArgs: unknown[]) =>
        this.rpc.call<T>("main", method, methodArgs)
      ),
      createSuspendTurnTool(),
      this.createAskUserTool(),
      ...createWebTools({
        rpc: {
          call: (target, method, args) => this.rpc.call(target, method, args),
        },
        hasCredentialForOrigin: async (origin) => {
          try {
            const credential = await this.rpc.call<unknown>(
              "main",
              "credentials.resolveCredential",
              [{ url: origin }]
            );
            return credential != null;
          } catch {
            return false;
          }
        },
      }),
    ] as unknown as AgentTool[];
    // The generalized `say` tool (carries saliency:"say"; the config-level
    // publishPolicy governs whether model narration also publishes) + the
    // subagent supervision surface. The child-side `complete` tool is added
    // ONLY when this agent is itself a subagent.
    return [...base, this.createSayTool(channelId), ...this.createSubagentTools()];
  }

  /** The generalized `say` tool: an explicit, deliberate channel utterance
   *  (saliency:"say"). Its messageId is derived from the tool-call id, so a
   *  redriven invocation re-sends the SAME message (dedup), never a duplicate. */
  private createSayTool(channelId: string): AgentTool<never> {
    return {
      name: "say",
      label: "say",
      description:
        "Send a concise, deliberate message to the channel. This is the explicit way to surface text to participants (e.g. when the agent publishes only on demand).",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Message text to send to the channel." },
          replyTo: { type: "string", description: "Optional message id this is replying to." },
          mentions: {
            type: "array",
            items: { type: "string" },
            description: "Optional participant IDs to mention.",
          },
        },
        required: ["content"],
      } as never,
      execute: async (toolCallId, params) => {
        const input = params as { content?: unknown; replyTo?: unknown; mentions?: unknown };
        if (typeof input.content !== "string" || input.content.trim().length === 0) {
          throw new Error("say requires non-empty content");
        }
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) throw new Error("agent is not subscribed to the channel");
        const descriptor = this.getEffectiveParticipantInfo(
          channelId,
          this.subscriptions.getConfig(channelId)
        );
        const messageId = `say:${toolCallId}`;
        await this.createChannelClient(channelId).send(participantId, messageId, input.content, {
          saliency: "say",
          senderMetadata: {
            ...descriptor.metadata,
            name: descriptor.name,
            type: descriptor.type,
            handle: descriptor.handle,
          },
          replyTo: typeof input.replyTo === "string" ? input.replyTo : undefined,
          mentions: Array.isArray(input.mentions)
            ? input.mentions.filter((mention): mention is string => typeof mention === "string")
            : undefined,
        });
        return {
          content: [{ type: "text", text: `sent message ${messageId}` }],
          details: { messageId },
        };
      },
    };
  }

  /** The subagent tool surface: parent-side supervision (spawn/send/inspect/
   *  merge/pick/read/close) plus the child-side `complete` terminal trigger
   *  (advertised only to subagents). The vessel implements the spawn mechanics
   *  in the local-tool executor (it never reaches the `execute` below — see
   *  AgentVesselBase.runDeferredSpawn). */
  private createSubagentTools(): AgentTool[] {
    const tools: AgentTool[] = [
      {
        name: "spawn_subagent",
        label: "spawn_subagent",
        description:
          "Delegate separable work to a child agent in its own task channel and child context. Returns immediately with a runId while the child continues in the background. Use for independent investigation, parallel work, or isolated edits; do small linear work yourself. mode:'fresh' seeds a child from `task`; mode:'fork' starts the child from your current trajectory and can save substantial tokens because the context window cache is shared. Track the returned runId, keep doing useful foreground work, steer with send_to_subagent only when you have new instructions, inspect files with inspect_subagent, then merge/pick/close. Progress is pushed; do not poll read_subagent. If nothing foreground remains, call suspend_turn({ reason:'waiting_for_background' }). The child finishes only by calling complete.",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["fresh", "fork"],
              description:
                "'fresh' = new agent seeded via the task; 'fork' = branch from your trajectory, useful when the child needs your current context and can benefit from the shared context window cache.",
            },
            task: {
              type: "string",
              description:
                "Self-contained task/instructions. Include goal, relevant files/docs/skills, constraints, expected output, progress expectations, done criteria, and what to do if blocked. Required for 'fresh'.",
            },
            source: {
              type: "string",
              description: "Optional agent source repo path (defaults to your own).",
            },
            config: {
              type: "object",
              description: "Optional child agent config (model/handle/etc.).",
            },
            label: { type: "string", description: "Optional short label for the run." },
          },
          required: ["mode"],
        } as never,
        execute: async () => {
          throw new Error("spawn_subagent is handled by the local-tool executor");
        },
      } as AgentTool,
      {
        name: "send_to_subagent",
        label: "send_to_subagent",
        description:
          "Post steering or new information into a running subagent's task channel. Use this to correct course or add context, not to poll for progress.",
        parameters: {
          type: "object",
          properties: {
            runId: { type: "string", description: "The subagent run id." },
            message: { type: "string", description: "Message to send to the subagent." },
          },
          required: ["runId", "message"],
        } as never,
        execute: async (toolCallId, params) => {
          const p = params as { runId?: unknown; message?: unknown };
          return this.sendToSubagent(toolCallId, String(p.runId ?? ""), String(p.message ?? ""));
        },
      } as AgentTool,
      {
        name: "inspect_subagent",
        label: "inspect_subagent",
        description:
          "Inspect a subagent's child-context workspace state via VCS. Use this for what the child changed: query 'status', 'diff', 'log', or a file path. Use read_subagent instead for what the child said.",
        parameters: {
          type: "object",
          properties: {
            runId: { type: "string", description: "The subagent run id." },
            query: {
              type: "string",
              description: "'status' | 'diff' | 'log' | a file path (default 'status').",
            },
          },
          required: ["runId"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as { runId?: unknown; query?: unknown };
          return this.inspectSubagent(String(p.runId ?? ""), String(p.query ?? "status"));
        },
      } as AgentTool,
      {
        name: "merge_subagent",
        label: "merge_subagent",
        description:
          "Take EVERYTHING from a subagent by merging its child context into yours. Inspect status/diff first. Merge is commit-gated on both sides; if parent or child is dirty, commit deliberately, then retry. This does not push main.",
        parameters: {
          type: "object",
          properties: { runId: { type: "string", description: "The subagent run id." } },
          required: ["runId"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as { runId?: unknown };
          return this.mergeSubagent(String(p.runId ?? ""));
        },
      } as AgentTool,
      {
        name: "pick_from_subagent",
        label: "pick_from_subagent",
        description:
          "Selectively take commits or paths from a subagent's child context. Inspect status/diff/log first. Path picks land as parent working edits; commit picks follow vcs.pick semantics.",
        parameters: {
          type: "object",
          properties: {
            runId: { type: "string", description: "The subagent run id." },
            picks: {
              type: "array",
              description:
                "Pick specs: {kind:'commit',repoPath,eventId} | {kind:'paths',paths:[…]}.",
              items: { type: "object" },
            },
          },
          required: ["runId", "picks"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as { runId?: unknown; picks?: unknown };
          return this.pickFromSubagent(String(p.runId ?? ""), p.picks);
        },
      } as AgentTool,
      {
        name: "read_subagent",
        label: "read_subagent",
        description:
          "Catch up on what a subagent said on its task channel since a cursor. Returns messages plus nextSeq; pass nextSeq as afterSeq only for deliberate transcript catch-up or debugging. Do not poll this tool waiting for progress; progress is pushed, and suspend_turn({ reason:'waiting_for_background' }) parks the parent when no foreground work remains. Use inspect_subagent instead for child files/status/diff/log.",
        parameters: {
          type: "object",
          properties: {
            runId: { type: "string", description: "The subagent run id." },
            afterSeq: {
              type: "number",
              description: "Return messages after this channel seq (default 0).",
            },
          },
          required: ["runId"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as { runId?: unknown; afterSeq?: unknown };
          return this.readSubagent(
            String(p.runId ?? ""),
            typeof p.afterSeq === "number" ? p.afterSeq : 0
          );
        },
      } as AgentTool,
      {
        name: "close_subagent",
        label: "close_subagent",
        description:
          "Close a subagent run when you are done inspecting it. Cancels it if still open, then tears down its context and its own subagents. Set discard:true when intentionally dropping unmerged work.",
        parameters: {
          type: "object",
          properties: {
            runId: { type: "string", description: "The subagent run id." },
            discard: {
              type: "boolean",
              description: "Discard the child's work (record it as discarded).",
            },
          },
          required: ["runId"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as { runId?: unknown; discard?: unknown };
          return this.closeSubagent(String(p.runId ?? ""), p.discard === true);
        },
      } as AgentTool,
    ];
    if (this.isSubagent()) {
      tools.push({
        name: "complete",
        label: "complete",
        description:
          "Finish this subagent run exactly once and hand your report back to the parent. This is the explicit terminal trigger: ordinary final text, turn closure, and idle are NOT terminal. Use outcome:'failed' when blocked or unable to complete, with a report explaining what was tried and whether partial work exists.",
        parameters: {
          type: "object",
          properties: {
            report: { type: "string", description: "Your final report to the parent." },
            outcome: {
              type: "string",
              enum: ["success", "failed"],
              description: "Run outcome (default 'success').",
            },
          },
          required: ["report"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as { report?: unknown; outcome?: unknown };
          return this.completeAsSubagent(
            String(p.report ?? ""),
            p.outcome === "failed" ? "failed" : "success"
          );
        },
      } as AgentTool);
    }
    return tools;
  }

  private createAskUserTool(): AgentTool {
    return {
      name: "ask_user",
      label: "ask_user",
      description:
        "Ask the user a concise question and wait for their response. Use this only when the answer is needed to continue.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question to show the user." },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional short options; mutually exclusive unless multiSelect is true.",
          },
          allowFreeform: {
            type: "boolean",
            description:
              "Whether the user may type a custom answer. Defaults to true for option prompts; set false to require one of the options.",
          },
          multiSelect: {
            type: "boolean",
            description:
              "Whether multiple options may be selected. When true, the prompt shows checkboxes and an explicit submit button.",
          },
        },
        required: ["question"],
      } as never,
      execute: async () => {
        throw new Error("ask_user requires a channel user participant");
      },
    } as AgentTool;
  }

  protected override getModelCredentialTokenClaims(
    providerId: string,
    credential: import("@workspace/runtime/credentials").StoredCredentialSummary
  ): Record<string, unknown> {
    if (providerId !== "openai-codex") return {};
    const accountId =
      credential.accountIdentity?.providerUserId ?? credential.metadata?.["accountId"];
    return accountId ? { [OPENAI_CODEX_ACCOUNT_CLAIM]: { chatgpt_account_id: accountId } } : {};
  }

  protected getStandardAgentMethods(
    opts?: StandardAgentMethodOptions
  ): NonNullable<ParticipantDescriptor["methods"]> {
    const methods: NonNullable<ParticipantDescriptor["methods"]> = [
      { name: "pause", description: "Pause the current AI turn" },
      { name: "resume", description: "Resume after pause" },
      {
        name: "scheduleResumeAtReset",
        description: "Schedule a paused model turn to resume when its usage limit resets",
      },
      { name: "credentialConnected", description: "Resume after model credential connection" },
      {
        name: "connectModelCredential",
        description: "Connect a model credential for the current provider",
      },
      { name: "setModel", description: "Set the live model in provider:model format" },
      {
        name: "setThinkingLevel",
        description: "Set live effort level: minimal, low, medium, or high",
      },
      {
        name: "setApprovalLevel",
        description: "Set live approval level: 0=manual, 1=auto-safe, 2=full-auto",
      },
      {
        name: "setRespondPolicy",
        description: "Set live chattiness policy and optional participant allow-list",
      },
      {
        name: "setModelStreamIdleTimeoutMs",
        description: "Set model stream idle watchdog milliseconds, or null to disable",
      },
      {
        name: "refreshPromptArtifacts",
        description: "Reload workspace prompt resources and refresh model prompt/tool artifacts",
      },
      {
        name: "getAgentSettings",
        description:
          "Read effective model, effort, approval, chattiness, and stream watchdog settings",
      },
      { name: "getDebugState", description: "Read agent DO persisted and in-memory debug state" },
      {
        name: "inspectMethodSuspensions",
        description: "Inspect the pending effect outbox (dispatch cache over the log)",
      },
    ];
    const include = opts?.include ? new Set<string>(opts.include) : null;
    const exclude = opts?.exclude ? new Set<string>(opts.exclude) : null;
    return methods.filter(
      (method) => (!include || include.has(method.name)) && !exclude?.has(method.name)
    );
  }
}
