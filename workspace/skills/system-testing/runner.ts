import { HeadlessSession, type SessionSnapshot } from "@workspace/agentic-session";
import type { ConnectionConfig } from "@workspace/agentic-core";
import { gad, rpc, vcs } from "@workspace/runtime";
import {
  SYSTEM_TEST_AGENT_MODEL,
  SYSTEM_TEST_FALLBACK_FAILURE_CODE,
  SYSTEM_TEST_FALLBACK_MODEL,
  SYSTEM_TEST_FALLBACK_THINKING_LEVEL,
} from "./config.js";

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

export interface WorkspaceRepoFixtureState {
  testName: string;
  repoName: string;
  repoNamePrefix: string;
  reposBefore: string[];
  staleReposRemoved: string[];
}

export interface WorkspaceRepoFixtureCleanup {
  reposRemoved: string[];
  escapedRepos: string[];
  reposAfter: string[];
}

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
  private readonly workspaceRepoFixture: {
    repoName: string;
    repoNamePrefix: string;
  } | null;

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
    this.shared = shared ?? {
      sessions: new Set(),
      testNames: new Map(),
      sessionPolicies: new Map(),
      modelPolicy: {
        primaryModel,
        activeModel: primaryModel,
        fallbackModel: primaryModel === SYSTEM_TEST_AGENT_MODEL ? SYSTEM_TEST_FALLBACK_MODEL : null,
        fallbackThinkingLevel:
          primaryModel === SYSTEM_TEST_AGENT_MODEL ? SYSTEM_TEST_FALLBACK_THINKING_LEVEL : null,
        fallbackOn:
          primaryModel === SYSTEM_TEST_AGENT_MODEL ? SYSTEM_TEST_FALLBACK_FAILURE_CODE : null,
        activations: [],
      },
    };
    this.testName = testName;
    this.workspaceRepoFixture = workspaceRepoFixture;
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
  forTest(testName: string, opts?: { workspaceRepoFixture?: boolean }): HeadlessRunner {
    const repoNamePrefix = `system-test-${slugifyTestName(testName)}-`;
    const workspaceRepoFixture = opts?.workspaceRepoFixture
      ? {
          repoNamePrefix,
          repoName: `${repoNamePrefix}${crypto.randomUUID().slice(0, 8)}`,
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
   * Remove only stale repos carrying this test's reserved fixture prefix, then
   * snapshot the published repo set. Repos outside the reserved namespace are
   * never removed by setup.
   */
  async prepareWorkspaceRepoFixture(): Promise<WorkspaceRepoFixtureState> {
    const fixture = this.requireWorkspaceRepoFixture();
    const staleRepos = (await this.listMainRepoPaths()).filter((repoPath) =>
      repoBasename(repoPath).startsWith(fixture.repoNamePrefix)
    );
    for (const repoPath of staleRepos) {
      await vcs.deleteRepo({ repoPath, force: true });
    }
    return {
      testName: this.testName ?? "unknown",
      repoName: fixture.repoName,
      repoNamePrefix: fixture.repoNamePrefix,
      reposBefore: await this.listMainRepoPaths(),
      staleReposRemoved: staleRepos,
    };
  }

  /**
   * Remove every published repo in the reserved fixture namespace. Newly
   * published repos outside that namespace are reported and deliberately left
   * intact, avoiding accidental deletion of concurrent user work.
   */
  async cleanupWorkspaceRepoFixture(
    state: WorkspaceRepoFixtureState
  ): Promise<WorkspaceRepoFixtureCleanup> {
    const currentRepos = await this.listMainRepoPaths();
    const ownedRepos = currentRepos.filter((repoPath) =>
      repoBasename(repoPath).startsWith(state.repoNamePrefix)
    );
    const ownedSet = new Set(ownedRepos);
    const before = new Set(state.reposBefore);
    const escapedRepos = currentRepos.filter(
      (repoPath) => !before.has(repoPath) && !ownedSet.has(repoPath)
    );
    for (const repoPath of ownedRepos) {
      await vcs.deleteRepo({ repoPath, force: true });
    }
    return {
      reposRemoved: ownedRepos,
      escapedRepos,
      reposAfter: await this.listMainRepoPaths(),
    };
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
    context?: "isolated" | "parent";
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
    const fixturePrompt = this.workspaceRepoFixture
      ? `\n\nHarness-owned workspace fixture: if this task creates or forks a disposable ` +
        `workspace repo, use the exact repo basename ${JSON.stringify(
          this.workspaceRepoFixture.repoName
        )} whenever the API asks for its name. This is isolation metadata only; ` +
        `choose the normal documented product workflow and do not substitute fixture-specific APIs.`
      : "";
    const session = await HeadlessSession.createWithAgent({
      config: {
        clientId: rpc.selfId,
        rpc: rpcConfig,
      },
      rpcCall: (t: string, m: string, args: unknown[]) => rpcConfig.call(t, m, args),
      source: opts?.source ?? "workers/agent-worker",
      className: opts?.className ?? "AiChatWorker",
      ...(opts?.context === "parent" ? { contextId: this.contextId } : {}),
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

  /** Retire every still-live test agent. Registered with EvalDO cancellation. */
  async closeAll(): Promise<void> {
    const sessions = [...this.shared.sessions];
    await Promise.allSettled(sessions.map((session) => session.close()));
    for (const session of sessions) this.shared.sessionPolicies.delete(session);
  }

  /** Capture every active/retained session before cancellation tears down its participant. */
  async captureAll(): Promise<Array<{ testName: string | null; snapshot: SessionSnapshot }>> {
    const rows: Array<{ testName: string | null; snapshot: SessionSnapshot }> = [];
    for (const session of this.shared.sessions) {
      try {
        await session.captureModelExecutionEvidence();
      } catch {
        // snapshot() retains the concrete evidence error for diagnostics.
      }
      rows.push({
        testName: this.shared.testNames.get(session) ?? null,
        snapshot: session.snapshot(),
      });
    }
    return rows;
  }

  /** Non-blocking live snapshots for CLI inspection. Unlike captureAll this
   * does not issue evidence RPCs, so observing a run cannot perturb it. */
  snapshotAll(): Array<{ testName: string | null; snapshot: SessionSnapshot }> {
    return [...this.shared.sessions].map((session) => ({
      testName: this.shared.testNames.get(session) ?? null,
      snapshot: session.snapshot(),
    }));
  }

  async collectDiagnostics(opts?: {
    channelId?: string | null;
    branchId?: string | null;
    error?: unknown;
  }): Promise<Record<string, unknown>> {
    const channelId = opts?.channelId ?? null;
    const diagnostics: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      contextId: this.contextId,
      channelId,
      error:
        opts?.error instanceof Error ? opts.error.message : opts?.error ? String(opts.error) : null,
    };
    try {
      diagnostics["buildProvenance"] = await rpc.call("main", "build.inspectBuildProvenance", [
        "@workspace-skills/system-testing",
      ]);
    } catch (err) {
      diagnostics["buildProvenanceError"] = err instanceof Error ? err.message : String(err);
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
        diagnostics["agentHealthError"] = err instanceof Error ? err.message : String(err);
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

  private async listMainRepoPaths(): Promise<string[]> {
    const refs = await rpc.call<Array<{ repoPath?: unknown }>>("main", "refs.listMains", []);
    return [
      ...new Set(
        refs
          .map((ref) => ref.repoPath)
          .filter((repoPath): repoPath is string => typeof repoPath === "string")
      ),
    ].sort();
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

function repoBasename(repoPath: string): string {
  return repoPath.slice(repoPath.lastIndexOf("/") + 1);
}
