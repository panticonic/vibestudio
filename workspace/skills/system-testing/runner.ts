import {
  HeadlessSession,
  type HeadlessWithAgentConfig,
  type SessionSnapshot,
} from "@workspace/agentic-session";
import type { ConnectionConfig } from "@workspace/agentic-core";
import { blobstore, gad, rpc, vcs, workers } from "@workspace/runtime";
import {
  SYSTEM_TEST_AGENT_MODEL,
  systemTestModelRoute,
  type SystemTestThinkingLevel,
} from "./config.js";
import { systemTestFailure } from "./structured-error.js";
import {
  WorkspaceRepoFixtureLifecycle,
  type WorkspaceRepoFixtureCleanup,
  type WorkspaceRepoFixtureSpec,
  type WorkspaceRepoFixtureState,
} from "./workspace-repo-fixture.js";
import type { AgentExecutionTestPolicySpec } from "@vibestudio/shared/authority/testPolicy";
import { vcsStateNodeRefSchema, type VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import type { AttachedHostApprovalAuditEvent } from "@vibestudio/service-schemas/attachedHosts";
import type { TestAuthorityPolicy } from "./types.js";
import type { BlobReader } from "@workspace/agentic-protocol";

// This runner is eval'd server-side (in the orchestrating agent's EvalDO), so it
// uses the portable client surface — NOT panel-only `getStateArgs`/`slotId`.
// `rpc.selfId` is the stable runtime id, used as the channel-membership clientId.
const rpcConfig = rpc as unknown as NonNullable<ConnectionConfig["rpc"]>;

export const SYSTEM_TEST_AGENT_PROMPT = `You are running inside an automated Vibestudio system test.

Your job is to exercise the documented path honestly, not to make the test pass by inventing workarounds.

When a task depends on Vibestudio behavior, use the relevant docs or skill files to choose the most straightforward supported approach.

Treat the request like a normal user's request. Route from the Available skills index to the closest user-facing skill before doing a broad source search. Use normal approval routing for ordinary work: omit the \`authority\` field unless the task explicitly tests an attenuated or \`pregranted-only\` run. \`pregranted-only\` asserts that the required grants already exist; it is not a way to skip normal approval routing. Do not inspect \`skills/system-testing\`, its test definitions, validators, marker strings, or captured artifacts to reverse-engineer what the test expects; those are harness implementation, not product documentation.

This session is genuinely headless: there is no initial visible panel ancestor. The panel tree still works. If a task needs an actual child panel and getParent() is null, follow the documented headless tree pattern: create an owned root panel explicitly, create the requested panel with that root's id as parentId, and close the temporary root to clean the subtree.

If that documented approach fails, stop and report what happened. Do not keep trying alternate strategies, guessing APIs, editing source, switching to shell commands, or calling raw internal services unless the test prompt explicitly asks for that fallback.

When reporting a failure, include the docs or skill files you used, the operation you attempted, the exact error or unexpected result, and the mismatch between the docs and reality.

Use file-loaded eval for substantive multi-line or multi-file eval work. Do not create or edit helper files merely to work around a short documented suite-orchestration eval snippet. If an operation fails, report the error you actually observed, verbatim, with the operation that produced it.

Keep evidence bounded. Report summaries, counts, ids, byte lengths, exact error messages, the final agent message, the validation reason, and the relevant tool call statuses/errors. Do not paste large raw payloads, full database rows, full channel envelopes, image data, or secrets.

Every final response should be concise and contain exactly one terminal status declaration at the start of a line:
\`Task completed.\`
\`Task not completed.\`
The summary may continue on that line or the next. Summarize what you verified and mention any problems or retries encountered along the way. For an incomplete task, include the concrete mismatch or error. Never just refer to files or artifacts; describe what the evidence shows.`;

export type { WorkspaceRepoFixtureCleanup, WorkspaceRepoFixtureState };

interface ModelPolicyActivation {
  at: string;
  testName: string | null;
  fromModel: string;
  toModel: string;
  failureCode: string;
}

interface ModelPolicyState {
  primaryModel: string;
  activeModel: string;
  fallbackModel: string | null;
  fallbackThinkingLevel: SystemTestThinkingLevel | null;
  fallbackOn: readonly string[] | null;
  fallbackScope: "all-turns" | null;
  activations: ModelPolicyActivation[];
}

export interface EvalCancellationProbe {
  runId: string;
  cancel: { ok: true; forcedReset: boolean };
  terminal: { status: string; result?: unknown };
}

export interface EvalEventPagesProbe {
  runId: string;
  firstPage: { events: Array<{ sequence: number; kind: string }>; next: number; hasMore: boolean };
  repeatedFirstPage: {
    events: Array<{ sequence: number; kind: string }>;
    next: number;
    hasMore: boolean;
  };
  pages: Array<{
    events: Array<{ sequence: number; kind: string }>;
    next: number;
    hasMore: boolean;
  }>;
  terminal: { status: string; result?: unknown };
}

export interface AgentVesselFaultProbe {
  targetId: string;
  aborted: true;
}

export interface SelfDevelopmentRepository {
  contextId: string;
  repositoryId: string;
  repoPath: "projects/vibestudio";
  workingHead: VcsStateNodeRef;
}

function fixturePublicationAuthority(
  fixture: (WorkspaceRepoFixtureSpec & { repoName: string | null }) | null
): AgentExecutionTestPolicySpec["authority"] {
  if (!fixture) return [];
  return [
    {
      ruleId: "fixture-publication",
      capability: { kind: "exact", key: "workspace-main-advance" },
      // Main advancement authorizes one immutable, atomic publication rather
      // than one repository ref. The fixture still owns and verifies the
      // repository scope: setup gives the case an isolated task context and
      // teardown rejects/counteracts every publication outside its declared
      // repository fixture.
      resource: {
        kind: "prefix" as const,
        prefix: "workspace-source-change:publication:",
      },
      tier: "gated",
      decision: "once",
    },
  ];
}

function fixtureContextAuthority(
  policy: AgentExecutionTestPolicySpec | null,
  counteractionRepoPaths: readonly string[]
): AgentExecutionTestPolicySpec | null {
  if (!policy || counteractionRepoPaths.length === 0) return policy;
  const repoPaths = [...new Set(counteractionRepoPaths)].sort();
  return {
    ...policy,
    authority: [
      ...policy.authority,
      ...repoPaths.map((repoPath, index) => ({
        ruleId: `fixture-counteraction-delete-${index + 1}`,
        capability: { kind: "exact" as const, key: "workspace-repo-delete" },
        resource: {
          kind: "exact" as const,
          key: `workspace-repo-delete:${repoPath}`,
        },
        tier: "critical" as const,
        decision: "once" as const,
      })),
    ],
  };
}

export class HeadlessRunner {
  readonly validationEvidenceReader: BlobReader = blobstore;

  private contextId: string;
  private readonly shared: {
    sessions: Set<HeadlessSession>;
    testNames: Map<HeadlessSession, string | null>;
    modelPolicy: ModelPolicyState;
    thinkingLevel?: SystemTestThinkingLevel;
    sessionPolicies: Map<HeadlessSession, ModelPolicyState>;
  };
  private readonly testName: string | null;
  private readonly workspaceRepoFixture:
    | (WorkspaceRepoFixtureSpec & { repoName: string | null })
    | null;
  private readonly workspaceRepoFixtureLifecycle: WorkspaceRepoFixtureLifecycle | null;
  private readonly testAuthorityPolicy: AgentExecutionTestPolicySpec | null;
  private developmentTargetPromise: Promise<string> | null = null;

  /**
   * Model is per-agent, so each spawned headless agent is created with the
   * pinned system-test model as its initial config (via creation stateArgs),
   * unless a caller explicitly requests a model-specific test run.
   */
  constructor(
    contextId: string,
    opts?: { model?: string; thinkingLevel?: SystemTestThinkingLevel },
    shared?: {
      sessions: Set<HeadlessSession>;
      testNames: Map<HeadlessSession, string | null>;
      modelPolicy: HeadlessRunner["shared"]["modelPolicy"];
      thinkingLevel?: SystemTestThinkingLevel;
      sessionPolicies: Map<HeadlessSession, ModelPolicyState>;
    },
    testName: string | null = null,
    workspaceRepoFixture: HeadlessRunner["workspaceRepoFixture"] = null,
    testAuthorityPolicy: AgentExecutionTestPolicySpec | null = null
  ) {
    this.contextId = contextId;
    const primaryModel = opts?.model ?? SYSTEM_TEST_AGENT_MODEL;
    const modelRoute = systemTestModelRoute(primaryModel, opts?.model === undefined);
    this.shared = shared ?? {
      sessions: new Set(),
      testNames: new Map(),
      sessionPolicies: new Map(),
      ...(opts?.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
      modelPolicy: {
        ...modelRoute,
        activeModel: primaryModel,
        activations: [],
      },
    };
    this.testName = testName;
    this.testAuthorityPolicy = testAuthorityPolicy;
    this.workspaceRepoFixture = workspaceRepoFixture;
    this.workspaceRepoFixtureLifecycle = workspaceRepoFixture
      ? new WorkspaceRepoFixtureLifecycle(
          {
            vcs,
            blobstore,
            createContext: (input) => {
              const contextPolicy = fixtureContextAuthority(
                testAuthorityPolicy,
                input?.counteractionRepoPaths ?? []
              );
              return rpc.call<{ contextId: string }>("main", "runtime.createContext", [
                contextPolicy ? { testPolicy: contextPolicy } : {},
              ]);
            },
            destroyContext: (contextId) =>
              rpc.call<void>("main", "runtime.destroyContext", [{ contextId, recursive: true }]),
          },
          testName ?? "unknown",
          workspaceRepoFixture.repoName,
          workspaceRepoFixture
        )
      : null;
  }

  /** Exact provider:model ref every spawned test agent must execute. */
  get modelRef(): string {
    return this.shared.modelPolicy.activeModel;
  }

  /** Seed repository basename, or null for a task-created repository scope. */
  get workspaceRepoName(): string | null {
    return this.workspaceRepoFixture?.repoName ?? null;
  }

  /** Serializable evidence for inspect/status output. */
  modelPolicySnapshot(session?: HeadlessSession): Readonly<ModelPolicyState> {
    const policy = (session && this.shared.sessionPolicies.get(session)) ?? this.shared.modelPolicy;
    return {
      ...policy,
      activations: policy.activations.map((activation) => ({ ...activation })),
    };
  }

  /** A concurrency-safe runner view that associates every spawned session with one test. */
  forTest(
    testName: string,
    opts?: {
      workspaceRepoFixture?: WorkspaceRepoFixtureSpec;
      authorityPolicy?: TestAuthorityPolicy;
    }
  ): HeadlessRunner {
    const repoNameStem = `system-test-${slugifyTestName(testName)}-`;
    const workspaceRepoFixture = opts?.workspaceRepoFixture
      ? {
          repoName:
            opts.workspaceRepoFixture.kind === "created-repository"
              ? null
              : `${repoNameStem}${crypto.randomUUID().slice(0, 8)}`,
          ...opts.workspaceRepoFixture,
        }
      : null;
    const authorityPolicy =
      typeof opts?.authorityPolicy === "function"
        ? opts.authorityPolicy({ testName, workspaceRepoFixture })
        : opts?.authorityPolicy;
    return new HeadlessRunner(
      this.contextId,
      {
        model: this.shared.modelPolicy.primaryModel,
        ...(this.shared.thinkingLevel ? { thinkingLevel: this.shared.thinkingLevel } : {}),
      },
      this.shared,
      testName,
      workspaceRepoFixture,
      {
        testId: testName,
        agent: {
          model: this.shared.modelPolicy.primaryModel,
          approvalLevel: 2,
          fallback:
            this.shared.modelPolicy.fallbackModel &&
            this.shared.modelPolicy.fallbackThinkingLevel === "low" &&
            this.shared.modelPolicy.fallbackOn?.[0] === "usage_limit_terminal"
              ? {
                  model: this.shared.modelPolicy.fallbackModel,
                  thinkingLevel: "low",
                  on: ["usage_limit_terminal"],
                  scope: "all-turns",
                }
              : "disabled",
        },
        authority: [
          {
            ruleId: "model-credential",
            capability: { kind: "exact", key: "credential.use" },
            resource: { kind: "exact", key: "credential.use" },
            tier: "gated",
            decision: "once",
          },
          {
            ruleId: "headless-channel",
            capability: { kind: "exact", key: "workspace-service:channel" },
            resource: {
              kind: "prefix",
              prefix: "do:workers/pubsub-channel:PubSubChannel:headless-",
            },
            tier: "gated",
            decision: "once",
          },
          {
            ruleId: "workspace-state-runtime",
            capability: { kind: "exact", key: "workspace-service:workspace.state" },
            resource: {
              kind: "prefix",
              prefix: "do:vibestudio/internal:WorkspaceDO:",
            },
            tier: "gated",
            decision: "once",
          },
          {
            ruleId: "semantic-workspace",
            capability: { kind: "exact", key: "workspace-service:gad.workspace" },
            resource: {
              kind: "exact",
              key: "do:workers/workspace-source:GadWorkspaceDO:workspace",
            },
            tier: "gated",
            decision: "once",
          },
          {
            ruleId: "model-settings",
            capability: { kind: "exact", key: "workspace-service:models" },
            resource: {
              kind: "exact",
              key: "do:workers/model-settings:ModelSettingsDO:workspace-model-settings",
            },
            tier: "gated",
            decision: "once",
          },
          ...fixturePublicationAuthority(workspaceRepoFixture),
          ...(authorityPolicy?.authority ?? []),
        ],
        unexpectedPrompts: "fail",
      }
    );
  }

  /**
   * Create one exact task context. Seeded variants commit their typed source
   * repository only on that local line; task-created variants deliberately
   * begin with no repository and derive ownership from the task's work.
   */
  async prepareWorkspaceRepoFixture(): Promise<WorkspaceRepoFixtureState> {
    return this.requireWorkspaceRepoFixtureLifecycle().prepare();
  }

  /**
   * Retire the exact task-authored scope. Published work on this context's
   * first-parent line is counteracted; concurrent integration-parent work is
   * never attributed to this test.
   */
  async cleanupWorkspaceRepoFixture(
    state: WorkspaceRepoFixtureState,
    onPhase?: (phase: string) => void
  ): Promise<WorkspaceRepoFixtureCleanup> {
    return this.requireWorkspaceRepoFixtureLifecycle().cleanup(state, onPhase);
  }

  /**
   * Spawn a headless session bound to this panel.
   *
   * The test agent's eval executes server-side in the agent's own EvalDO. The
   * agent uses the standard Vibestudio chat prompt and tool surface; panel/UI
   * tools like inline_ui and feedback_form are simply absent because no panel
   * is connected to this headless session. Tests that specifically exercise
   * UI-tool selection may opt into synthetic panel UI methods; those publish
   * the same typed channel events but do not mount browser renderers.
   *
   * Per-test prompt overrides can be passed through spawn extraConfig as
   * `systemPrompt` and `systemPromptMode`.
   */
  async spawn(opts?: {
    source?: string;
    className?: string;
    /**
     * System tests default to isolated agent contexts so VCS state cannot leak
     * across tests or through the orchestrating panel. Use "parent" only when a
     * test explicitly needs the orchestrator's context.
     */
    context?: "isolated" | "task" | "parent";
    /**
     * Test-only harness mode: advertise panel-local UI methods from the
     * headless client so spawned agents can exercise inline_ui/action-bar tool
     * calls and typed UI event publication without a browser panel.
     */
    syntheticPanelUiTools?: boolean;
    /**
     * Advertise a deterministic first-call argument-rejection probe. This is a
     * fault-injection seam for harness resilience tests, not a product tool.
     */
    validationRetryProbeTool?: boolean;
    /** Additional test-owned participant methods advertised to the agent. */
    methods?: HeadlessWithAgentConfig["methods"];
    /** Test-specific policy appended after the shared system-test prompt. */
    additionalSystemPrompt?: string;
  }): Promise<HeadlessSession> {
    const policy = this.shared.modelPolicy;
    const model = policy.activeModel;
    const contextMode = opts?.context ?? (this.workspaceRepoFixture ? "task" : "isolated");
    const taskContextId = this.workspaceRepoFixtureLifecycle?.taskContextId ?? null;
    if (contextMode === "task" && !taskContextId) {
      throw new Error(
        "Workspace repository fixture must be prepared before spawning its task agent"
      );
    }
    const agentContextId =
      contextMode === "parent"
        ? this.contextId
        : contextMode === "task"
          ? taskContextId
          : undefined;
    const fixturePrompt = this.workspaceRepoFixture
      ? this.workspaceRepoFixture.kind === "created-repository"
        ? `\n\nHarness-owned test scope: this task owns exactly one repository that it creates under ${JSON.stringify(
            `${this.workspaceRepoFixture.section}/`
          )}. All pre-existing repositories and every other newly created repository are outside the test scope.`
        : this.workspaceRepoFixture.kind === "buildable-panel-with-derived"
          ? `\n\nHarness-owned test scope: the disposable source repository ${JSON.stringify(
              `${this.workspaceRepoFixture.section}/${this.workspaceRepoFixture.repoName}`
            )} is already present in this context. This task owns that source and exactly one derived repository it creates under ${JSON.stringify(
              `${this.workspaceRepoFixture.section}/`
            )}; all other repositories are outside the test scope.`
          : `\n\nHarness-owned test scope: the exact disposable repository ${JSON.stringify(
              `${this.workspaceRepoFixture.section}/${this.workspaceRepoFixture.repoName}`
            )} is already present in this context. It is the only repository owned by this test; ` +
            `all other repositories are outside the fixture scope.`
      : "";
    const session = await HeadlessSession.createWithAgent({
      config: {
        clientId: rpc.selfId,
        rpc: rpcConfig,
      },
      rpcCall: (t: string, m: string, args: unknown[], options) =>
        rpcConfig.call(t, m, args, options),
      source: opts?.source ?? "workers/agent-worker",
      className: opts?.className ?? "AiChatWorker",
      ...(agentContextId ? { contextId: agentContextId } : {}),
      ...(!agentContextId && this.testAuthorityPolicy
        ? { testPolicy: this.testAuthorityPolicy }
        : {}),
      includeSyntheticPanelUiMethods: opts?.syntheticPanelUiTools === true,
      includeValidationRetryProbeMethod: opts?.validationRetryProbeTool === true,
      ...(opts?.methods ? { methods: opts.methods } : {}),
      // The model rides the spawned agent's CREATION config (per-agent, seeded
      // from stateArgs.agentConfig) so it inherits the orchestrator's model.
      extraConfig: {
        // System tests are unattended by definition. Keep full-auto explicit
        // here instead of relying only on the channel default, so a workspace
        // or client default cannot leave a run waiting for approval.
        approvalLevel: 2,
        systemPrompt: `${SYSTEM_TEST_AGENT_PROMPT}${fixturePrompt}${opts?.additionalSystemPrompt ?? ""}`,
        systemPromptMode: "append",
        model,
        ...(this.shared.thinkingLevel ? { thinkingLevel: this.shared.thinkingLevel } : {}),
        ...(policy.fallbackModel &&
        policy.fallbackThinkingLevel &&
        policy.fallbackOn &&
        policy.fallbackScope
          ? {
              fallbackModel: policy.fallbackModel,
              fallbackThinkingLevel: policy.fallbackThinkingLevel,
              fallbackOn: [...policy.fallbackOn],
              fallbackScope: policy.fallbackScope,
            }
          : {}),
      },
    });
    this.shared.sessions.add(session);
    this.shared.testNames.set(session, this.testName);
    const sessionPolicy: ModelPolicyState = {
      primaryModel: model,
      activeModel: model,
      fallbackModel: policy.fallbackModel,
      fallbackThinkingLevel: policy.fallbackThinkingLevel,
      fallbackOn: policy.fallbackOn,
      fallbackScope: policy.fallbackScope,
      activations: [],
    };
    this.shared.sessionPolicies.set(session, sessionPolicy);
    return session;
  }

  /** Non-blocking live snapshots for CLI inspection. Observation never issues
   * evidence RPCs, so it cannot perturb the run it describes. */
  snapshotAll(): Array<{ testName: string | null; snapshot: SessionSnapshot }> {
    return [...this.shared.sessions].map((session) => ({
      testName: this.shared.testNames.get(session) ?? null,
      snapshot: session.snapshot(),
    }));
  }

  async collectDiagnostics(opts?: {
    channelId?: string | null;
    branchId?: string | null;
  }): Promise<Record<string, unknown>> {
    const channelId = opts?.channelId ?? null;
    const diagnostics: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      contextId: this.contextId,
      channelId,
    };
    try {
      diagnostics["buildProvenance"] = await rpc.call("main", "build.inspectBuildProvenance", [
        "@workspace-skills/system-testing",
      ]);
    } catch (err) {
      diagnostics["buildProvenanceFailure"] = systemTestFailure("diagnostic:build-provenance", err);
    }
    try {
      diagnostics["durableWork"] = await rpc.call("main", "durableWork.inspect", []);
    } catch (err) {
      diagnostics["durableWorkFailure"] = systemTestFailure("diagnostic:durable-work", err);
    }
    if (channelId) {
      try {
        diagnostics["agentHealth"] = await gad.inspectAgentHealth({
          channelId,
          branchId: opts?.branchId,
          limit: 50,
          envelopeLimit: 25,
          storageLimit: 25,
        });
      } catch (err) {
        diagnostics["agentHealthFailure"] = systemTestFailure("diagnostic:agent-health", err);
      }
    }
    return diagnostics;
  }

  /**
   * Exercise the host-side asynchronous eval contract from the harness that
   * owns the run. An ordinary agent tool call is intentionally synchronous, so
   * asking that same blocked turn to discover and cancel its own run cannot
   * test cancellation.
   */
  async probeEvalCancellation(): Promise<EvalCancellationProbe> {
    const runId = `system-test-cancel-${crypto.randomUUID()}`;
    const subKey = `system-test-cancel-${crypto.randomUUID()}`;
    let activated = false;
    try {
      const started = await rpc.call<{ runId: string }>("main", "eval.start", [
        {
          scope: { key: subKey, lifecycle: "finite" },
          runId,
          source: { kind: "inline", code: "await new Promise(() => {});" },
        },
      ]);
      activated = true;
      if (started.runId !== runId) {
        throw new Error(`eval.start returned ${started.runId}, expected ${runId}`);
      }
      const cancel = await rpc.call<{ ok: true; forcedReset: boolean }>("main", "eval.cancel", [
        { scopeKey: subKey, runId },
      ]);
      const terminal = await rpc.call<{ status: string; result?: unknown }>("main", "eval.get", [
        { scopeKey: subKey, runId },
      ]);
      return { runId, cancel, terminal };
    } finally {
      if (activated) {
        await rpc.call("main", "eval.dispose", [{ scopeKey: subKey }]);
      }
    }
  }

  /**
   * Prove that a completed owner-scoped run retains a stable event stream.
   * The same first cursor is read twice, then every subsequent page advances
   * through the durable cursor. This is deliberately a harness probe: an eval
   * turn cannot read its own event journal until it has already settled.
   */
  async probeEvalEventPages(): Promise<EvalEventPagesProbe> {
    const runId = `system-test-events-${crypto.randomUUID()}`;
    const subKey = `system-test-events-${crypto.randomUUID()}`;
    let activated = false;
    try {
      const started = await rpc.call<{ runId: string }>("main", "eval.start", [
        {
          scope: { key: subKey, lifecycle: "finite" },
          runId,
          source: {
            kind: "inline",
            code: 'console.log("SYSTEM_TEST_EVAL_EVENT"); return { eventProbe: true };',
          },
        },
      ]);
      activated = true;
      if (started.runId !== runId) {
        throw new Error(`eval.start returned ${started.runId}, expected ${runId}`);
      }
      let terminal: { status: string; result?: unknown } | null = null;
      const settleDeadline = Date.now() + 30_000;
      while (Date.now() < settleDeadline) {
        terminal = await rpc.call<{ status: string; result?: unknown }>("main", "eval.get", [
          { scopeKey: subKey, runId },
        ]);
        if (terminal.status === "done" || terminal.status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!terminal || (terminal.status !== "done" && terminal.status !== "cancelled")) {
        throw new Error(`eval run ${runId} did not settle before event pagination`);
      }
      const readPage = () =>
        rpc.call<EvalEventPagesProbe["firstPage"]>("main", "eval.events", [
          { scopeKey: subKey, runId, after: 0, limit: 1 },
        ]);
      const firstPage = await readPage();
      const repeatedFirstPage = await readPage();
      const pages: EvalEventPagesProbe["pages"] = [];
      let after = 0;
      do {
        const page = await rpc.call<EvalEventPagesProbe["firstPage"]>("main", "eval.events", [
          { scopeKey: subKey, runId, after, limit: 1 },
        ]);
        pages.push(page);
        after = page.next;
        if (!page.hasMore) break;
      } while (pages.length < 256);
      if (pages.at(-1)?.hasMore) throw new Error(`eval event stream exceeded bounded pagination`);
      return { runId, firstPage, repeatedFirstPage, pages, terminal };
    } finally {
      if (activated) await rpc.call("main", "eval.dispose", [{ scopeKey: subKey }]);
    }
  }

  /**
   * Abort one exact ordinary headless-agent facet while preserving its durable
   * storage. This is intentionally a harness-only fault seam. Product agents
   * do not get a crash tool; the system scenario uses it after observing one
   * live eval invocation so durable invocation replay crosses a real vessel
   * instance loss without disrupting unrelated agents.
   */
  async faultAbortAgentVesselForReplayProbe(targetId: string): Promise<AgentVesselFaultProbe> {
    const result = await rpc.call<{ aborted: true }>("main", "runtime.faultAbortAgentVessel", [
      { targetId },
    ]);
    return { targetId, aborted: result.aborted };
  }

  /**
   * Resolve the application checkout from the harness-owned semantic context.
   * Self-development scenarios use this host-captured identity instead of
   * asking a model to guess or restate a repository id.
   */
  async resolveSelfDevelopmentRepository(): Promise<SelfDevelopmentRepository> {
    const status = await vcs.status({ contextId: this.contextId });
    const repository = await vcs.resolveRepository({
      state: status.workingHead,
      repoPath: "projects/vibestudio",
    });
    if (!repository) {
      throw Object.assign(
        new Error(
          "Self-development prerequisite unavailable: projects/vibestudio is not adopted in the harness context"
        ),
        { code: "ESELFDEVELOPMENT_REPOSITORY" }
      );
    }
    return {
      contextId: this.contextId,
      repositoryId: repository.repositoryId,
      repoPath: "projects/vibestudio",
      workingHead: status.workingHead,
    };
  }

  /**
   * Harness-owned access to the ordinary public development service. Keeping
   * the call here makes scenario orchestration use the exact same dispatcher
   * and authority preparation as panels and eval clients, while evidence is
   * captured by the harness rather than copied from an agent response.
   */
  async callSelfDevelopment<T>(
    method:
      | "openSession"
      | "getSession"
      | "listRecipes"
      | "listClientExecutors"
      | "listNativeTools"
      | "start"
      | "faultFailBuildAfterSnapshotRetained"
      | "get"
      | "list"
      | "events"
      | "stop"
      | "retry"
      | "checkpoint"
      | "inspectNative"
      | "writeNativeTerminal"
      | "stopNativeTool"
      | "closeSession",
    input?: unknown
  ): Promise<T> {
    this.developmentTargetPromise ??= workers
      .resolveService("vibestudio.development.v1")
      .then((service) => {
        if (service.kind !== "durable-object" || !service.targetId) {
          throw new Error("vibestudio.development.v1 did not resolve to a Durable Object service");
        }
        return service.targetId;
      })
      .catch((error: unknown) => {
        this.developmentTargetPromise = null;
        throw error;
      });
    const targetId = await this.developmentTargetPromise;
    return rpc.call<T>(targetId, method, input === undefined ? [] : [input]);
  }

  /** Invoke the owner-scoped ordinary attached-host client surface. */
  async callAttachedDevelopmentHost<T>(
    sessionId: string,
    service: string,
    method: string,
    args: unknown[]
  ): Promise<T> {
    return rpc.call<T>("main", "attachedHosts.invokeAttached", [
      { sessionId, service, method, args },
    ]);
  }

  /** Open and attest the owner-scoped ordinary attached-host client. */
  async attachDevelopmentHost(sessionId: string): Promise<{
    sessionId: string;
    developmentRunId: string;
    childHostId: string;
    childGenerationId: string;
    authorityCeilingDigest: string;
    expiresAt: number;
  }> {
    return rpc.call("main", "attachedHosts.attachClient", [{ sessionId }]);
  }

  /** Read bounded parent-captured approval evidence without changing child results. */
  async listAttachedDevelopmentHostApprovalAudit(
    sessionId: string,
    input: { after?: string; limit?: number } = {}
  ): Promise<{
    events: AttachedHostApprovalAuditEvent[];
    nextCursor: string | null;
  }> {
    return rpc.call("main", "attachedHosts.listApprovalAudit", [{ sessionId, ...input }]);
  }

  /** Author one disposable semantic marker used to prove dirty-state capture. */
  async createSelfDevelopmentDirtyMarker(
    repository: SelfDevelopmentRepository,
    commandId: string
  ): Promise<unknown> {
    return vcs.edit({
      contextId: repository.contextId,
      commandId,
      expectedWorkingHead: repository.workingHead,
      intentSummary: "Exercise exact dirty semantic self-development input",
      changes: [
        {
          kind: "file-create",
          repositoryId: repository.repositoryId,
          path: `.vibestudio-system-test/${commandId.replace(/[^a-zA-Z0-9._-]/gu, "-")}.txt`,
          content: { kind: "text", text: "self-development dirty-state probe\n" },
          mode: 0o644,
        },
      ],
    });
  }

  /** Discard only the harness-authored uncommitted marker after it is captured. */
  async discardSelfDevelopmentDirtyMarker(
    contextId: string,
    expectedWorkingHead: unknown,
    commandId: string
  ): Promise<unknown> {
    return vcs.discard({
      contextId,
      commandId,
      expectedWorkingHead: vcsStateNodeRefSchema.parse(expectedWorkingHead),
    });
  }

  private requireWorkspaceRepoFixture(): NonNullable<HeadlessRunner["workspaceRepoFixture"]> {
    if (!this.workspaceRepoFixture) {
      throw new Error(
        "Workspace repo fixture lifecycle was requested for a test without a fixture"
      );
    }
    return this.workspaceRepoFixture;
  }

  private requireWorkspaceRepoFixtureLifecycle(): WorkspaceRepoFixtureLifecycle {
    this.requireWorkspaceRepoFixture();
    if (!this.workspaceRepoFixtureLifecycle) {
      throw new Error("Workspace repository fixture lifecycle is unavailable");
    }
    return this.workspaceRepoFixtureLifecycle;
  }
}

function slugifyTestName(testName: string): string {
  const slug = testName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return slug || "case";
}
