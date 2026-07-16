import { HeadlessSession, type SessionSnapshot } from "@workspace/agentic-session";
import type { ConnectionConfig } from "@workspace/agentic-core";
import { blobstore, gad, rpc, vcs } from "@workspace/runtime";
import {
  SYSTEM_TEST_AGENT_MODEL,
  SYSTEM_TEST_FALLBACK_FAILURE_CODE,
  SYSTEM_TEST_FALLBACK_MODEL,
  SYSTEM_TEST_FALLBACK_THINKING_LEVEL,
  systemTestModelRoute,
} from "./config.js";
import { systemTestFailure } from "./structured-error.js";
import {
  WorkspaceRepoFixtureLifecycle,
  type WorkspaceRepoFixtureCleanup,
  type WorkspaceRepoFixtureSpec,
  type WorkspaceRepoFixtureState,
} from "./workspace-repo-fixture.js";

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
  failureCode: typeof SYSTEM_TEST_FALLBACK_FAILURE_CODE;
}

interface ModelPolicyState {
  primaryModel: string;
  activeModel: string;
  fallbackModel: string | null;
  fallbackThinkingLevel: typeof SYSTEM_TEST_FALLBACK_THINKING_LEVEL | null;
  fallbackOn: typeof SYSTEM_TEST_FALLBACK_FAILURE_CODE | null;
  activations: ModelPolicyActivation[];
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
  private readonly workspaceRepoFixture: (WorkspaceRepoFixtureSpec & { repoName: string }) | null;
  private readonly workspaceRepoFixtureLifecycle: WorkspaceRepoFixtureLifecycle | null;

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
    workspaceRepoFixture: HeadlessRunner["workspaceRepoFixture"] = null
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
    this.workspaceRepoFixture = workspaceRepoFixture;
    this.workspaceRepoFixtureLifecycle = workspaceRepoFixture
      ? new WorkspaceRepoFixtureLifecycle(
          {
            vcs,
            blobstore,
            createContext: () =>
              rpc.call<{ contextId: string }>("main", "runtime.createContext", [{}]),
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

  /** Exact disposable repository basename reserved for this test, when enabled. */
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
    opts?: { workspaceRepoFixture?: WorkspaceRepoFixtureSpec }
  ): HeadlessRunner {
    const repoNameStem = `system-test-${slugifyTestName(testName)}-`;
    const workspaceRepoFixture = opts?.workspaceRepoFixture
      ? {
          repoName: `${repoNameStem}${crypto.randomUUID().slice(0, 8)}`,
          ...opts.workspaceRepoFixture,
        }
      : null;
    return new HeadlessRunner(
      this.contextId,
      { model: this.shared.modelPolicy.primaryModel },
      this.shared,
      testName,
      workspaceRepoFixture
    );
  }

  /**
   * Create one exact task context and commit its typed repository fixture only
   * on that local line. The scenario publishes it explicitly when sharing is
   * part of the user-visible workflow.
   */
  async prepareWorkspaceRepoFixture(): Promise<WorkspaceRepoFixtureState> {
    return this.requireWorkspaceRepoFixtureLifecycle().prepare();
  }

  /**
   * Retire the exact fixture identity. If it reached main, delete only that
   * identity; other task-authored published repositories are reported and left
   * intact, avoiding accidental deletion of concurrent user work.
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
  }): Promise<HeadlessSession> {
    const policy = this.shared.modelPolicy;
    const model = policy.activeModel;
    const usingFallbackModel = model === SYSTEM_TEST_FALLBACK_MODEL;
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
      ? `\n\nHarness-owned test scope: the exact disposable repository ${JSON.stringify(
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
      includeSyntheticPanelUiMethods: opts?.syntheticPanelUiTools === true,
      // The model rides the spawned agent's CREATION config (per-agent, seeded
      // from stateArgs.agentConfig) so it inherits the orchestrator's model.
      extraConfig: {
        // System tests are unattended by definition. Keep full-auto explicit
        // here instead of relying only on the channel default, so a workspace
        // or client default cannot leave a run waiting for approval.
        approvalLevel: 2,
        systemPrompt: `${SYSTEM_TEST_AGENT_PROMPT}${fixturePrompt}`,
        systemPromptMode: "append",
        model,
        ...(usingFallbackModel ? { thinkingLevel: SYSTEM_TEST_FALLBACK_THINKING_LEVEL } : {}),
        ...(!usingFallbackModel && policy.fallbackModel && policy.fallbackThinkingLevel
          ? {
              fallbackModel: policy.fallbackModel,
              fallbackThinkingLevel: policy.fallbackThinkingLevel,
              fallbackOn: [SYSTEM_TEST_FALLBACK_FAILURE_CODE],
              fallbackScope: "all-turns",
            }
          : {}),
      },
    });
    this.shared.sessions.add(session);
    this.shared.testNames.set(session, this.testName);
    const sessionPolicy: ModelPolicyState = {
      primaryModel: model,
      activeModel: model,
      fallbackModel: usingFallbackModel ? null : policy.fallbackModel,
      fallbackThinkingLevel: usingFallbackModel ? null : policy.fallbackThinkingLevel,
      fallbackOn: usingFallbackModel ? null : policy.fallbackOn,
      activations: [],
    };
    this.shared.sessionPolicies.set(session, sessionPolicy);
    session.onMessage((message) => {
      const current = this.shared.sessionPolicies.get(session);
      if (!current) return;
      const continuedNotice = message.diagnostic?.code === "model.fallback_continued";
      const terminalUsageLimit =
        message.diagnostic?.code === "message_failed" &&
        message.diagnostic?.failureCode === SYSTEM_TEST_FALLBACK_FAILURE_CODE;
      if (
        (!continuedNotice && !terminalUsageLimit) ||
        current.fallbackOn !== SYSTEM_TEST_FALLBACK_FAILURE_CODE ||
        !current.fallbackModel ||
        current.activeModel === current.fallbackModel
      ) {
        return;
      }
      const fromModel = current.activeModel;
      current.activeModel = current.fallbackModel;
      const activation: ModelPolicyActivation = {
        at: new Date().toISOString(),
        testName: this.testName,
        fromModel,
        toModel: current.fallbackModel,
        failureCode: SYSTEM_TEST_FALLBACK_FAILURE_CODE,
      };
      current.activations.push(activation);

      // The shared policy only selects the model for sessions spawned in the
      // future. Existing sessions retain their own immutable route until their
      // own diagnostic activates it.
      const future = this.shared.modelPolicy;
      if (future.activeModel === fromModel && future.fallbackModel === current.activeModel) {
        future.activeModel = current.activeModel;
        future.activations.push({ ...activation });
      }
    });
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
