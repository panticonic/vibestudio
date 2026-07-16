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

export type WorkspaceRepoFixtureSpec =
  | { kind: "content"; section: "projects" }
  | { kind: "buildable-package"; section: "packages" };

export interface WorkspaceRepoFixturePort {
  vcs: FixtureVcs;
  blobstore: FixtureBlobstore;
  createContext(): Promise<{ contextId: string }>;
  destroyContext(contextId: string): Promise<void>;
}

export interface WorkspaceRepoFixtureRepository {
  repositoryId: string;
  repoPath: string;
}

export type WorkspaceRepoFixtureState = WorkspaceRepoFixtureSpec & {
  testName: string;
  contextId: string;
  repoName: string;
  repositoryId: string;
  repoPath: string;
  seedFilePaths: string[];
  importWorkUnitId: string;
  importChangeIds: string[];
  taskBaseEventId: string;
};

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

/**
 * Imports one exact disposable snapshot into one fresh semantic context.
 *
 * Setup and teardown use the same public operations as an agent. There is no
 * fixture-only repository API, moving-main reconciler, or ownership registry.
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
    private readonly repoName: string,
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
    const repoPath = `${this.fixture.section}/${this.repoName}`;
    try {
      const status = await this.port.vcs.status({ contextId });
      if (!status.clean || status.mainRelation !== "at") {
        throw new Error(
          `Fresh fixture context must start clean at main; clean=${status.clean} relation=${status.mainRelation}`
        );
      }
      const files = await Promise.all(
        repositorySeedFiles(this.repoName, this.fixture).map(async (file) => {
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
      if (status.committed.kind !== "event") {
        throw new Error("Fresh fixture context did not start at a committed event");
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
            `Workspace fixture setup and context cleanup both failed for ${repoPath}`
          ),
          {
            code: "WorkspaceRepoFixtureRecoveryFailed",
            errorData: {
              code: "WorkspaceRepoFixtureRecoveryFailed",
              repoPath,
              setup: serializeSystemTestError(setupError),
              cleanup: serializeSystemTestError(cleanupError),
            },
          }
        );
      }
      throw setupError;
    }
  }

  async cleanup(state: WorkspaceRepoFixtureState): Promise<WorkspaceRepoFixtureCleanup> {
    if (this.contextId !== state.contextId) {
      throw new Error(
        `Workspace repository fixture context changed from ${state.contextId} to ${this.contextId ?? "none"}`
      );
    }

    let publishedFixtureRemoved: WorkspaceRepoFixtureRepository | null = null;
    let unexpectedPublishedRepositoriesRemoved: WorkspaceRepoFixtureRepository[] = [];
    let counteractedChangeIds: string[] = [];
    let cleanupError: unknown;
    let cleanupContextId: string | null = null;
    try {
      const taskStatus = await this.port.vcs.status({ contextId: state.contextId });
      if (taskStatus.committed.kind !== "event") {
        throw new Error("Workspace fixture task context has no committed event for attribution");
      }
      const taskEvents = await this.taskFirstParentEvents(state, taskStatus.committed.eventId);
      const publishedBoundary =
        taskEvents.length === 0
          ? state.taskBaseEventId
          : await this.newestPublishedTaskEvent(state, taskEvents, taskStatus.mainEventId);
      if (publishedBoundary !== state.taskBaseEventId) {
        cleanupContextId = (await this.port.createContext()).contextId;
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
        const publishedEvents = this.eventsThroughBoundary(taskEvents, currentBoundary);
        const publishedWork = await this.taskWorkNewestFirst(publishedEvents);
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
        const publishedChanges = await this.inspectTaskChanges(publishedWork);
        const mainState = cleanupStatus.committed;
        publishedFixtureRemoved = await this.inspectPresentRepository(
          mainState,
          state.repositoryId
        );
        for (const repositoryId of publishedChanges.createdRepositoryIds) {
          if (repositoryId === state.repositoryId) continue;
          const repository = await this.inspectPresentRepository(mainState, repositoryId);
          if (repository) unexpectedPublishedRepositoriesRemoved.push(repository);
        }
        unexpectedPublishedRepositoriesRemoved.sort(
          (left, right) =>
            left.repoPath.localeCompare(right.repoPath) ||
            left.repositoryId.localeCompare(right.repositoryId)
        );
        counteractedChangeIds = await this.counteractPublishedTaskWork(
          state,
          cleanupContextId,
          cleanupStatus,
          publishedWork
        );
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      if (cleanupContextId) {
        try {
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
      await this.port.destroyContext(state.contextId);
    } catch (error) {
      cleanupError = cleanupError
        ? new AggregateError(
            [cleanupError, error],
            "Fixture teardown and task-context cleanup failed"
          )
        : error;
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
    publishedWork: FixtureTaskWork[]
  ): Promise<string[]> {
    let workingHead = status.workingHead;
    const counteractedChangeIds: string[] = [];
    const seenChangeIds = new Set<string>();
    for (const work of publishedWork) {
      const changeIds = work.changeIds.filter((changeId) => {
        if (seenChangeIds.has(changeId)) return false;
        seenChangeIds.add(changeId);
        return true;
      });
      if (changeIds.length === 0) continue;
      const reverted = await this.port.vcs.revert({
        contextId: cleanupContextId,
        commandId: this.command("revert-work"),
        expectedWorkingHead: workingHead,
        changeIds,
        intentSummary: `Remove published system-test work from ${state.repoPath}`,
      });
      workingHead = reverted.workingHead;
      counteractedChangeIds.push(...changeIds);
    }
    if (counteractedChangeIds.length === 0) return [];
    const committed = await this.port.vcs.commit({
      contextId: cleanupContextId,
      commandId: this.command("commit-removal"),
      expectedWorkingHead: workingHead,
      message: `Remove published system-test work from ${state.repoPath}`,
    });
    if (committed.event.kind !== "event") {
      throw new Error("Fixture cleanup commit did not return an event");
    }
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
  ): Promise<{ createdRepositoryIds: Set<string> }> {
    const createdRepositoryIds = new Set<string>();
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
        if (
          change.node.value.kind !== "repository-create" &&
          change.node.value.kind !== "repository-restore"
        ) {
          continue;
        }
        for (const effect of change.node.value.effects) {
          if (effect.kind === "repository-placement" && effect.afterPath !== null) {
            createdRepositoryIds.add(effect.repositoryId);
          }
        }
      }
    }
    return { createdRepositoryIds };
  }

  private command(kind: string): string {
    return `system-test:${kind}:${this.testName}:${crypto.randomUUID()}`;
  }
}

function repositorySeedFiles(
  repoName: string,
  fixture: WorkspaceRepoFixtureSpec
): Array<{ path: string; content: string }> {
  if (fixture.kind === "content") return [];
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
