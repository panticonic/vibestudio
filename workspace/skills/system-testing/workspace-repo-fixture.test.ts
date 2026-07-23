import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceRepoFixtureLifecycle,
  type WorkspaceRepoFixturePort,
} from "./workspace-repo-fixture.js";

const BUILDABLE = { kind: "buildable-package", section: "packages" } as const;
const BUILDABLE_WORKER = { kind: "buildable-worker", section: "workers" } as const;
const CREATED_PANEL = { kind: "created-repository", section: "panels" } as const;
const PANEL_WITH_DERIVED = {
  kind: "buildable-panel-with-derived",
  section: "panels",
} as const;
const CONTENT = { kind: "content", section: "projects" } as const;

function event(eventId: string) {
  return { kind: "event" as const, eventId };
}

function createPort() {
  let contexts = 0;
  let published = false;
  let escaped = false;
  let prepared = false;
  let taskTail: "import" | "escaped" | "file" | "local-file" = "import";
  let publishedFileLive = false;
  let reportedSnapshotRevision: string | null = null;
  let taskCreatedRepositories: Array<{ repositoryId: string; repoPath: string }> = [];
  const destroyContext = vi.fn(async (_contextId: string) => undefined);
  const putText = vi.fn(async (text: string) => ({
    digest: text.includes("fixtureValue") ? "b".repeat(64) : "a".repeat(64),
    size: Buffer.byteLength(text),
  }));
  const taskEventId = () =>
    taskTail === "escaped"
      ? "event:task"
      : taskTail === "file"
        ? "event:file"
        : taskTail === "local-file"
          ? "event:local"
          : "event:import";
  const mainEventId = () =>
    taskTail === "escaped"
      ? "event:task"
      : taskTail === "file"
        ? "event:file"
        : taskTail === "local-file"
          ? "event:import"
          : published && escaped
            ? "event:external"
            : published
              ? "event:import"
              : "event:main";
  const status = vi.fn(async ({ contextId }: { contextId: string }) => {
    const committedEventId =
      contextId === "context:1"
        ? prepared || taskCreatedRepositories.length > 0
          ? taskEventId()
          : "event:main"
        : mainEventId();
    const currentMainEventId = mainEventId();
    return {
      contextId,
      committed: event(committedEventId),
      workingHead: event(committedEventId),
      clean: true,
      mainEventId: currentMainEventId,
      mainRelation: committedEventId === currentMainEventId ? ("at" as const) : ("ahead" as const),
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
    };
  });
  const importSnapshot = vi.fn(
    async (input: Parameters<WorkspaceRepoFixturePort["vcs"]["importSnapshot"]>[0]) => {
      prepared = true;
      return {
        contextId: input.contextId,
        eventId: "event:import",
        workUnitId: "work:import",
        importedRepositoryIds: ["repository:fixture"],
      };
    }
  );
  const changesForWork = (workUnitId: string): string[] =>
    workUnitId === "work:escaped"
      ? taskCreatedRepositories.length > 0
        ? taskCreatedRepositories.map((_, index) => `change:task-created:${index}`)
        : ["change:escaped"]
      : workUnitId === "work:file"
        ? ["change:file"]
        : workUnitId === "work:local"
          ? ["change:local"]
          : ["change:repository", "change:package", "change:source"];
  const inspect = vi.fn(
    async ({ node }: Parameters<WorkspaceRepoFixturePort["vcs"]["inspect"]>[0]) => {
      if (node.kind === "event") {
        const eventShape: Record<string, { applications: string[]; parents: string[] }> = {
          "event:import": { applications: ["application:import"], parents: ["event:main"] },
          "event:task": {
            applications: ["application:escaped"],
            parents: [prepared ? "event:import" : "event:main"],
          },
          "event:file": { applications: ["application:file"], parents: ["event:import"] },
          "event:local": { applications: ["application:local"], parents: ["event:import"] },
          "event:main": { applications: [], parents: [] },
        };
        const shape = eventShape[node.eventId];
        if (!shape) throw new Error(`unexpected event ${node.eventId}`);
        return {
          root: node,
          node: {
            kind: "event" as const,
            value: {
              eventId: node.eventId,
              applicationIds: shape.applications,
              parentEventIds: shape.parents,
            },
          },
          edges: [],
          hasMoreEdges: false,
        };
      }
      if (node.kind === "application") {
        const workUnitId =
          node.applicationId === "application:escaped"
            ? "work:escaped"
            : node.applicationId === "application:file"
              ? "work:file"
              : node.applicationId === "application:local"
                ? "work:local"
                : "work:import";
        return {
          root: node,
          node: {
            kind: "application" as const,
            value: { applicationId: node.applicationId, workUnitId },
          },
          edges: [],
          hasMoreEdges: false,
        };
      }
      if (node.kind === "work-unit") {
        const escapedWork = node.workUnitId === "work:escaped";
        const fileWork = node.workUnitId === "work:file" || node.workUnitId === "work:local";
        const importRequest = importSnapshot.mock.calls.at(-1)?.[0];
        return {
          root: node,
          node: {
            kind: "work-unit" as const,
            value: {
              workUnitId: node.workUnitId,
              commandId: escapedWork
                ? "command:escaped"
                : (importRequest?.commandId ?? "command:import"),
              kind: "import" as const,
              authoredChangeIds: changesForWork(node.workUnitId),
              incorporatedChangeIds: [],
              decisionIds: [],
              intentSummary: "fixture import",
              externalSnapshot:
                !escapedWork && !fileWork && importRequest
                  ? {
                      sourceKind: importRequest.source.kind,
                      sourceUri: importRequest.source.uri,
                      snapshotRevision:
                        reportedSnapshotRevision ?? importRequest.source.snapshotRevision,
                      snapshotDigest: `snapshot:${"a".repeat(64)}`,
                      targetRepositoryIds: ["repository:fixture"],
                    }
                  : null,
              normalizationProtocol: "semantic-vcs-v1",
              createdAt: "2026-07-15T00:00:00.000Z",
            },
          },
          edges: [],
          hasMoreEdges: false,
        };
      }
      if (node.kind === "change") {
        const taskCreatedIndex = node.changeId.startsWith("change:task-created:")
          ? Number(node.changeId.slice("change:task-created:".length))
          : -1;
        const taskCreated = taskCreatedRepositories[taskCreatedIndex];
        const repositoryCreate =
          node.changeId === "change:repository" ||
          node.changeId === "change:escaped" ||
          taskCreated !== undefined;
        const repositoryId =
          taskCreated?.repositoryId ??
          (node.changeId === "change:escaped" ? "repository:escaped" : "repository:fixture");
        return {
          root: node,
          node: {
            kind: "change" as const,
            value: {
              changeId: node.changeId,
              authoredByWorkUnitId: "work:escaped",
              operation: 0,
              kind: repositoryCreate ? ("repository-create" as const) : ("file-create" as const),
              effects: repositoryCreate
                ? [
                    {
                      kind: "repository-placement" as const,
                      repositoryId,
                      beforePath: null,
                      afterPath:
                        taskCreated?.repoPath ??
                        (repositoryId === "repository:escaped"
                          ? "projects/outside-fixture"
                          : "projects/system-test-content"),
                    },
                  ]
                : [
                    {
                      kind: "placement" as const,
                      fileId: `file:${node.changeId}`,
                      before: null,
                      after: { repositoryId: "repository:fixture", path: "src/index.ts" },
                    },
                  ],
              counteractsChangeIds: [],
              effectDigest: "digest:escaped",
              normalizationProtocol: "semantic-vcs-v1",
            },
          },
          edges: [],
          hasMoreEdges: false,
        };
      }
      if (node.kind !== "repository") throw new Error(`unexpected node ${node.kind}`);
      const taskCreated = taskCreatedRepositories.find(
        ({ repositoryId }) => repositoryId === node.repositoryId
      );
      const isEscaped = node.repositoryId === "repository:escaped";
      if ((isEscaped && !escaped) || (!isEscaped && !taskCreated && !published)) {
        throw Object.assign(new Error("repository is absent"), { code: "InvalidReference" });
      }
      return {
        root: node,
        node: {
          kind: "repository" as const,
          state: event("event:main"),
          value: {
            kind: "present" as const,
            repositoryId:
              taskCreated?.repositoryId ??
              (isEscaped ? "repository:escaped" : "repository:fixture"),
            repoPath:
              taskCreated?.repoPath ??
              (isEscaped ? "projects/outside-fixture" : "projects/system-test-content"),
            manifestId: "manifest:fixture",
          },
        },
        edges: [],
        hasMoreEdges: false,
      };
    }
  );
  const neighbors = vi.fn(
    async ({
      root,
      cursor,
      limit = 500,
    }: Parameters<WorkspaceRepoFixturePort["vcs"]["neighbors"]>[0]) => {
      if (root.kind !== "work-unit") throw new Error("fixture neighbors requires work-unit root");
      const changeIds = changesForWork(root.workUnitId);
      const offset = cursor ? Number(cursor) : 0;
      const end = Math.min(offset + limit, changeIds.length);
      return {
        root,
        edges: changeIds.slice(offset, end).map((changeId) => ({
          kind: "authored-change" as const,
          from: root,
          to: { kind: "change" as const, changeId },
        })),
        nextCursor: end < changeIds.length ? String(end) : null,
      };
    }
  );
  const history = vi.fn(
    async ({
      root,
      cursor,
      limit = 500,
    }: Parameters<WorkspaceRepoFixturePort["vcs"]["history"]>[0]) => {
      const histories: Record<string, string[]> = {
        "event:main": ["event:main"],
        "event:import": ["event:import", "event:main"],
        "event:task": ["event:task", "event:import", "event:main"],
        "event:file": ["event:file", "event:import", "event:main"],
        "event:local": ["event:local", "event:import", "event:main"],
        "event:external": ["event:external", "event:import", "event:main"],
      };
      if (root.kind !== "event") throw new Error("fixture history requires an event root");
      const ids = histories[root.eventId] ?? [];
      const offset = cursor ? Number(cursor) : 0;
      const end = Math.min(offset + limit, ids.length);
      return {
        root,
        entries: ids.slice(offset, end).map((eventId) => ({
          node: event(eventId),
          createdAt: "2026-07-15T00:00:00.000Z",
          summary: eventId,
        })),
        nextCursor: end < ids.length ? String(end) : null,
      };
    }
  );
  const revert = vi.fn(
    async ({ contextId, changeIds }: { contextId: string; changeIds: string[] }) => {
      if (changeIds.includes("change:repository") && publishedFileLive) {
        throw Object.assign(new Error("later file still depends on repository creation"), {
          code: "DependencyBlocked",
          errorData: {
            code: "DependencyBlocked",
            blockingChangeIds: ["change:file"],
          },
        });
      }
      if (changeIds.includes("change:file")) publishedFileLive = false;
      const ordinal = revert.mock.calls.length;
      return {
        contextId,
        workUnitId: `work:revert:${ordinal}`,
        applicationId: `application:revert:${ordinal}`,
        changeIds: [`change:counteraction:${ordinal}`],
        incorporatedChangeIds: [],
        workingHead: {
          kind: "application" as const,
          applicationId: `application:revert:${ordinal}`,
        },
      };
    }
  );
  const commit = vi.fn(async ({ contextId }: { contextId: string }) => ({
    contextId,
    event: event("event:removal"),
    committedApplicationIds: ["application:revert"],
    integrationSourceEventId: null,
  }));
  const push = vi.fn(async ({ contextId }: { contextId: string }) => {
    published = false;
    escaped = false;
    return {
      contextId,
      eventId: "event:removal",
      mainEventId: "event:removal",
      effectId: "effect:push",
      appliedAt: "2026-07-15T00:00:00.000Z",
    };
  });

  const port = {
    vcs: { status, importSnapshot, inspect, neighbors, history, revert, commit, push },
    blobstore: { putText },
    createContext: vi.fn(async () => ({ contextId: `context:${++contexts}` })),
    destroyContext,
  } as unknown as WorkspaceRepoFixturePort;
  return {
    port,
    createContext: port.createContext,
    putText,
    status,
    importSnapshot,
    inspect,
    neighbors,
    history,
    revert,
    commit,
    push,
    destroyContext,
    misreportSnapshotRevision: (revision: string) => {
      reportedSnapshotRevision = revision;
    },
    publish: () => {
      published = true;
    },
    escape: () => {
      escaped = true;
      taskTail = "escaped";
    },
    createTaskRepositories: (repoPaths: string[]) => {
      taskCreatedRepositories = repoPaths.map((repoPath, index) => ({
        repositoryId: `repository:task-created:${index}`,
        repoPath,
      }));
      taskTail = "escaped";
    },
    externalEscape: () => {
      escaped = true;
    },
    publishWithFile: () => {
      published = true;
      taskTail = "file";
      publishedFileLive = true;
    },
    publishWithUnattributedFile: () => {
      published = true;
      taskTail = "import";
      publishedFileLive = true;
    },
    publishThenEditLocally: () => {
      published = true;
      taskTail = "local-file";
    },
  };
}

describe("WorkspaceRepoFixtureLifecycle", () => {
  it("starts a task-created repository scope without seeding a repository", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "panel-create-test",
      null,
      CREATED_PANEL
    );

    const state = await fixture.prepare();

    expect(state).toMatchObject({
      kind: "created-repository",
      section: "panels",
      contextId: "context:1",
      repoName: null,
      repositoryId: null,
      repoPath: null,
      seedFilePaths: [],
      importWorkUnitId: null,
      importChangeIds: [],
      taskBaseEventId: "event:main",
    });
    expect(fake.putText).not.toHaveBeenCalled();
    expect(fake.importSnapshot).not.toHaveBeenCalled();

    fake.createTaskRepositories(["panels/task-created"]);
    await expect(fixture.cleanup(state)).resolves.toEqual({
      publishedFixtureRemoved: {
        repositoryId: "repository:task-created:0",
        repoPath: "panels/task-created",
      },
      unexpectedPublishedRepositoriesRemoved: [],
      counteractedChangeIds: ["change:task-created:0"],
    });
  });

  it("fails a task-created scope when the task creates no repository", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "panel-create-zero-test",
      null,
      CREATED_PANEL
    );
    const state = await fixture.prepare();

    await expect(fixture.cleanup(state)).rejects.toThrow(
      "expected exactly one task-created repository in panels/, found 0: none"
    );
    expect(fake.revert).not.toHaveBeenCalled();
    expect(fake.destroyContext).toHaveBeenCalledWith("context:1");
  });

  it("counteracts and fails a task-created scope with multiple repositories", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "panel-create-multiple-test",
      null,
      CREATED_PANEL
    );
    const state = await fixture.prepare();
    fake.createTaskRepositories(["panels/first", "panels/second"]);

    await expect(fixture.cleanup(state)).rejects.toThrow(
      "expected exactly one task-created repository in panels/, found 2: panels/first, panels/second"
    );
    expect(fake.revert).toHaveBeenCalledWith(
      expect.objectContaining({
        changeIds: ["change:task-created:0", "change:task-created:1"],
      })
    );
    expect(fake.push).toHaveBeenCalledTimes(1);
  });

  it("counteracts and fails a task-created repository in the wrong section", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "panel-create-wrong-section-test",
      null,
      CREATED_PANEL
    );
    const state = await fixture.prepare();
    fake.createTaskRepositories(["packages/not-a-panel"]);

    await expect(fixture.cleanup(state)).rejects.toThrow(
      "expected exactly one task-created repository in panels/, found packages/not-a-panel"
    );
    expect(fake.revert).toHaveBeenCalledWith(
      expect.objectContaining({ changeIds: ["change:task-created:0"] })
    );
    expect(fake.push).toHaveBeenCalledTimes(1);
  });

  it("seeds one buildable panel and owns exactly one task-derived panel", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "panel-fork-test",
      "system-test-panel-source",
      PANEL_WITH_DERIVED
    );
    const state = await fixture.prepare();

    expect(state).toMatchObject({
      repositoryId: "repository:fixture",
      repoPath: "panels/system-test-panel-source",
      seedFilePaths: ["index.ts", "package.json"],
    });
    const seededText = fake.putText.mock.calls.map(([text]) => text).join("\n");
    expect(seededText).toContain('"@workspace-panels/system-test-panel-source"');
    expect(seededText).toContain('"template": "vanilla"');

    fake.createTaskRepositories(["panels/system-test-panel-fork"]);
    await expect(fixture.cleanup(state)).resolves.toEqual({
      publishedFixtureRemoved: {
        repositoryId: "repository:task-created:0",
        repoPath: "panels/system-test-panel-fork",
      },
      unexpectedPublishedRepositoriesRemoved: [],
      counteractedChangeIds: [
        "change:task-created:0",
        "change:repository",
        "change:package",
        "change:source",
      ],
    });
  });

  it("does not count the seeded panel as the required derived repository", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "panel-fork-without-derived-test",
      "system-test-panel-source",
      PANEL_WITH_DERIVED
    );
    const state = await fixture.prepare();

    await expect(fixture.cleanup(state)).rejects.toThrow(
      "expected exactly one task-created repository in panels/, found 0: none"
    );
    expect(fake.destroyContext).toHaveBeenCalledWith("context:1");
  });

  it("imports a buildable snapshot with exact CAS-backed file metadata", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "build-test",
      "system-test-build",
      BUILDABLE
    );

    const state = await fixture.prepare();

    expect(state).toMatchObject({
      contextId: "context:1",
      repositoryId: "repository:fixture",
      repoPath: "packages/system-test-build",
      seedFilePaths: ["package.json", "src/index.ts"],
      importWorkUnitId: "work:import",
      importChangeIds: ["change:repository", "change:package", "change:source"],
    });
    expect(fake.putText).toHaveBeenCalledTimes(2);
    expect(fake.importSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkingHead: event("event:main"),
        repositories: [
          expect.objectContaining({
            repoPath: "packages/system-test-build",
            files: [
              expect.objectContaining({ path: "package.json", contentHash: "a".repeat(64) }),
              expect.objectContaining({ path: "src/index.ts", contentHash: "b".repeat(64) }),
            ],
          }),
        ],
      })
    );

    await fixture.cleanup(state);
    expect(fake.revert).not.toHaveBeenCalled();
    expect(fake.createContext).toHaveBeenCalledTimes(1);
    expect(fake.destroyContext).toHaveBeenCalledTimes(1);
  });

  it("seeds a worker fixture under worker discovery with a runnable Durable Object manifest", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "worker-test",
      "system-test-worker",
      BUILDABLE_WORKER
    );

    const state = await fixture.prepare();

    expect(state).toMatchObject({
      contextId: "context:1",
      repositoryId: "repository:fixture",
      repoPath: "workers/system-test-worker",
      seedFilePaths: ["index.ts", "package.json"],
    });
    const seededText = fake.putText.mock.calls.map(([text]) => text).join("\n");
    expect(seededText).toContain('"kind": "worker"');
    expect(seededText).toContain('"entry": "index.ts"');
    expect(seededText).toContain('"className": "FixtureWorkerDO"');
    expect(seededText).toContain('from "@workspace/runtime/worker"');
    expect(fake.importSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            repoPath: "workers/system-test-worker",
            files: [
              expect.objectContaining({ path: "index.ts" }),
              expect.objectContaining({ path: "package.json" }),
            ],
          }),
        ],
      })
    );

    await fixture.cleanup(state);
    expect(fake.destroyContext).toHaveBeenCalledWith("context:1");
  });

  it("does not enumerate ambient repositories during setup or cleanup", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "large-workspace-test",
      "system-test-large-workspace",
      CONTENT
    );

    const state = await fixture.prepare();
    await fixture.cleanup(state);

    expect(fake.createContext).toHaveBeenCalledTimes(1);
    const repositoryInspections = fake.inspect.mock.calls.filter(
      ([input]) => input.node.kind === "repository"
    );
    expect(repositoryInspections).toEqual([]);
    expect(fake.history).toHaveBeenCalledWith(
      expect.objectContaining({ root: event("event:main"), direction: "past" })
    );
  });

  it("refuses a fixture whose inspected import work does not match its requested snapshot", async () => {
    const fake = createPort();
    fake.misreportSnapshotRevision("fixture:different");
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "mismatched-snapshot-test",
      "system-test-mismatched-snapshot",
      CONTENT
    );

    await expect(fixture.prepare()).rejects.toThrow(
      "Fixture import did not record its exact command and source snapshot"
    );
    expect(fake.destroyContext).toHaveBeenCalledWith("context:1");
    expect(fixture.taskContextId).toBeNull();
  });

  it("removes a published fixture through ordinary revert, commit, and push", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "content-test",
      "system-test-content",
      CONTENT
    );
    const state = await fixture.prepare();
    fake.publish();

    await expect(fixture.cleanup(state)).resolves.toEqual({
      publishedFixtureRemoved: {
        repositoryId: "repository:fixture",
        repoPath: "projects/system-test-content",
      },
      unexpectedPublishedRepositoriesRemoved: [],
      counteractedChangeIds: ["change:repository", "change:package", "change:source"],
    });
    expect(fake.revert).toHaveBeenCalledWith(
      expect.objectContaining({
        changeIds: ["change:repository", "change:package", "change:source"],
      })
    );
    expect(fake.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkingHead: {
          kind: "application",
          applicationId: "application:revert:1",
        },
      })
    );
    expect(fake.push).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCommittedEventId: "event:removal",
        expectedMainEventId: "event:import",
      })
    );
  });

  it("reports repositories published outside the exact fixture identity", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "scope-test",
      "system-test-content",
      CONTENT
    );
    const state = await fixture.prepare();
    fake.publish();
    fake.escape();

    await expect(fixture.cleanup(state)).resolves.toMatchObject({
      unexpectedPublishedRepositoriesRemoved: [
        { repositoryId: "repository:escaped", repoPath: "projects/outside-fixture" },
      ],
    });
  });

  it("counteracts exact task-authored publication even when the fixture is already absent", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "scope-only-test",
      "system-test-content",
      CONTENT
    );
    const state = await fixture.prepare();
    fake.escape();

    await expect(fixture.cleanup(state)).resolves.toEqual({
      publishedFixtureRemoved: null,
      unexpectedPublishedRepositoriesRemoved: [
        { repositoryId: "repository:escaped", repoPath: "projects/outside-fixture" },
      ],
      counteractedChangeIds: [
        "change:escaped",
        "change:repository",
        "change:package",
        "change:source",
      ],
    });
    expect(fake.createContext).toHaveBeenCalledTimes(2);
    expect(fake.revert).toHaveBeenCalledTimes(2);
    expect(fake.destroyContext).toHaveBeenCalledTimes(2);
  });

  it("does not attribute a concurrently published repository to this test", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "concurrent-test",
      "system-test-content",
      CONTENT
    );
    const state = await fixture.prepare();
    fake.publish();
    fake.externalEscape();

    await expect(fixture.cleanup(state)).resolves.toMatchObject({
      unexpectedPublishedRepositoriesRemoved: [],
    });
  });

  it("counteracts later published file work before the repository import", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "published-file-test",
      "system-test-content",
      CONTENT
    );
    const state = await fixture.prepare();
    fake.publishWithFile();

    await expect(fixture.cleanup(state)).resolves.toMatchObject({
      publishedFixtureRemoved: { repositoryId: "repository:fixture" },
      counteractedChangeIds: [
        "change:file",
        "change:repository",
        "change:package",
        "change:source",
      ],
    });
    expect(fake.revert).toHaveBeenCalledTimes(2);
    expect(fake.revert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedWorkingHead: event("event:file"),
        changeIds: ["change:file"],
      })
    );
    expect(fake.revert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedWorkingHead: {
          kind: "application",
          applicationId: "application:revert:1",
        },
        changeIds: ["change:repository", "change:package", "change:source"],
      })
    );
    expect(fake.commit).toHaveBeenCalledTimes(1);
    expect(fake.push).toHaveBeenCalledTimes(1);
  });

  it("discovers and counteracts an incorporated blocker outside first-parent authored work", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "integrated-file-test",
      "system-test-content",
      CONTENT
    );
    const state = await fixture.prepare();
    fake.publishWithUnattributedFile();

    await expect(fixture.cleanup(state)).resolves.toMatchObject({
      counteractedChangeIds: [
        "change:file",
        "change:repository",
        "change:package",
        "change:source",
      ],
    });
    expect(fake.revert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedWorkingHead: event("event:import"),
        changeIds: ["change:repository", "change:package", "change:source"],
      })
    );
    expect(fake.revert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedWorkingHead: event("event:import"),
        changeIds: ["change:file"],
      })
    );
    expect(fake.revert).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        expectedWorkingHead: {
          kind: "application",
          applicationId: "application:revert:2",
        },
        changeIds: ["change:repository", "change:package", "change:source"],
      })
    );
    expect(fake.commit).toHaveBeenCalledTimes(1);
    expect(fake.push).toHaveBeenCalledTimes(1);
  });

  it("fails closed when DependencyBlocked omits its typed blocker identities", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "malformed-dependency-test",
      "system-test-content",
      CONTENT
    );
    const state = await fixture.prepare();
    fake.publish();
    fake.revert.mockRejectedValueOnce(
      Object.assign(new Error("blocked without structured detail"), {
        code: "DependencyBlocked",
      })
    );

    await expect(fixture.cleanup(state)).rejects.toThrow(
      "DependencyBlocked did not provide any blocking change identities"
    );
    expect(fake.commit).not.toHaveBeenCalled();
    expect(fake.push).not.toHaveBeenCalled();
    expect(fake.destroyContext).toHaveBeenCalledTimes(2);
  });

  it("leaves newer unpublished task work to context destruction", async () => {
    const fake = createPort();
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "published-then-local-test",
      "system-test-content",
      CONTENT
    );
    const state = await fixture.prepare();
    fake.publishThenEditLocally();

    await expect(fixture.cleanup(state)).resolves.toMatchObject({
      counteractedChangeIds: ["change:repository", "change:package", "change:source"],
    });
    expect(fake.revert).toHaveBeenCalledTimes(1);
    expect(fake.revert).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkingHead: event("event:import"),
        changeIds: ["change:repository", "change:package", "change:source"],
      })
    );
    expect(fake.revert).not.toHaveBeenCalledWith(
      expect.objectContaining({ changeIds: ["change:local"] })
    );
  });

  it("destroys a fresh context when setup fails", async () => {
    const fake = createPort();
    fake.status.mockRejectedValueOnce(new Error("status unavailable"));
    const fixture = new WorkspaceRepoFixtureLifecycle(
      fake.port,
      "failed-test",
      "system-test-failed",
      CONTENT
    );

    await expect(fixture.prepare()).rejects.toThrow("status unavailable");
    expect(fake.destroyContext).toHaveBeenCalledWith("context:1");
    expect(fixture.taskContextId).toBeNull();
  });
});
