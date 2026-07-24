import type { VcsClient } from "@workspace/runtime";
import { sha256HexSyncText } from "@vibestudio/content-addressing";
import { serializeSystemTestError } from "./structured-error.js";

type FixtureVcs = Pick<
  VcsClient,
  "status" | "inspect" | "neighbors" | "history" | "importSnapshot" | "revert" | "commit" | "push"
>;

interface FixtureBlobstore {
  putText(text: string): Promise<{ digest: string; size: number }>;
}

export type WorkspaceRepoSection = "projects" | "packages" | "workers" | "panels";

/**
 * A repository fixture either seeds one exact source repository, asks the task
 * to create the only repository in a declared section, or seeds a panel and
 * asks the task to create exactly one derived panel repository from it.
 *
 * Creation scopes deliberately do not reserve a basename. Their repository
 * identity is derived from repository-create changes on the task context's
 * first-parent line after the task has run.
 */
export type WorkspaceRepoCreationScope =
  | { kind: "content"; section: "projects" }
  | { kind: "buildable-package"; section: "packages" }
  | { kind: "buildable-worker"; section: "workers" }
  | { kind: "buildable-regular-worker"; section: "workers" }
  | { kind: "created-repository"; section: WorkspaceRepoSection }
  | { kind: "buildable-panel-with-derived"; section: "panels" };

/** Compatibility name used by TestCase.workspaceRepoFixture. */
export type WorkspaceRepoFixtureSpec = WorkspaceRepoCreationScope;

export interface WorkspaceRepoFixturePort {
  vcs: FixtureVcs;
  blobstore: FixtureBlobstore;
  createContext(input?: {
    /**
     * Exact repositories proved to have been created by this fixture's task
     * lineage. A system-test host may use these identities to preauthorize the
     * otherwise-critical deletion performed by the cleanup counteraction.
     */
    counteractionRepoPaths?: string[];
  }): Promise<{ contextId: string }>;
  destroyContext(contextId: string): Promise<void>;
}

export interface WorkspaceRepoFixtureRepository {
  repositoryId: string;
  repoPath: string;
}

type WorkspaceRepoFixtureStateBase = {
  testName: string;
  contextId: string;
  taskBaseEventId: string;
};

export type WorkspaceRepoFixtureState =
  | (Extract<WorkspaceRepoFixtureSpec, { kind: "created-repository" }> &
      WorkspaceRepoFixtureStateBase & {
        repoName: null;
        repositoryId: null;
        repoPath: null;
        seedFilePaths: [];
        importWorkUnitId: null;
        importChangeIds: [];
      })
  | (Exclude<WorkspaceRepoFixtureSpec, { kind: "created-repository" }> &
      WorkspaceRepoFixtureStateBase & {
        repoName: string;
        repositoryId: string;
        repoPath: string;
        seedFilePaths: string[];
        importWorkUnitId: string;
        importChangeIds: string[];
      });

export interface WorkspaceRepoFixtureCleanup {
  publishedFixtureRemoved: WorkspaceRepoFixtureRepository | null;
  unexpectedPublishedRepositoriesRemoved: WorkspaceRepoFixtureRepository[];
  counteractedChangeIds: string[];
}

interface FixtureTaskEvent {
  eventId: string;
  applicationIds: string[];
}

interface FixtureTaskWork {
  workUnitId: string;
  changeIds: string[];
}

interface TaskCreatedRepository {
  repositoryId: string;
  repoPath: string;
}

/**
 * Owns one exact repository creation scope in one fresh semantic context.
 *
 * Seeded variants import their source snapshot through the same public
 * operations as an agent; task-created variants start with no repository.
 * There is no fixture-only repository API, moving-main reconciler, or
 * ownership registry.
 * If the test publishes, teardown finds the newest task event reachable from
 * current main, counteracts that exact published work in reverse causal order,
 * then commits and pushes once. Newer local work disappears with the task
 * context. If no task event reached main, destroying that context is the whole
 * cleanup.
 */
export class WorkspaceRepoFixtureLifecycle {
  private contextId: string | null = null;

  constructor(
    private readonly port: WorkspaceRepoFixturePort,
    private readonly testName: string,
    private readonly repoName: string | null,
    private readonly fixture: WorkspaceRepoFixtureSpec
  ) {}

  get taskContextId(): string | null {
    return this.contextId;
  }

  async prepare(): Promise<WorkspaceRepoFixtureState> {
    if (this.contextId) {
      throw new Error(`Workspace repository fixture ${this.repoName} was prepared twice`);
    }

    const { contextId } = await this.port.createContext();
    this.contextId = contextId;
    const repoPath = this.repoName ? `${this.fixture.section}/${this.repoName}` : null;
    try {
      const status = await this.port.vcs.status({ contextId });
      if (!status.clean || status.mainRelation !== "at") {
        throw new Error(
          `Fresh fixture context must start clean at main; clean=${status.clean} relation=${status.mainRelation}`
        );
      }
      if (status.committed.kind !== "event") {
        throw new Error("Fresh fixture context did not start at a committed event");
      }
      if (this.fixture.kind === "created-repository") {
        return {
          ...this.fixture,
          testName: this.testName,
          contextId,
          repoName: null,
          repositoryId: null,
          repoPath: null,
          seedFilePaths: [],
          importWorkUnitId: null,
          importChangeIds: [],
          taskBaseEventId: status.committed.eventId,
        };
      }
      if (!this.repoName || !repoPath) {
        throw new Error(`Seeded workspace repository fixture ${this.testName} has no basename`);
      }
      const seedFiles = repositorySeedFiles(this.repoName, this.fixture).sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      );
      const files = await Promise.all(
        seedFiles.map(async (file) => {
          const stored = await this.port.blobstore.putText(file.content);
          return {
            path: file.path,
            contentHash: stored.digest,
            mode: 0o644,
          };
        })
      );
      const snapshotRevision = `fixture:${sha256HexSyncText(JSON.stringify({ repoPath, files }))}`;
      const importCommandId = this.command("import");
      const source = {
        kind: "generated" as const,
        uri: `system-test://${this.testName}/${this.repoName}`,
        snapshotRevision,
      };
      const imported = await this.port.vcs.importSnapshot({
        contextId,
        commandId: importCommandId,
        expectedWorkingHead: status.workingHead,
        intentSummary: `Create disposable system-test fixture ${repoPath}`,
        source,
        repositories: [{ repoPath, files }],
        message: `Create disposable system-test fixture ${repoPath}`,
      });
      const repositoryId = imported.importedRepositoryIds[0];
      if (!repositoryId || imported.importedRepositoryIds.length !== 1) {
        throw new Error("Fixture import did not return exactly one repository identity");
      }
      const work = await this.port.vcs.inspect({
        node: { kind: "work-unit", workUnitId: imported.workUnitId },
        edgeLimit: 1,
      });
      if (work.node.kind !== "work-unit" || work.node.value.authoredChangeIds.length === 0) {
        throw new Error("Fixture import did not expose its authored semantic changes");
      }
      const recordedSnapshot = work.node.value.externalSnapshot;
      if (
        work.node.value.kind !== "import" ||
        work.node.value.commandId !== importCommandId ||
        !recordedSnapshot ||
        recordedSnapshot.sourceKind !== source.kind ||
        recordedSnapshot.sourceUri !== source.uri ||
        recordedSnapshot.snapshotRevision !== source.snapshotRevision ||
        recordedSnapshot.targetRepositoryIds.length !== 1 ||
        recordedSnapshot.targetRepositoryIds[0] !== repositoryId
      ) {
        throw new Error("Fixture import did not record its exact command and source snapshot");
      }
      return {
        ...this.fixture,
        testName: this.testName,
        contextId,
        repoName: this.repoName,
        repositoryId,
        repoPath,
        seedFilePaths: files.map(({ path }) => path),
        importWorkUnitId: imported.workUnitId,
        importChangeIds: work.node.value.authoredChangeIds,
        taskBaseEventId: status.committed.eventId,
      };
    } catch (setupError) {
      this.contextId = null;
      try {
        await this.port.destroyContext(contextId);
      } catch (cleanupError) {
        throw Object.assign(
          new AggregateError(
            [setupError, cleanupError],
            `Workspace fixture setup and context cleanup both failed for ${repoPath ?? `${this.fixture.section}/<task-created>`}`
          ),
          {
            code: "WorkspaceRepoFixtureRecoveryFailed",
            errorData: {
              code: "WorkspaceRepoFixtureRecoveryFailed",
              repoPath: repoPath ?? `${this.fixture.section}/<task-created>`,
              setup: serializeSystemTestError(setupError),
              cleanup: serializeSystemTestError(cleanupError),
            },
          }
        );
      }
      throw setupError;
    }
  }

  async cleanup(
    state: WorkspaceRepoFixtureState,
    onPhase?: (phase: string) => void
  ): Promise<WorkspaceRepoFixtureCleanup> {
    if (this.contextId !== state.contextId) {
      throw new Error(
        `Workspace repository fixture context changed from ${state.contextId} to ${this.contextId ?? "none"}`
      );
    }

    let publishedFixtureRemoved: WorkspaceRepoFixtureRepository | null = null;
    let unexpectedPublishedRepositoriesRemoved: WorkspaceRepoFixtureRepository[] = [];
    let counteractedChangeIds: string[] = [];
    let cleanupError: unknown;
    let creationScopeError: Error | null = null;
    let cleanupContextId: string | null = null;
    try {
      onPhase?.("task-status");
      const taskStatus = await this.port.vcs.status({ contextId: state.contextId });
      if (taskStatus.committed.kind !== "event") {
        throw new Error("Workspace fixture task context has no committed event for attribution");
      }
      onPhase?.("task-first-parent-events");
      const taskEvents = await this.taskFirstParentEvents(state, taskStatus.committed.eventId);
      const needsCreationScope =
        state.kind === "created-repository" || state.kind === "buildable-panel-with-derived";
      const scopedTaskChanges = needsCreationScope
        ? await this.inspectTaskChanges(await this.taskWorkNewestFirst(taskEvents))
        : null;
      onPhase?.("task-creation-scope");
      const creationScope = this.resolveCreationScope(
        state,
        scopedTaskChanges?.createdRepositories ?? []
      );
      creationScopeError = creationScope.error;
      onPhase?.("published-boundary");
      const publishedBoundary =
        taskEvents.length === 0
          ? state.taskBaseEventId
          : await this.newestPublishedTaskEvent(state, taskEvents, taskStatus.mainEventId);
      if (publishedBoundary !== state.taskBaseEventId) {
        const taskChanges =
          scopedTaskChanges ??
          (await this.inspectTaskChanges(await this.taskWorkNewestFirst(taskEvents)));
        onPhase?.("cleanup-context-create");
        cleanupContextId = (
          await this.port.createContext({
            counteractionRepoPaths: taskChanges.createdRepositories.map(({ repoPath }) => repoPath),
          })
        ).contextId;
        onPhase?.("cleanup-context-status");
        const cleanupStatus = await this.port.vcs.status({ contextId: cleanupContextId });
        if (
          !cleanupStatus.clean ||
          cleanupStatus.mainRelation !== "at" ||
          cleanupStatus.committed.kind !== "event"
        ) {
          throw new Error(
            `Fresh cleanup context must start clean at main; clean=${cleanupStatus.clean} relation=${cleanupStatus.mainRelation}`
          );
        }
        const currentBoundary = await this.newestPublishedTaskEvent(
          state,
          taskEvents,
          cleanupStatus.mainEventId
        );
        onPhase?.("published-work");
        const publishedEvents = this.eventsThroughBoundary(taskEvents, currentBoundary);
        const publishedWork = await this.taskWorkNewestFirst(publishedEvents);
        if (state.importWorkUnitId) {
          const publishedImport = publishedWork.find(
            (work) => work.workUnitId === state.importWorkUnitId
          );
          if (
            !publishedImport ||
            state.importChangeIds.some((changeId) => !publishedImport.changeIds.includes(changeId))
          ) {
            throw new Error(
              `Published fixture lineage does not contain exact import work ${state.importWorkUnitId}`
            );
          }
        }
        onPhase?.("published-changes");
        const publishedChanges = await this.inspectTaskChanges(publishedWork);
        const mainState = cleanupStatus.committed;
        if (creationScope.primaryRepositoryId) {
          publishedFixtureRemoved = await this.inspectPresentRepository(
            mainState,
            creationScope.primaryRepositoryId
          );
        }
        for (const { repositoryId } of publishedChanges.createdRepositories) {
          if (creationScope.ownedRepositoryIds.has(repositoryId)) continue;
          const repository = await this.inspectPresentRepository(mainState, repositoryId);
          if (repository) unexpectedPublishedRepositoriesRemoved.push(repository);
        }
        unexpectedPublishedRepositoriesRemoved.sort(
          (left, right) =>
            left.repoPath.localeCompare(right.repoPath) ||
            left.repositoryId.localeCompare(right.repositoryId)
        );
        onPhase?.("counteract-published-work");
        counteractedChangeIds = await this.counteractPublishedTaskWork(
          state,
          cleanupContextId,
          cleanupStatus,
          publishedWork,
          onPhase
        );
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      if (cleanupContextId) {
        try {
          onPhase?.("destroy-cleanup-context");
          await this.port.destroyContext(cleanupContextId);
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError(
                [cleanupError, error],
                "Fixture cleanup and cleanup-context teardown failed"
              )
            : error;
        }
      }
    }

    this.contextId = null;
    try {
      onPhase?.("destroy-task-context");
      await this.port.destroyContext(state.contextId);
    } catch (error) {
      cleanupError = cleanupError
        ? new AggregateError(
            [cleanupError, error],
            "Fixture teardown and task-context cleanup failed"
          )
        : error;
    }
    if (creationScopeError) {
      cleanupError = cleanupError
        ? new AggregateError(
            [creationScopeError, cleanupError],
            "Repository creation scope validation and fixture teardown both failed"
          )
        : creationScopeError;
    }
    if (cleanupError) throw cleanupError;
    return {
      publishedFixtureRemoved,
      unexpectedPublishedRepositoriesRemoved,
      counteractedChangeIds,
    };
  }

  private async counteractPublishedTaskWork(
    state: WorkspaceRepoFixtureState,
    cleanupContextId: string,
    status: Awaited<ReturnType<FixtureVcs["status"]>>,
    publishedWork: FixtureTaskWork[],
    onPhase?: (phase: string) => void
  ): Promise<string[]> {
    let workingHead = status.workingHead;
    const counteractedChangeIds: string[] = [];
    const counteracted = new Set<string>();
    const revertDependencyClosure = async (
      requestedChangeIds: string[],
      blockerAncestry = new Set<string>()
    ): Promise<void> => {
      const changeIds = [...new Set(requestedChangeIds)].filter(
        (changeId) => !counteracted.has(changeId)
      );
      if (changeIds.length === 0) return;
      try {
        onPhase?.("counteract-revert");
        const reverted = await this.port.vcs.revert({
          contextId: cleanupContextId,
          commandId: this.command("revert-work"),
          expectedWorkingHead: workingHead,
          changeIds,
          intentSummary: `Remove published system-test work from ${this.scopeLabel(state)}`,
        });
        workingHead = reverted.workingHead;
        for (const changeId of changeIds) {
          counteracted.add(changeId);
          counteractedChangeIds.push(changeId);
        }
      } catch (error) {
        const blockers = dependencyBlockingChangeIds(error);
        if (blockers === null) throw error;
        if (blockers.length === 0) {
          throw new Error("DependencyBlocked did not provide any blocking change identities");
        }
        const cycle = blockers.find((changeId) => blockerAncestry.has(changeId));
        if (cycle) {
          throw new Error(`Workspace fixture cleanup dependency cycle reached ${cycle}`);
        }
        const before = counteracted.size;
        await revertDependencyClosure(blockers, new Set([...blockerAncestry, ...blockers]));
        if (counteracted.size === before) {
          throw new Error("Workspace fixture cleanup dependency closure made no progress");
        }
        await revertDependencyClosure(changeIds, blockerAncestry);
      }
    };

    for (const work of publishedWork) {
      await revertDependencyClosure(work.changeIds);
    }
    if (counteractedChangeIds.length === 0) return [];
    onPhase?.("counteract-commit");
    const committed = await this.port.vcs.commit({
      contextId: cleanupContextId,
      commandId: this.command("commit-removal"),
      expectedWorkingHead: workingHead,
      message: `Remove published system-test work from ${this.scopeLabel(state)}`,
    });
    if (committed.event.kind !== "event") {
      throw new Error("Fixture cleanup commit did not return an event");
    }
    onPhase?.("counteract-push");
    await this.port.vcs.push({
      contextId: cleanupContextId,
      commandId: this.command("push-removal"),
      expectedCommittedEventId: committed.event.eventId,
      expectedMainEventId: status.mainEventId,
    });
    return counteractedChangeIds;
  }

  private async inspectPresentRepository(
    state: Awaited<ReturnType<FixtureVcs["status"]>>["committed"],
    repositoryId: string
  ): Promise<WorkspaceRepoFixtureRepository | null> {
    let inspected;
    try {
      inspected = await this.port.vcs.inspect({
        node: { kind: "repository", state, repositoryId },
        edgeLimit: 1,
      });
    } catch (error) {
      if (semanticErrorCode(error) === "InvalidReference") return null;
      throw error;
    }
    if (inspected.node.kind !== "repository" || inspected.node.value.kind !== "present") {
      return null;
    }
    return {
      repositoryId: inspected.node.value.repositoryId,
      repoPath: inspected.node.value.repoPath,
    };
  }

  /** Follow only the task context's first-parent line. Integration parents are
   * deliberately excluded: their work was authored by concurrent publishers,
   * not this test. */
  private async taskFirstParentEvents(
    state: WorkspaceRepoFixtureState,
    committedEventId: string
  ): Promise<FixtureTaskEvent[]> {
    const events: FixtureTaskEvent[] = [];
    const visited = new Set<string>();
    let eventId = committedEventId;
    while (eventId !== state.taskBaseEventId) {
      if (visited.has(eventId))
        throw new Error("Workspace fixture event ancestry contains a cycle");
      visited.add(eventId);
      const event = await this.port.vcs.inspect({
        node: { kind: "event", eventId },
        edgeLimit: 1,
      });
      if (event.node.kind !== "event") {
        throw new Error(`Workspace fixture could not inspect event ${eventId}`);
      }
      events.push({
        eventId,
        applicationIds: [...event.node.value.applicationIds],
      });
      const parentEventId = event.node.value.parentEventIds[0];
      if (!parentEventId) {
        throw new Error(
          `Workspace fixture event line ${eventId} does not reach task base ${state.taskBaseEventId}`
        );
      }
      eventId = parentEventId;
    }
    return events;
  }

  private async newestPublishedTaskEvent(
    state: WorkspaceRepoFixtureState,
    taskEvents: FixtureTaskEvent[],
    mainEventId: string
  ): Promise<string> {
    const taskEventIds = new Set([
      state.taskBaseEventId,
      ...taskEvents.map((event) => event.eventId),
    ]);
    let cursor: string | undefined;
    do {
      const page = await this.port.vcs.history({
        root: { kind: "event", eventId: mainEventId },
        direction: "past",
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of page.entries) {
        if (entry.node.kind === "event" && taskEventIds.has(entry.node.eventId)) {
          return entry.node.eventId;
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    throw new Error(
      `Protected main ${mainEventId} does not reach fixture task base ${state.taskBaseEventId}`
    );
  }

  private eventsThroughBoundary(
    taskEvents: FixtureTaskEvent[],
    boundaryEventId: string
  ): FixtureTaskEvent[] {
    if (taskEvents.length === 0) return [];
    const boundaryIndex = taskEvents.findIndex((event) => event.eventId === boundaryEventId);
    if (boundaryIndex < 0) return [];
    return taskEvents.slice(boundaryIndex);
  }

  private async taskWorkNewestFirst(events: FixtureTaskEvent[]): Promise<FixtureTaskWork[]> {
    const work: FixtureTaskWork[] = [];
    const seenWorkUnitIds = new Set<string>();
    for (const event of events) {
      for (const applicationId of [...event.applicationIds].reverse()) {
        const application = await this.port.vcs.inspect({
          node: { kind: "application", applicationId },
          edgeLimit: 1,
        });
        if (application.node.kind !== "application") {
          throw new Error(`Workspace fixture could not inspect application ${applicationId}`);
        }
        const workUnitId = application.node.value.workUnitId;
        if (seenWorkUnitIds.has(workUnitId)) continue;
        seenWorkUnitIds.add(workUnitId);
        work.push({
          workUnitId,
          changeIds: await this.authoredChangeIds(workUnitId),
        });
      }
    }
    return work;
  }

  private async authoredChangeIds(workUnitId: string): Promise<string[]> {
    const changeIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.port.vcs.neighbors({
        root: { kind: "work-unit", workUnitId },
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const edge of page.edges) {
        if (edge.kind === "authored-change" && edge.to.kind === "change") {
          changeIds.push(edge.to.changeId);
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return changeIds;
  }

  private async inspectTaskChanges(
    work: FixtureTaskWork[]
  ): Promise<{ createdRepositories: TaskCreatedRepository[] }> {
    const createdRepositories = new Map<string, TaskCreatedRepository>();
    const seenChangeIds = new Set<string>();
    for (const unit of work) {
      for (const changeId of unit.changeIds) {
        if (seenChangeIds.has(changeId)) continue;
        seenChangeIds.add(changeId);
        const change = await this.port.vcs.inspect({
          node: { kind: "change", changeId },
          edgeLimit: 1,
        });
        if (change.node.kind !== "change") {
          throw new Error(`Workspace fixture could not inspect change ${changeId}`);
        }
        if (change.node.value.kind !== "repository-create") {
          continue;
        }
        for (const effect of change.node.value.effects) {
          if (effect.kind === "repository-placement" && effect.afterPath !== null) {
            const prior = createdRepositories.get(effect.repositoryId);
            if (prior && prior.repoPath !== effect.afterPath) {
              throw new Error(
                `Task repository ${effect.repositoryId} was created at conflicting paths ${prior.repoPath} and ${effect.afterPath}`
              );
            }
            createdRepositories.set(effect.repositoryId, {
              repositoryId: effect.repositoryId,
              repoPath: effect.afterPath,
            });
          }
        }
      }
    }
    return {
      createdRepositories: [...createdRepositories.values()].sort(
        (left, right) =>
          left.repoPath.localeCompare(right.repoPath) ||
          left.repositoryId.localeCompare(right.repositoryId)
      ),
    };
  }

  private resolveCreationScope(
    state: WorkspaceRepoFixtureState,
    createdRepositories: TaskCreatedRepository[]
  ): {
    ownedRepositoryIds: Set<string>;
    primaryRepositoryId: string | null;
    error: Error | null;
  } {
    if (state.kind !== "created-repository" && state.kind !== "buildable-panel-with-derived") {
      if (!state.repositoryId) {
        return {
          ownedRepositoryIds: new Set(),
          primaryRepositoryId: null,
          error: new Error("Seeded repository fixture lost its exact repository identity"),
        };
      }
      return {
        ownedRepositoryIds: new Set([state.repositoryId]),
        primaryRepositoryId: state.repositoryId,
        error: null,
      };
    }

    const seedRepositoryId =
      state.kind === "buildable-panel-with-derived" ? state.repositoryId : null;
    const candidates = createdRepositories.filter(
      ({ repositoryId }) => repositoryId !== seedRepositoryId
    );
    const expected = `exactly one task-created repository in ${state.section}/`;
    if (candidates.length !== 1) {
      return {
        ownedRepositoryIds: new Set(seedRepositoryId ? [seedRepositoryId] : []),
        primaryRepositoryId: null,
        error: new Error(
          `Workspace repository creation scope expected ${expected}, found ${candidates.length}: ${
            candidates.map(({ repoPath }) => repoPath).join(", ") || "none"
          }`
        ),
      };
    }
    const created = candidates[0]!;
    if (!created.repoPath.startsWith(`${state.section}/`)) {
      return {
        ownedRepositoryIds: new Set(seedRepositoryId ? [seedRepositoryId] : []),
        primaryRepositoryId: null,
        error: new Error(
          `Workspace repository creation scope expected ${expected}, found ${created.repoPath}`
        ),
      };
    }
    return {
      ownedRepositoryIds: new Set(
        seedRepositoryId ? [seedRepositoryId, created.repositoryId] : [created.repositoryId]
      ),
      primaryRepositoryId: created.repositoryId,
      error: null,
    };
  }

  private scopeLabel(state: WorkspaceRepoFixtureState): string {
    return state.repoPath ?? `${state.section}/<task-created>`;
  }

  private command(kind: string): string {
    return `system-test:${kind}:${this.testName}:${crypto.randomUUID()}`;
  }
}

function repositorySeedFiles(
  repoName: string,
  fixture: WorkspaceRepoFixtureSpec
): Array<{ path: string; content: string }> {
  if (fixture.kind === "created-repository") return [];
  if (fixture.kind === "content") return [];
  if (fixture.kind === "buildable-worker") {
    return [
      {
        path: "package.json",
        content: `${JSON.stringify(
          {
            name: repoName,
            version: "0.0.0",
            private: true,
            type: "module",
            vibestudio: {
              title: `System Test ${repoName}`,
              kind: "worker",
              entry: "index.ts",
              authority: { requests: [] },
              durable: { classes: [{ className: "FixtureWorkerDO" }] },
            },
            dependencies: { "@workspace/runtime": "workspace:*" },
          },
          null,
          2
        )}\n`,
      },
      {
        path: "index.ts",
        content: [
          'import { DurableObjectBase, rpc } from "@workspace/runtime/worker";',
          "",
          "export class FixtureWorkerDO extends DurableObjectBase {",
          "  protected createTables(): void {}",
          "",
          "  // This disposable fixture is addressed directly by source/class/key.",
          "  // Direct resolveDurableObject methods are runtime-intrinsic; declared",
          "  // workspace services instead use workspace-service + resolveService.",
          '  @rpc({ principals: ["host", "code"], effect: { kind: "runtime-intrinsic" }, tier: "open", sensitivity: "write" })',
          "  async inspectProbe(): Promise<unknown> {",
          '    return this.env["SYSTEM_TEST_PROBE"] ?? null;',
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ];
  }
  if (fixture.kind === "buildable-regular-worker") {
    return [
      {
        path: "package.json",
        content: `${JSON.stringify(
          {
            name: repoName,
            version: "0.0.0",
            private: true,
            type: "module",
            vibestudio: {
              title: `System Test ${repoName}`,
              kind: "worker",
              entry: "index.ts",
              authority: { requests: [] },
            },
            dependencies: { "@workspace/runtime": "workspace:*" },
          },
          null,
          2
        )}\n`,
      },
      {
        path: "index.ts",
        content: [
          'import { createWorkerRuntime, handleWorkerRpc, type ExecutionContext, type WorkerEnv } from "@workspace/runtime/worker";',
          "",
          "let exposedFor: string | null = null;",
          "",
          "export default {",
          "  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {",
          "    const runtime = createWorkerRuntime(env);",
          "    if (exposedFor !== env.WORKER_ID) {",
          '      runtime.rpc.expose("inspectProbe", () => ({',
          "        ready: true,",
          '        systemTestProbe: env["SYSTEM_TEST_PROBE"] ?? null,',
          "      }));",
          "      exposedFor = env.WORKER_ID;",
          "    }",
          '    return handleWorkerRpc(runtime, request) ?? new Response("ready");',
          "  },",
          "};",
          "",
        ].join("\n"),
      },
    ];
  }
  if (fixture.kind === "buildable-panel-with-derived") {
    return [
      {
        path: "package.json",
        content: `${JSON.stringify(
          {
            name: `@workspace-panels/${repoName}`,
            version: "0.0.0",
            private: true,
            type: "module",
            vibestudio: {
              title: `System Test ${repoName}`,
              entry: "index.ts",
              authority: { requests: [] },
              template: "vanilla",
            },
          },
          null,
          2
        )}\n`,
      },
      {
        path: "index.ts",
        content:
          'document.getElementById("root")!.textContent = "Buildable system-test panel fixture";\n',
      },
    ];
  }
  return [
    {
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: `@workspace/${repoName}`,
          version: "0.0.0",
          private: true,
          type: "module",
          exports: { ".": "./src/index.ts" },
        },
        null,
        2
      )}\n`,
    },
    { path: "src/index.ts", content: 'export const fixtureValue = "baseline";\n' },
  ];
}

function semanticErrorCode(error: unknown): string | undefined {
  return serializeSystemTestError(error).code;
}

/** Return the exact typed blockers for a dependency failure, null for any
 * other error, and an empty vector for a malformed dependency payload. */
function dependencyBlockingChangeIds(error: unknown): string[] | null {
  const structured = serializeSystemTestError(error);
  if (structured.code !== "DependencyBlocked") return null;
  const data = structured.errorData;
  if (!data || Array.isArray(data) || typeof data !== "object") return [];
  const blockers = data["blockingChangeIds"];
  if (!Array.isArray(blockers) || blockers.length === 0) return [];
  if (blockers.some((value) => typeof value !== "string" || value.length === 0)) return [];
  return [...new Set(blockers as string[])];
}
