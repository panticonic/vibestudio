import { createHash } from "node:crypto";
import { DurableObjectBase, schemaRpc, type DurableObjectContext } from "@vibestudio/durable";
import {
  developmentBuiltinMethods,
  developmentRunSchema,
  developmentSessionSchema,
  type DevelopmentRun,
  type DevelopmentSession,
} from "@vibestudio/service-schemas/development";
import type {
  nativeDevelopmentSessionReceiptSchema,
  nativeDevelopmentTerminalSnapshotSchema,
  preparedNativeBuildSchema,
} from "@vibestudio/service-schemas/developmentNative";
import type { VcsInspectResult, VcsStatusResult } from "@vibestudio/service-schemas/vcs";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import type { z } from "zod";
import { DevelopmentStore, developmentSessionId } from "./DevelopmentStore.js";
import { developmentRecipes } from "./recipes.js";

type NativeReceipt = z.infer<typeof nativeDevelopmentSessionReceiptSchema>;
type TerminalSnapshot = z.infer<typeof nativeDevelopmentTerminalSnapshotSchema>;
type PreparedBuild = z.infer<typeof preparedNativeBuildSchema>;

const WORKSPACE_SOURCE_PROTOCOL = "vibestudio.workspace-source.v1";
const TERMINAL_RUN_STATES = new Set<DevelopmentRun["state"]>([
  "succeeded",
  "stopped",
  "failed",
  "cancelled",
]);

export class DevelopmentDO extends DurableObjectBase {
  protected override schemaProductionBaseline() {
    return { version: 1, name: "development-v1" } as const;
  }
  static override rpcMethods = developmentBuiltinMethods;
  private readonly store: DevelopmentStore;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.store = new DevelopmentStore(this.sql, (operation) =>
      this.ctx.storage.transactionSync(operation)
    );
  }

  protected createTables(): void {
    this.store.createTables();
  }

  protected override requiredTables(): readonly string[] {
    return [
      "development_sessions",
      "development_runs",
      "development_run_events",
      "development_mutation_intents",
      "development_test_faults",
    ];
  }

  protected override schemaIndexDefinitions(): readonly string[] {
    return [
      `CREATE UNIQUE INDEX development_session_open_intent
       ON development_sessions(owner_runtime_id,COALESCE(owner_user_id,''),idempotency_key)`,
      `CREATE INDEX development_runs_owner
       ON development_runs(owner_user_id,owner_runtime_id,created_at DESC,run_id ASC)`,
    ];
  }

  @schemaRpc()
  async openSession(input: {
    repositoryId: string;
    mode: "semantic" | "native-tool";
    nativeTool?: "claude-code" | "system-editor";
    idempotencyKey: string;
  }): Promise<
    | { kind: "opened"; session: DevelopmentSession }
    | {
        kind: "repository-not-adopted";
        repositoryId: string;
        contextId: string;
        adoptionAction: "gitInterop.importProject";
      }
  > {
    const owner = this.owner();
    const existing = this.store.findSession(owner, input.idempotencyKey);
    if (existing) {
      if (
        existing.repository.repositoryId !== input.repositoryId ||
        existing.mode !== input.mode ||
        existing.nativeTool !== (input.nativeTool ?? null)
      ) {
        throw coded("EIDEMPOTENCYDRIFT", "Open key was reused with different intent");
      }
      return { kind: "opened", session: existing };
    }
    const parentContextId = await this.rpc.call<string | null>("main", "runtime.resolveContext", [
      owner.runtimeId,
    ]);
    if (!parentContextId) throw coded("ENOENT", "Development caller has no semantic context");
    const parentRepository = await this.resolveRepository(parentContextId, input.repositoryId);
    if (!parentRepository) {
      return {
        kind: "repository-not-adopted",
        repositoryId: input.repositoryId,
        contextId: parentContextId,
        adoptionAction: "gitInterop.importProject",
      };
    }
    const sessionId = developmentSessionId(this.ownerKey(), input.idempotencyKey);
    const targetContextId = `ctx-development-${createHash("sha256")
      .update(sessionId)
      .digest("hex")
      .slice(0, 32)}`;
    const context = await this.rpc.call<{
      contextId: string;
      parentContextId: string;
      parentWorkingHead: DevelopmentSession["basis"]["parentWorkingHead"];
      childBaseState: DevelopmentSession["basis"]["childBaseState"];
    }>("main", "runtime.forkSemanticContext", [
      {
        ownerRuntimeId: owner.runtimeId,
        parentContextId,
        targetContextId,
      },
    ]);
    const childRepository = await this.resolveRepository(context.contextId, input.repositoryId);
    if (!childRepository || childRepository.repoPath !== parentRepository.repoPath) {
      await this.rpc.call("main", "runtime.dropSemanticContext", [
        { contextId: context.contextId },
      ]);
      throw coded(
        "EIDENTITYDRIFT",
        "Repository identity changed while forking development context"
      );
    }
    const at = Date.now();
    let session = developmentSessionSchema.parse({
      sessionId,
      idempotencyKey: input.idempotencyKey,
      state: "opening",
      mode: input.mode,
      nativeTool: input.nativeTool ?? null,
      native: null,
      repository: {
        repositoryId: input.repositoryId,
        repoPath: childRepository.repoPath,
      },
      contextId: context.contextId,
      parentContextId: context.parentContextId,
      basis: {
        parentWorkingHead: context.parentWorkingHead,
        childBaseState: context.childBaseState,
      },
      owner: {
        runtimeId: owner.runtimeId,
        runtimeKind: this.runtimeKind(),
        userId: owner.userId,
      },
      contextEffect: "owned",
      repairAttention: null,
      createdAt: at,
      updatedAt: at,
      primaryDiagnostic: null,
      cleanupDiagnostics: [],
    });
    this.store.putSession(session);
    try {
      if (input.mode === "native-tool") {
        const native = await this.rpc.call<NativeReceipt>("main", "developmentNative.openTool", [
          {
            sessionId,
            developmentContextId: context.contextId,
            repositoryId: input.repositoryId,
            childWorkingHead: context.childBaseState,
            toolId: input.nativeTool!,
            idempotencyKey: input.idempotencyKey,
          },
        ]);
        session = this.updateNative(session, native);
      } else {
        session = this.store.updateSession(sessionId, { state: "ready" });
      }
      return { kind: "opened", session };
    } catch (error) {
      const diagnostic = toDiagnostic(error);
      session = this.store.updateSession(sessionId, {
        state: "requires-repair",
        primaryDiagnostic: diagnostic,
        cleanupDiagnostics: [diagnostic],
        repairAttention: "actionable",
      });
      return { kind: "opened", session };
    }
  }

  @schemaRpc()
  getSession(input: { sessionId: string }): DevelopmentSession | null {
    return this.visibleSession(this.store.getSession(input.sessionId));
  }

  @schemaRpc()
  listSessions(input?: { cursor?: { createdAt: number; sessionId: string }; limit?: number }): {
    sessions: DevelopmentSession[];
    nextCursor: { createdAt: number; sessionId: string } | null;
  } {
    const limit = Math.max(1, Math.min(200, input?.limit ?? 50));
    const ordered = this.store.listSessions(this.owner());
    const remaining = input?.cursor
      ? ordered.filter(
          (session) =>
            session.createdAt < input.cursor!.createdAt ||
            (session.createdAt === input.cursor!.createdAt &&
              session.sessionId > input.cursor!.sessionId)
        )
      : ordered;
    const sessions = remaining.slice(0, limit);
    const last = sessions.at(-1);
    return {
      sessions,
      nextCursor:
        remaining.length > limit && last
          ? { createdAt: last.createdAt, sessionId: last.sessionId }
          : null,
    };
  }

  @schemaRpc()
  async closeSession(input: {
    sessionId: string;
    idempotencyKey: string;
  }): Promise<DevelopmentSession> {
    const session = this.requireSession(input.sessionId);
    this.requireNoActiveRuns(session.sessionId);
    if (session.mode === "native-tool") {
      const native = await this.rpc.call<NativeReceipt>("main", "developmentNative.stopTool", [
        { sessionId: session.sessionId },
      ]);
      this.updateNative(session, native);
    }
    const closing = this.store.beginClose({ ...input, disposition: "retain-context" });
    if (closing.state === "closed") return closing;
    return this.store.updateSession(session.sessionId, {
      state: "closed",
      contextEffect: "retained",
      primaryDiagnostic: null,
      cleanupDiagnostics: [],
      repairAttention: null,
    });
  }

  @schemaRpc()
  async destroySession(input: {
    sessionId: string;
    idempotencyKey: string;
  }): Promise<DevelopmentSession> {
    const session = this.requireSession(input.sessionId);
    this.requireNoActiveRuns(session.sessionId);
    this.store.beginClose({ ...input, disposition: "destroy-context" });
    return this.retireSessionEffects(session);
  }

  @schemaRpc()
  async retrySessionCleanup(input: {
    sessionId: string;
    idempotencyKey: string;
  }): Promise<DevelopmentSession> {
    const session = this.requireSession(input.sessionId);
    this.store.recordSessionRepairIntent({ ...input, action: "retry" });
    this.requireNoActiveRuns(session.sessionId);
    if (session.state !== "requires-repair") return session;
    return this.retireSessionEffects(session);
  }

  @schemaRpc()
  async keepSessionRepair(input: {
    sessionId: string;
    idempotencyKey: string;
  }): Promise<DevelopmentSession> {
    const session = this.requireSession(input.sessionId);
    this.store.recordSessionRepairIntent({ ...input, action: "keep" });
    if (session.mode === "native-tool") {
      const native = await this.rpc.call<NativeReceipt>("main", "developmentNative.keepTool", [
        { sessionId: session.sessionId },
      ]);
      return this.updateNative(session, native);
    }
    return session.state === "requires-repair"
      ? this.store.updateSession(session.sessionId, { repairAttention: "kept" })
      : session;
  }

  @schemaRpc()
  async forceRetireSession(input: {
    sessionId: string;
    idempotencyKey: string;
  }): Promise<DevelopmentSession> {
    const session = this.requireSession(input.sessionId);
    this.store.recordSessionRepairIntent({ ...input, action: "force-retire" });
    this.requireNoActiveRuns(session.sessionId);
    return this.retireSessionEffects(session);
  }

  @schemaRpc()
  async listRecipes(): Promise<ReturnType<typeof developmentRecipes>> {
    const host = await this.rpc.call<{ platform: string; arch: string }>(
      "main",
      "developmentNative.describeHost",
      []
    );
    return developmentRecipes(host.platform, host.arch);
  }

  @schemaRpc()
  async listClientExecutors() {
    return this.rpc.call("main", "developmentNative.listClientExecutors", []);
  }

  @schemaRpc()
  async listNativeTools(): Promise<
    Array<{
      toolId: "claude-code" | "system-editor";
      executorId: string | null;
      available: boolean;
      unavailableReason: string | null;
      interactiveTerminal: boolean;
    }>
  > {
    return Promise.all(
      (["claude-code", "system-editor"] as const).map(async (toolId) => {
        const tool = await this.rpc.call<{
          toolId: typeof toolId;
          executorId: string;
          available: boolean;
          unavailableReason?: string;
          interactiveTerminal: boolean;
        }>("main", "developmentNative.describeTool", [toolId]);
        return {
          ...tool,
          executorId: tool.executorId ?? null,
          unavailableReason: tool.unavailableReason ?? null,
        };
      })
    );
  }

  @schemaRpc()
  async start(input: {
    sessionId: string;
    runId: string;
    recipeId: string;
    target: DevelopmentRun["target"];
  }): Promise<DevelopmentRun> {
    const session = this.requireSession(input.sessionId);
    if (session.state !== "ready") throw coded("ESTATE", "Development session is not ready");
    const existing = this.store.getRun(input.runId);
    if (existing) {
      this.assertRunIntent(existing, input);
      return this.reconcileRun(existing);
    }
    const recipe = (await this.listRecipes()).find(
      (candidate) => candidate.recipeId === input.recipeId
    );
    if (!recipe) throw coded("ENOENT", `Unknown reviewed recipe ${input.recipeId}`);
    if (!recipeMatchesTarget(recipe.target, input.target)) {
      throw coded("EIDEMPOTENCYDRIFT", "Selected target does not match the reviewed recipe");
    }
    const plan = await this.rpc.call<PreparedBuild>("main", "developmentNative.prepareBuild", [
      { session, runId: input.runId, recipe, target: input.target },
    ]);
    const at = Date.now();
    let run = developmentRunSchema.parse({
      version: 1,
      runId: input.runId,
      sessionId: session.sessionId,
      ownerRuntimeId: this.owner().runtimeId,
      ownerRuntimeKind: this.runtimeKind(),
      ownerUserId: this.owner().userId,
      attachedHostAuthorityCeiling: null,
      target: input.target,
      recipe: plan.recipe,
      snapshot: plan.snapshot,
      state: "accepted",
      commitPoint: "snapshot-retained",
      artifact: null,
      instance: null,
      hostReadiness: input.target.kind === "isolated-host" ? "starting" : null,
      client: null,
      attachedHost: null,
      repair: null,
      createdAt: at,
      updatedAt: at,
      terminalAt: null,
    });
    run = this.store.putRun(run, plan, this.startIntentDigest(input));
    const injectedFault = this.store.consumeSnapshotFault(run.runId);
    if (injectedFault) {
      const diagnostic = {
        code: "ESYSTEMTEST_INJECTED_BUILD",
        message: `System-test injected build failure ${injectedFault} after the retained exact snapshot`,
        at: Date.now(),
      };
      return this.store.transitionRun({
        runId: run.runId,
        expected: ["accepted"],
        state: "failed",
        terminal: true,
        repair: {
          phase: "after-snapshot-retained",
          primaryError: diagnostic,
          cleanupErrors: [],
          retryable: true,
          attention: "actionable",
          knownEffects: {
            executionRoot: "absent",
            process: "absent",
            artifact: "absent",
          },
        },
        message: diagnostic.message,
      });
    }
    await this.rpc.call("main", "developmentNative.beginBuild", [{ run }]);
    return this.store.transitionRun({
      runId: run.runId,
      expected: ["accepted"],
      state: "materializing",
      message: "Exact native build started",
    });
  }

  @schemaRpc()
  faultFailBuildAfterSnapshotRetained(input: {
    sessionId: string;
    runId: string;
    phase: "after-snapshot-retained";
  }): {
    faultId: string;
    runId: string;
    phase: "after-snapshot-retained";
    armedAt: number;
  } {
    const session = this.requireSession(input.sessionId);
    const existing = this.store.getRun(input.runId);
    if (existing && existing.sessionId !== session.sessionId) {
      throw coded("EIDEMPOTENCYDRIFT", "Fault run id belongs to another session");
    }
    return this.store.armSnapshotFault({
      runId: input.runId,
      sessionId: session.sessionId,
    });
  }

  @schemaRpc()
  async get(input: { runId: string }): Promise<DevelopmentRun | null> {
    const run = this.visibleRun(this.store.getRun(input.runId));
    return run ? this.reconcileRun(run) : null;
  }

  @schemaRpc()
  async list(input?: {
    sessionId?: string;
    state?: DevelopmentRun["state"];
    cursor?: { createdAt: number; runId: string };
    limit?: number;
  }): Promise<{
    runs: DevelopmentRun[];
    nextCursor: { createdAt: number; runId: string } | null;
  }> {
    const reconciled = await Promise.all(
      this.store
        .listRuns({
          owner: this.owner(),
          ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input?.state ? { state: input.state } : {}),
        })
        .map((run) => this.reconcileRun(run))
    );
    const after = input?.cursor
      ? reconciled.filter(
          (run) =>
            run.createdAt < input.cursor!.createdAt ||
            (run.createdAt === input.cursor!.createdAt && run.runId > input.cursor!.runId)
        )
      : reconciled;
    const limit = Math.max(1, Math.min(200, input?.limit ?? 50));
    const runs = after.slice(0, limit);
    const last = runs.at(-1);
    return {
      runs,
      nextCursor:
        after.length > limit && last ? { createdAt: last.createdAt, runId: last.runId } : null,
    };
  }

  @schemaRpc()
  async events(input: {
    runId: string;
    after?: number;
    limit?: number;
  }): Promise<ReturnType<DevelopmentStore["listEvents"]>> {
    const run = this.requireRun(input.runId);
    await this.reconcileRun(run);
    return this.store.listEvents(run.runId, input.after, input.limit);
  }

  @schemaRpc()
  async stop(input: { runId: string; idempotencyKey: string }): Promise<DevelopmentRun> {
    let run = this.requireRun(input.runId);
    this.store.recordRunIntent({
      runId: run.runId,
      operation: "stop",
      idempotencyKey: input.idempotencyKey,
      intent: { runId: run.runId },
    });
    if (TERMINAL_RUN_STATES.has(run.state) || run.state === "requires-repair") return run;
    await this.rpc.call("main", "developmentNative.stopBuild", [
      { runId: run.runId, snapshotDigest: run.snapshot.snapshotDigest },
    ]);
    run = this.store.transitionRun({
      runId: run.runId,
      expected: [run.state],
      state: "stopped",
      terminal: true,
      hostReadiness: run.target.kind === "isolated-host" ? "stopped" : run.hostReadiness,
      message: "Exact native build stopped",
    });
    return run;
  }

  @schemaRpc()
  async retry(input: { runId: string; idempotencyKey: string }): Promise<DevelopmentRun> {
    let run = this.requireRun(input.runId);
    this.store.recordRunIntent({
      runId: run.runId,
      operation: "repair",
      idempotencyKey: input.idempotencyKey,
      intent: { runId: run.runId, action: "retry" },
    });
    if (!run.repair?.retryable) throw coded("ENOTRECOVERABLE", "Run cannot be retried");
    const session = this.requireSession(run.sessionId);
    await this.rpc.call("main", "developmentNative.prepareBuild", [
      { session, runId: run.runId, recipe: run.recipe, target: run.target },
    ]);
    run = this.store.transitionRun({
      runId: run.runId,
      expected: [run.state],
      state: "materializing",
      repair: null,
      message: "Retrying the retained exact snapshot",
    });
    await this.rpc.call("main", "developmentNative.beginBuild", [{ run }]);
    return run;
  }

  @schemaRpc()
  keepRunRepair(input: { runId: string; idempotencyKey: string }): DevelopmentRun {
    const run = this.requireRun(input.runId);
    this.store.recordRunIntent({
      runId: run.runId,
      operation: "repair",
      idempotencyKey: input.idempotencyKey,
      intent: { runId: run.runId, action: "keep" },
    });
    if (!run.repair) return run;
    return this.store.transitionRun({
      runId: run.runId,
      expected: [run.state],
      state: run.state,
      repair: { ...run.repair, attention: "kept" },
      message: "Repair record kept",
    });
  }

  @schemaRpc()
  async forceRetire(input: { runId: string; idempotencyKey: string }): Promise<DevelopmentRun> {
    const run = this.requireRun(input.runId);
    this.store.recordRunIntent({
      runId: run.runId,
      operation: "repair",
      idempotencyKey: input.idempotencyKey,
      intent: { runId: run.runId, action: "force-retire" },
    });
    if (run.repair?.knownEffects.process === "unknown") {
      return this.store.transitionRun({
        runId: run.runId,
        expected: [run.state],
        state: "requires-repair",
        repair: { ...run.repair, attention: "kept" },
        message: "Retirement refused because process ownership is unknown",
      });
    }
    await this.rpc.call("main", "developmentNative.retireBuild", [{ run }]);
    return this.store.transitionRun({
      runId: run.runId,
      expected: [run.state],
      state: "cancelled",
      artifact: null,
      repair: null,
      terminal: true,
      message: "Exact native build root retired",
    });
  }

  @schemaRpc()
  async checkpoint(input: {
    sessionId: string;
    idempotencyKey: string;
  }): Promise<DevelopmentSession> {
    const session = this.requireNativeSession(input.sessionId);
    this.store.updateSession(session.sessionId, { state: "checkpointing" });
    await this.rpc.call("main", "developmentNative.checkpointTool", [input]);
    const native = await this.rpc.call<NativeReceipt>("main", "developmentNative.inspectTool", [
      { sessionId: session.sessionId },
    ]);
    return this.updateNative(session, native);
  }

  @schemaRpc()
  async inspectNative(input: {
    sessionId: string;
    assessPendingChanges?: boolean;
  }): Promise<DevelopmentSession> {
    const session = this.requireNativeSession(input.sessionId);
    const native = await this.rpc.call<NativeReceipt>("main", "developmentNative.inspectTool", [
      input,
    ]);
    return this.updateNative(session, native);
  }

  @schemaRpc()
  async stopNativeTool(input: {
    sessionId: string;
    idempotencyKey: string;
  }): Promise<DevelopmentSession> {
    const session = this.requireNativeSession(input.sessionId);
    this.store.recordSessionRepairIntent({ ...input, action: "stop-native-tool" });
    const native = await this.rpc.call<NativeReceipt>("main", "developmentNative.stopTool", [
      { sessionId: session.sessionId },
    ]);
    return this.updateNative(session, native);
  }

  @schemaRpc()
  readNativeTerminal(input: {
    sessionId: string;
    after?: number;
    maxBytes?: number;
  }): Promise<TerminalSnapshot> {
    const session = this.requireNativeSession(input.sessionId);
    return this.rpc.call("main", "developmentNative.readTerminal", [
      { ...input, sessionId: session.sessionId },
    ]);
  }

  @schemaRpc()
  async writeNativeTerminal(input: {
    sessionId: string;
    writeId: string;
    data: string;
  }): Promise<void> {
    const session = this.requireNativeSession(input.sessionId);
    await this.rpc.call("main", "developmentNative.writeTerminal", [
      { ...input, sessionId: session.sessionId },
    ]);
  }

  @schemaRpc()
  async resizeNativeTerminal(input: {
    sessionId: string;
    columns: number;
    rows: number;
  }): Promise<void> {
    const session = this.requireNativeSession(input.sessionId);
    await this.rpc.call("main", "developmentNative.resizeTerminal", [
      { ...input, sessionId: session.sessionId },
    ]);
  }

  @schemaRpc()
  snapshotExecutionRoots(): Array<{
    owner: "development-run";
    ownerId: string;
    reason: "retained-result";
    artifact: NonNullable<DevelopmentRun["artifact"]>;
  }> {
    return this.store
      .listRuns({})
      .filter(
        (run): run is DevelopmentRun & { artifact: NonNullable<DevelopmentRun["artifact"]> } =>
          run.artifact !== null
      )
      .map((run) => ({
        owner: "development-run" as const,
        ownerId: run.runId,
        reason: "retained-result" as const,
        artifact: run.artifact,
      }));
  }

  @schemaRpc()
  nativeRunEvent(input: {
    kind: "attached-route-lost";
    runId: string;
    sessionId: string;
    childGenerationId: string;
  }): void {
    const run = this.store.getRun(input.runId);
    if (
      !run?.attachedHost ||
      run.attachedHost.sessionId !== input.sessionId ||
      run.attachedHost.childGenerationId !== input.childGenerationId
    ) {
      return;
    }
    this.store.transitionRun({
      runId: run.runId,
      expected: [run.state],
      state: run.state,
      attachedHost: {
        ...run.attachedHost,
        state: "route-lost",
        routeLostAt: Date.now(),
      },
      message: "Attached child route was lost",
    });
  }

  private async reconcileRun(run: DevelopmentRun): Promise<DevelopmentRun> {
    if (TERMINAL_RUN_STATES.has(run.state) || run.state === "requires-repair") return run;
    let status:
      | {
          state: "running";
          artifact: DevelopmentRun["artifact"];
          instance: DevelopmentRun["instance"];
          hostReadiness: DevelopmentRun["hostReadiness"];
          client: DevelopmentRun["client"];
          attachedHost: DevelopmentRun["attachedHost"];
          phases: Array<"installing" | "building">;
          logs: Array<{ stream: "stdout" | "stderr"; line: string }>;
        }
      | {
          state: "succeeded";
          artifact: NonNullable<DevelopmentRun["artifact"]>;
          phases: Array<"installing" | "building">;
          logs: Array<{ stream: "stdout" | "stderr"; line: string }>;
          instance: DevelopmentRun["instance"];
          hostReadiness: DevelopmentRun["hostReadiness"];
          client: DevelopmentRun["client"];
          attachedHost: DevelopmentRun["attachedHost"];
        }
      | {
          state: "ready";
          artifact: NonNullable<DevelopmentRun["artifact"]>;
          instance: DevelopmentRun["instance"];
          hostReadiness: DevelopmentRun["hostReadiness"];
          client: DevelopmentRun["client"];
          attachedHost: DevelopmentRun["attachedHost"];
          phases: Array<"installing" | "building">;
          logs: Array<{ stream: "stdout" | "stderr"; line: string }>;
        }
      | {
          state: "failed";
          error: string;
          artifact: DevelopmentRun["artifact"];
          instance: DevelopmentRun["instance"];
          hostReadiness: DevelopmentRun["hostReadiness"];
          client: DevelopmentRun["client"];
          attachedHost: DevelopmentRun["attachedHost"];
          phases: Array<"installing" | "building">;
          logs: Array<{ stream: "stdout" | "stderr"; line: string }>;
        };
    try {
      status = await this.rpc.call("main", "developmentNative.inspectBuild", [
        { runId: run.runId, snapshotDigest: run.snapshot.snapshotDigest },
      ]);
    } catch (error) {
      const diagnostic = toDiagnostic(error);
      return this.store.transitionRun({
        runId: run.runId,
        expected: [run.state],
        state: "requires-repair",
        repair: {
          phase: "native-handle-recovery",
          primaryError: diagnostic,
          cleanupErrors: [],
          retryable: true,
          attention: "actionable",
          knownEffects: {
            executionRoot: "owned",
            process: "unknown",
            artifact: run.artifact ? "retained" : "absent",
          },
        },
        message: diagnostic.message,
      });
    }
    for (const log of status.logs) this.store.appendEvent(run.runId, "log", log);
    const phase = status.phases.at(-1);
    if (status.state === "running" && phase && run.state !== phase) {
      run = this.store.transitionRun({
        runId: run.runId,
        expected: [run.state],
        state: phase,
        message: phase === "building" ? "Building host artifacts" : "Installing dependencies",
      });
    }
    if (status.state === "running") {
      if (status.artifact && !run.artifact) {
        run = this.store.transitionRun({
          runId: run.runId,
          expected: [run.state],
          state: "starting",
          artifact: status.artifact,
          commitPoint: "artifacts-verified",
          instance: status.instance ?? undefined,
          hostReadiness: status.hostReadiness,
          client: status.client,
          attachedHost: status.attachedHost,
          message: "Exact artifacts verified; reviewed target is starting",
        });
      }
      return run;
    }
    if (status.state === "failed") {
      const diagnostic = toDiagnostic(new Error(status.error));
      return this.store.transitionRun({
        runId: run.runId,
        expected: [run.state],
        state: "failed",
        artifact: status.artifact ?? run.artifact,
        instance: status.instance ?? undefined,
        hostReadiness: status.hostReadiness,
        client: status.client,
        attachedHost: status.attachedHost,
        terminal: true,
        repair: {
          phase: run.state,
          primaryError: diagnostic,
          cleanupErrors: [],
          retryable: true,
          attention: "actionable",
          knownEffects: {
            executionRoot: "owned",
            process: "absent",
            artifact: "absent",
          },
        },
        message: diagnostic.message,
      });
    }
    if (status.state === "ready") {
      return this.store.transitionRun({
        runId: run.runId,
        expected: [run.state],
        state: "ready",
        artifact: status.artifact,
        instance: status.instance ?? undefined,
        hostReadiness: status.hostReadiness,
        client: status.client,
        attachedHost: status.attachedHost,
        commitPoint: "ready",
        repair: null,
        message: "Reviewed development target is ready",
      });
    }
    return this.store.transitionRun({
      runId: run.runId,
      expected: [run.state],
      state: "succeeded",
      artifact: status.artifact,
      commitPoint: "artifacts-verified",
      terminal: true,
      message: "Exact build artifacts verified",
    });
  }

  private async resolveRepository(
    contextId: string,
    repositoryId: string
  ): Promise<{
    repoPath: string;
    sourceState: DevelopmentSession["basis"]["parentWorkingHead"];
  } | null> {
    const workspaceSource = await this.resolveWorkspaceSource();
    const status = await this.callSemanticRead<VcsStatusResult>(workspaceSource, "vcsStatus", {
      contextId,
    });
    try {
      const inspected = await this.callSemanticRead<VcsInspectResult>(
        workspaceSource,
        "vcsInspect",
        {
          node: { kind: "repository", state: status.workingHead, repositoryId },
          edgeLimit: 1,
        }
      );
      if (inspected.node.kind !== "repository" || inspected.node.value.kind !== "present") {
        return null;
      }
      return { repoPath: inspected.node.value.repoPath, sourceState: status.workingHead };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "errorData" in error &&
        (error as { errorData?: { code?: unknown } }).errorData?.code === "InvalidReference"
      ) {
        return null;
      }
      throw error;
    }
  }

  private async callSemanticRead<T>(
    workspaceSource: string,
    method: "vcsStatus" | "vcsInspect",
    input: unknown
  ): Promise<T> {
    const outcome = await this.rpc.call<
      | { kind: "complete"; result: T }
      | { kind: "effects-pending"; effects: readonly unknown[] }
      | { kind: "host-read"; request: unknown }
    >(workspaceSource, method, [this.semanticRequest(input)]);
    if (outcome.kind !== "complete") {
      throw coded("ESEMANTICREAD", `Development ${method} unexpectedly required ${outcome.kind}`);
    }
    return outcome.result;
  }

  private semanticRequest(input: unknown) {
    const integrity = this.authorization?.contextIntegrity;
    if (!integrity) {
      throw coded("EACCES", "Development semantic reads require host-attested context integrity");
    }
    return {
      input,
      ingress: {
        causalParent: null,
        contextIntegrity:
          integrity.class === "external"
            ? { class: "external" as const, externalKeys: [...integrity.externalKeys] }
            : { class: "internal" as const, externalKeys: [] },
      },
    };
  }

  private async resolveWorkspaceSource(): Promise<string> {
    const resolved = await this.rpc.call<{
      kind: "durable-object" | "worker";
      targetId?: string;
    }>("main", "workers.resolveService", [WORKSPACE_SOURCE_PROTOCOL]);
    if (resolved.kind !== "durable-object" || !resolved.targetId) {
      throw new Error(
        `Workspace protocol ${WORKSPACE_SOURCE_PROTOCOL} must resolve to a Durable Object`
      );
    }
    return resolved.targetId;
  }

  private async retireSessionEffects(session: DevelopmentSession): Promise<DevelopmentSession> {
    const cleanup: string[] = [];
    if (session.mode === "native-tool") {
      const retired = await this.rpc.call<{ retired: boolean; cleanupErrors: string[] }>(
        "main",
        "developmentNative.retireTool",
        [{ sessionId: session.sessionId }]
      );
      cleanup.push(...retired.cleanupErrors);
    }
    try {
      await this.rpc.call("main", "runtime.dropSemanticContext", [
        { contextId: session.contextId },
      ]);
    } catch (error) {
      cleanup.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanup.length === 0) {
      return this.store.updateSession(session.sessionId, {
        state: "closed",
        contextEffect: "absent",
        primaryDiagnostic: null,
        cleanupDiagnostics: [],
        repairAttention: null,
      });
    }
    const diagnostics = cleanup.map((message) => toDiagnostic(new Error(message)));
    return this.store.updateSession(session.sessionId, {
      state: "requires-repair",
      contextEffect: "unknown",
      primaryDiagnostic: diagnostics[0]!,
      cleanupDiagnostics: diagnostics,
      repairAttention: "actionable",
    });
  }

  private updateNative(session: DevelopmentSession, native: NativeReceipt): DevelopmentSession {
    return this.store.updateSession(session.sessionId, {
      state:
        native.state === "requires-repair"
          ? "requires-repair"
          : native.state === "checkpointing"
            ? "checkpointing"
            : session.state === "closed"
              ? "closed"
              : "ready",
      native: {
        ownedRootId: native.ownedRootId,
        executorId: native.executorId,
        toolId: native.toolId,
        repoPath: native.repoPath,
        baseEvent: native.baseEvent,
        baseSnapshotRevision: native.baseSnapshotRevision,
        state: native.state,
        process: native.process,
        lastCheckpoint: native.lastCheckpoint,
        pendingChanges: native.pendingChanges,
        repair: native.repair,
      },
      primaryDiagnostic: native.repair ? toDiagnostic(new Error(native.repair.primaryError)) : null,
      cleanupDiagnostics:
        native.repair?.cleanupErrors.map((message) => toDiagnostic(new Error(message))) ?? [],
      repairAttention: native.repair?.attention ?? null,
    });
  }

  private requireNoActiveRuns(sessionId: string): void {
    const count = this.store.activeRunCount(sessionId);
    if (count > 0) throw coded("EACTIVE_RUNS", `Session still has ${count} active run(s)`);
  }

  private requireSession(sessionId: string): DevelopmentSession {
    const session = this.visibleSession(this.store.getSession(sessionId));
    if (!session) throw coded("ENOENT", "Unknown development session");
    return session;
  }

  private requireNativeSession(sessionId: string): DevelopmentSession {
    const session = this.requireSession(sessionId);
    if (session.mode !== "native-tool" || !session.nativeTool) {
      throw coded("ESTATE", "Development session is not a native-tool session");
    }
    return session;
  }

  private requireRun(runId: string): DevelopmentRun {
    const run = this.visibleRun(this.store.getRun(runId));
    if (!run) throw coded("ENOENT", "Unknown development run");
    return run;
  }

  private visibleSession(session: DevelopmentSession | null): DevelopmentSession | null {
    if (!session) return null;
    const owner = this.owner();
    return session.owner.userId
      ? session.owner.userId === owner.userId
        ? session
        : null
      : session.owner.runtimeId === owner.runtimeId
        ? session
        : null;
  }

  private visibleRun(run: DevelopmentRun | null): DevelopmentRun | null {
    if (!run) return null;
    const owner = this.owner();
    return run.ownerUserId
      ? run.ownerUserId === owner.userId
        ? run
        : null
      : run.ownerRuntimeId === owner.runtimeId
        ? run
        : null;
  }

  private owner(): { runtimeId: string; userId: string | null } {
    const caller = this.caller;
    if (!caller) throw coded("EACCES", "Development requires an authenticated caller");
    return { runtimeId: caller.callerId, userId: caller.userId ?? null };
  }

  private ownerKey(): string {
    const owner = this.owner();
    return owner.userId ? `user:${owner.userId}` : `runtime:${owner.runtimeId}`;
  }

  private runtimeKind(): DevelopmentRun["ownerRuntimeKind"] {
    const kind = this.caller?.callerKind;
    return ["panel", "app", "worker", "do", "extension", "shell", "server", "agent"].includes(
      String(kind)
    )
      ? (kind as DevelopmentRun["ownerRuntimeKind"])
      : "do";
  }

  private startIntentDigest(input: unknown): string {
    return createHash("sha256")
      .update(canonicalJson({ ownerKey: this.ownerKey(), input }))
      .digest("hex");
  }

  private assertRunIntent(
    run: DevelopmentRun,
    input: {
      sessionId: string;
      runId: string;
      recipeId: string;
      target: DevelopmentRun["target"];
    }
  ): void {
    if (
      run.sessionId !== input.sessionId ||
      run.recipe.recipeId !== input.recipeId ||
      canonicalJson(run.target) !== canonicalJson(input.target)
    ) {
      throw coded("EIDEMPOTENCYDRIFT", "Run id was reused with different intent");
    }
  }
}

function recipeMatchesTarget(
  recipe: DevelopmentRun["recipe"]["target"],
  target: DevelopmentRun["target"]
): boolean {
  return (
    recipe.kind === target.kind &&
    (recipe.kind === "build-only" ||
      (recipe.kind === "client-device" && target.kind === "client-device") ||
      (recipe.kind === "isolated-host" &&
        target.kind === "isolated-host" &&
        recipe.includeClient === target.includeClient))
  );
}

function toDiagnostic(error: unknown): { code: string; message: string; at: number } {
  return {
    code:
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : "EDEVELOPMENT",
    message: error instanceof Error ? error.message : String(error),
    at: Date.now(),
  };
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
