import {
  HeadlessSession,
  type HeadlessWithAgentConfig,
  type SessionSnapshot,
} from "@workspace/agentic-session";
import type { ConnectionConfig } from "@workspace/agentic-core";
import { blobstore, gad, rpc, vcs } from "@workspace/runtime";
import { SYSTEM_TEST_AGENT_MODEL, systemTestModelRoute } from "./config.js";
import { systemTestFailure } from "./structured-error.js";
import {
  WorkspaceRepoFixtureLifecycle,
  type WorkspaceRepoFixtureCleanup,
  type WorkspaceRepoFixtureSpec,
  type WorkspaceRepoFixtureState,
} from "./workspace-repo-fixture.js";
import type { AgentExecutionTestPolicySpec } from "@vibestudio/shared/authority/testPolicy";

// This runner is eval'd server-side (in the orchestrating agent's EvalDO), so it
// uses the portable client surface — NOT panel-only `getStateArgs`/`slotId`.
// `rpc.selfId` is the stable runtime id, used as the channel-membership clientId.
const rpcConfig = rpc as unknown as NonNullable<ConnectionConfig["rpc"]>;

export const SYSTEM_TEST_AGENT_PROMPT = `You are running inside an automated Vibestudio system test.

Your job is to exercise the documented path honestly, not to make the test pass by inventing workarounds.

When a task depends on Vibestudio behavior, use the relevant docs or skill files to choose the most straightforward supported approach.

Treat the request like a normal user's request. Route from the Available skills index to the closest user-facing skill before doing a broad source search. Do not inspect \`skills/system-testing\`, its test definitions, validators, marker strings, or captured artifacts to reverse-engineer what the test expects; those are harness implementation, not product documentation. Any requested uppercase marker tokens are output bookkeeping only: emit them in the final answer when appropriate, but never search the workspace or docs for them.

This session is genuinely headless: there is no initial visible panel ancestor. The panel tree still works. If a task needs an actual child panel and getParent() is null, follow the documented headless tree pattern: create an owned root panel explicitly, create the requested panel with that root's id as parentId, and close the temporary root to clean the subtree.

If that documented approach fails, stop and report what happened. Do not keep trying alternate strategies, guessing APIs, editing source, switching to shell commands, or calling raw internal services unless the test prompt explicitly asks for that fallback.

When reporting a failure, include the docs or skill files you used, the operation you attempted, the exact error or unexpected result, and the mismatch between the docs and reality.

Use file-loaded eval for substantive multi-line or multi-file eval work. Do not create or edit helper files merely to work around a short documented suite-orchestration eval snippet. If an operation fails, report the error you actually observed, verbatim, with the operation that produced it.

Keep evidence bounded. Report summaries, counts, ids, byte lengths, exact error messages, the final agent message, the validation reason, and the relevant tool call statuses/errors. Do not paste large raw payloads, full database rows, full channel envelopes, image data, or secrets.

Every final response should be concise, include the requested marker tokens exactly when applicable, and mention any problems encountered while setting up or running the test. Never just refer to files or artifacts; describe what the evidence shows and include the concrete mismatch/error in the response.`;

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
  fallbackModel: null;
  fallbackThinkingLevel: null;
  fallbackOn: null;
  activations: ModelPolicyActivation[];
}

function fixturePublicationAuthority(
  fixture: (WorkspaceRepoFixtureSpec & { repoName: string | null }) | null
): AgentExecutionTestPolicySpec["authority"] {
  if (!fixture) return [];
  const resource =
    fixture.kind === "created-repository" || fixture.kind === "buildable-panel-with-derived"
      ? {
          kind: "prefix" as const,
          prefix: `workspace-source-change:${fixture.section}/`,
        }
      : {
          kind: "exact" as const,
          key: `workspace-source-change:${fixture.section}/${fixture.repoName}:main`,
        };
  return [
    {
      ruleId: "fixture-publication",
      capability: "workspace-main-advance",
      resource,
      tier: "gated",
      decision: "once",
    },
  ];
}

export class HeadlessRunner {
  private contextId: string;
  private readonly shared: {
    sessions: Set<HeadlessSession>;
    testNames: Map<HeadlessSession, string | null>;
    modelPolicy: ModelPolicyState;
    sessionPolicies: Map<HeadlessSession, ModelPolicyState>;
  };
  private readonly testName: string | null;
  private readonly workspaceRepoFixture:
    | (WorkspaceRepoFixtureSpec & { repoName: string | null })
    | null;
  private readonly workspaceRepoFixtureLifecycle: WorkspaceRepoFixtureLifecycle | null;
  private readonly testAuthorityPolicy: AgentExecutionTestPolicySpec | null;

  /**
   * Model is per-agent, so each spawned headless agent is created with the
   * pinned system-test model as its initial config (via creation stateArgs),
   * unless a caller explicitly requests a model-specific test run.
   */
  constructor(
    contextId: string,
    opts?: { model?: string },
    shared?: {
      sessions: Set<HeadlessSession>;
      testNames: Map<HeadlessSession, string | null>;
      modelPolicy: HeadlessRunner["shared"]["modelPolicy"];
      sessionPolicies: Map<HeadlessSession, ModelPolicyState>;
    },
    testName: string | null = null,
    workspaceRepoFixture: HeadlessRunner["workspaceRepoFixture"] = null,
    testAuthorityPolicy: AgentExecutionTestPolicySpec | null = null
  ) {
    this.contextId = contextId;
    const primaryModel = opts?.model ?? SYSTEM_TEST_AGENT_MODEL;
    const modelRoute = systemTestModelRoute(primaryModel);
    this.shared = shared ?? {
      sessions: new Set(),
      testNames: new Map(),
      sessionPolicies: new Map(),
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
            createContext: () =>
              rpc.call<{ contextId: string }>("main", "runtime.createContext", [
                testAuthorityPolicy ? { testPolicy: testAuthorityPolicy } : {},
              ]),
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
      authorityPolicy?: Omit<AgentExecutionTestPolicySpec, "testId" | "unexpectedPrompts">;
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
    return new HeadlessRunner(
      this.contextId,
      { model: this.shared.modelPolicy.primaryModel },
      this.shared,
      testName,
      workspaceRepoFixture,
      {
        testId: testName,
        authority: [
          {
            ruleId: "model-credential",
            capability: "credential.use",
            resource: { kind: "exact", key: "credential.use" },
            tier: "gated",
            decision: "once",
          },
          {
            ruleId: "headless-channel",
            capability: "workspace-service:channel",
            resource: {
              kind: "prefix",
              prefix: "do:workers/pubsub-channel:PubSubChannel:headless-",
            },
            tier: "gated",
            decision: "once",
          },
          {
            ruleId: "semantic-workspace",
            capability: "workspace-service:gad.workspace",
            resource: {
              kind: "exact",
              key: "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane",
            },
            tier: "gated",
            decision: "once",
          },
          {
            ruleId: "model-settings",
            capability: "workspace-service:models",
            resource: {
              kind: "exact",
              key: "do:workers/model-settings:ModelSettingsDO:workspace-model-settings",
            },
            tier: "gated",
            decision: "once",
          },
          ...fixturePublicationAuthority(workspaceRepoFixture),
          ...(opts?.authorityPolicy?.authority ?? []),
        ],
        userland: [...(opts?.authorityPolicy?.userland ?? [])],
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
    state: WorkspaceRepoFixtureState
  ): Promise<WorkspaceRepoFixtureCleanup> {
    return this.requireWorkspaceRepoFixtureLifecycle().cleanup(state);
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
      rpcCall: (t: string, m: string, args: unknown[]) => rpcConfig.call(t, m, args),
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
      },
    });
    this.shared.sessions.add(session);
    this.shared.testNames.set(session, this.testName);
    const sessionPolicy: ModelPolicyState = {
      primaryModel: model,
      activeModel: model,
      fallbackModel: null,
      fallbackThinkingLevel: null,
      fallbackOn: null,
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
