import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex, sha256HexSyncText } from "@vibestudio/content-addressing";
import type { GitCommitTreeEntry } from "@vibestudio/git";
import { GitBridge, provenanceGitUri, type BridgeHost } from "./bridge.js";

function commitBlob(
  filePath: string,
  content: string | Buffer,
  mode: 0o100644 | 0o100755 = 0o100644
): GitCommitTreeEntry {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    path: filePath,
    type: "blob",
    mode,
    oid: "f".repeat(40),
    bytes,
  };
}

function eventInspection(eventId: string) {
  return {
    root: { kind: "event" as const, eventId },
    node: {
      kind: "event" as const,
      value: {
        eventId,
        workspaceId: "workspace:test",
        commandId: `command:${eventId}`,
        kind: "commit" as const,
        workspaceFactRootId: `facts:${eventId}`,
        parentEventIds: ["event:parent"],
        applicationIds: ["application:1"],
        decisionIds: [],
        message: "Semantic snapshot",
        semanticProtocol: "semantic-v1",
        createdAt: new Date(0).toISOString(),
      },
    },
    edges: [],
    hasMoreEdges: false,
  };
}

function repositoryInspection(state: { kind: "event"; eventId: string }, repoPath: string) {
  return {
    root: {
      kind: "repository" as const,
      state,
      repositoryId: `repository:${repoPath}`,
    },
    node: {
      kind: "repository" as const,
      state,
      value: {
        kind: "present" as const,
        repositoryId: `repository:${repoPath}`,
        repoPath,
        manifestId: `manifest:${repoPath}`,
      },
    },
    edges: [],
    hasMoreEdges: false,
  };
}

function applicationInspection(applicationId = "application:1") {
  return {
    root: { kind: "application" as const, applicationId },
    node: {
      kind: "application" as const,
      value: {
        applicationId,
        workUnitId: "work:import",
        basis: { kind: "event" as const, eventId: "event:parent" },
        appliedChangeCount: 1,
        appliedChanges: [],
        resultWorkspaceFactRootId: "facts:import",
        semanticProtocol: "semantic-v1",
      },
    },
    edges: [],
    hasMoreEdges: false,
  };
}

function importWorkUnitInspection(revision: string, sourceUri: string) {
  return {
    root: { kind: "work-unit" as const, workUnitId: "work:import" },
    node: {
      kind: "work-unit" as const,
      value: {
        workUnitId: "work:import",
        commandId: "command:import",
        kind: "import" as const,
        authoredChangeCount: 1,
        authoredChangeIds: ["change:import"],
        incorporatedChangeCount: 0,
        incorporatedChangeIds: [],
        decisionCount: 0,
        decisionIds: [],
        intentSummary: "Import snapshot",
        externalSnapshot: {
          sourceKind: "git" as const,
          sourceUri,
          snapshotRevision: revision,
          snapshotDigest: "a".repeat(64),
          targetRepositoryIds: ["repository:projects/demo"],
        },
        normalizationProtocol: "semantic-v1",
        createdAt: new Date(0).toISOString(),
      },
    },
    edges: [],
    hasMoreEdges: false,
  };
}

function status(contextId: string, eventId: string) {
  return {
    contextId,
    committed: { kind: "event" as const, eventId },
    workingHead: { kind: "event" as const, eventId },
    clean: true,
    mainEventId: eventId,
    mainRelation: "at" as const,
    workingCounts: { applications: 0, workUnits: 0, changes: 0 },
  };
}

function baseHost(root: string) {
  const unreachable = () =>
    vi.fn(async (): Promise<never> => {
      throw new Error("unexpected VCS call");
    });
  const host: BridgeHost = {
    checkoutRoot: async () => root,
    ensureContext: vi.fn(async () => undefined),
    blobstore: {
      putBase64: vi.fn(async (bytesBase64: string) => {
        const bytes = Buffer.from(bytesBase64, "base64");
        return { digest: sha256Hex(bytes), size: bytes.byteLength };
      }),
    },
    vcs: {
      status: unreachable(),
      neighbors: unreachable(),
      inspect: unreachable(),
      resolveRepository: vi.fn(async () => null),
      listFiles: unreachable(),
      readFile: unreachable(),
      importSnapshot: unreachable(),
    },
  };
  return { host };
}

describe("GitBridge semantic snapshot boundary", () => {
  it.each([
    String.raw`C:\Users\alice\demo.git`,
    "C:/Users/alice/demo.git",
    String.raw`C:relative\demo.git`,
  ])("keeps the Windows-local remote %s private", (remote) => {
    expect(provenanceGitUri(remote)).toBe(`git-local://sha256/${sha256HexSyncText(remote)}`);
  });

  it("preserves SCP-style remote identity", () => {
    expect(provenanceGitUri("git@example.test:owner/demo.git")).toBe(
      "ssh://example.test/owner/demo.git"
    );
  });

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "git-bridge-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("roots operational checkouts below host state rather than semantic source", async () => {
    const checkoutRoot = path.join(root, "state", "git-checkouts");
    const sourceRoot = path.join(root, "source");
    const { host } = baseHost(checkoutRoot);
    const bridge = new GitBridge(host);

    expect(await bridge.repoGitDir("projects/demo")).toBe(
      path.join(checkoutRoot, "projects", "demo")
    );
    expect(await bridge.repoGitDir("projects/demo")).not.toBe(
      path.join(sourceRoot, "projects", "demo")
    );
  });

  it("imports one exact checkout snapshot as a semantic candidate", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "export const value = 1;\n");
    writeFileSync(path.join(dir, "binary.dat"), Buffer.from([0xff, 0xfe]));
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    host.vcs.inspect = vi.fn(async () => {
      const inspected = eventInspection("event:main");
      inspected.node.value.applicationIds = [];
      return inspected;
    });
    host.vcs.importSnapshot = vi.fn(async () => ({
      contextId: "ctx:import",
      eventId: "event:imported",
      workUnitId: "work:imported",
      importedRepositoryIds: ["repository:projects/demo"],
    }));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("a".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob("binary.dat", Buffer.from([0xff, 0xfe])),
      commitBlob("index.ts", "export const value = 1;\n"),
    ]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([
      ["binary.dat", 1, 1, 1],
      ["index.ts", 1, 1, 1],
    ]);

    await expect(
      bridge.importLockedInner(repoPath, {
        sourceUri: "https://token@example.test/owner/demo.git?signature=secret",
      })
    ).resolves.toEqual({
      contextId: expect.stringMatching(/^git-bridge-/),
      eventId: "event:imported",
      changed: true,
    });
    expect(host.ensureContext).toHaveBeenCalledWith(expect.stringMatching(/^git-bridge-/));
    expect(host.vcs.importSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: expect.stringMatching(/^git-bridge-/),
        expectedWorkingHead: { kind: "event", eventId: "event:main" },
        source: expect.objectContaining({
          kind: "git",
          uri: "https://example.test/owner/demo.git",
          snapshotRevision: "a".repeat(40),
        }),
        repositories: [
          expect.objectContaining({
            repoPath,
            files: expect.arrayContaining([
              expect.objectContaining({
                path: "binary.dat",
                contentHash: sha256Hex(Buffer.from([0xff, 0xfe])),
                mode: 0o644,
              }),
              expect.objectContaining({
                path: "index.ts",
                contentHash: sha256Hex(Buffer.from("export const value = 1;\n")),
                mode: 0o644,
              }),
            ]),
          }),
        ],
      })
    );
    expect(host.vcs.resolveRepository).toHaveBeenCalledOnce();
    expect(host.vcs.resolveRepository).toHaveBeenCalledWith({
      state: { kind: "event", eventId: "event:main" },
      repoPath,
    });
    expect(host.vcs.neighbors).not.toHaveBeenCalled();
    expect(host.blobstore.putBase64).toHaveBeenCalledTimes(2);
    expect(host.blobstore.putBase64).toHaveBeenCalledWith(
      Buffer.from([0xff, 0xfe]).toString("base64")
    );
    expect(host.blobstore.putBase64).toHaveBeenCalledWith(
      Buffer.from("export const value = 1;\n").toString("base64")
    );
  });

  it("imports an actual resolved commit tree and stores duplicate content once", async () => {
    const repoPath = "projects/real-tree";
    const dir = path.join(root, repoPath);
    mkdirSync(dir, { recursive: true });
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    host.vcs.importSnapshot = vi.fn(async () => ({
      contextId: "ctx:import",
      eventId: "event:real-import",
      workUnitId: "work:real-import",
      importedRepositoryIds: ["repository:projects/real-tree"],
    }));
    host.vcs.inspect = vi.fn(async () => eventInspection("event:real-import"));
    const bridge = new GitBridge(host);
    await bridge.git.init(dir, "main");
    writeFileSync(path.join(dir, "one.txt"), "shared bytes\n");
    writeFileSync(path.join(dir, "two.txt"), "shared bytes\n");
    writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await bridge.git.add(dir, "one.txt");
    await bridge.git.add(dir, "two.txt");
    await bridge.git.add(dir, "run.sh");
    const commitOid = await bridge.git.commit({
      dir,
      message: "Committed snapshot",
      author: { name: "Test", email: "test@example.com" },
    });

    await expect(
      bridge.importLockedInner(repoPath, { sourceUri: "https://example.test/real-tree.git" })
    ).resolves.toEqual({
      contextId: expect.stringMatching(/^git-bridge-/),
      eventId: "event:real-import",
      changed: true,
    });

    expect(host.vcs.importSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ snapshotRevision: commitOid }),
        repositories: [
          expect.objectContaining({
            files: [
              expect.objectContaining({ path: "one.txt", mode: 0o644 }),
              expect.objectContaining({ path: "run.sh", mode: 0o755 }),
              expect.objectContaining({ path: "two.txt", mode: 0o644 }),
            ],
          }),
        ],
      })
    );
    expect(host.blobstore.putBase64).toHaveBeenCalledTimes(2);
  });

  it("skips import when the exact Git revision and snapshot already match", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "same\n");
    const main = { kind: "event" as const, eventId: "event:main" };
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, main.eventId));
    host.vcs.resolveRepository = vi.fn(async ({ state, repoPath: resolvedPath }) => ({
      state,
      repositoryId: `repository:${resolvedPath}`,
      repoPath: resolvedPath,
    }));
    host.vcs.inspect = vi.fn(async ({ node }) => {
      if (node.kind === "repository") return repositoryInspection(main, repoPath);
      if (node.kind === "application") return applicationInspection(node.applicationId);
      if (node.kind === "work-unit") {
        return importWorkUnitInspection("a".repeat(40), "https://example.test/demo.git");
      }
      return eventInspection(main.eventId);
    });
    host.vcs.listFiles = vi.fn(async () => ({
      state: main,
      repositoryId: "repository:projects/demo",
      files: [
        {
          fileId: "file:index",
          path: "index.ts",
          contentHash: sha256Hex(Buffer.from("same\n")),
          mode: 0o644,
          contentKind: "text" as const,
          byteLength: 5,
          coordinateExtent: 5,
        },
      ],
      nextCursor: null,
    }));
    const bridge = new GitBridge(host);
    const getCurrentCommit = vi
      .spyOn(bridge.git, "getCurrentCommit")
      .mockResolvedValue("a".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([commitBlob("index.ts", "same\n")]);
    const statusMatrix = vi
      .spyOn(bridge.git, "statusMatrix")
      .mockResolvedValue([["index.ts", 1, 1, 1]]);

    await expect(
      bridge.importLockedInner(repoPath, { sourceUri: "https://example.test/demo.git" })
    ).resolves.toEqual({
      contextId: expect.stringMatching(/^git-bridge-/),
      eventId: main.eventId,
      changed: false,
    });
    expect(getCurrentCommit).toHaveBeenCalledTimes(2);
    expect(statusMatrix).toHaveBeenCalledOnce();
    expect(host.vcs.resolveRepository).toHaveBeenCalledOnce();
    expect(host.vcs.resolveRepository).toHaveBeenCalledWith({ state: main, repoPath });
    expect(host.vcs.neighbors).not.toHaveBeenCalled();
    expect(host.vcs.inspect).not.toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ kind: "repository" }),
      })
    );
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("records a new import boundary when Git revision changes without a tree change", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "same\n");
    const main = { kind: "event" as const, eventId: "event:main" };
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, main.eventId));
    host.vcs.resolveRepository = vi.fn(async ({ state, repoPath: resolvedPath }) => ({
      state,
      repositoryId: `repository:${resolvedPath}`,
      repoPath: resolvedPath,
    }));
    host.vcs.inspect = vi.fn(async ({ node }) => {
      if (node.kind === "repository") return repositoryInspection(main, repoPath);
      if (node.kind === "application") return applicationInspection(node.applicationId);
      if (node.kind === "work-unit") {
        return importWorkUnitInspection("a".repeat(40), "https://example.test/owner/demo.git");
      }
      return eventInspection(main.eventId);
    });
    host.vcs.listFiles = vi.fn(async () => ({
      state: main,
      repositoryId: "repository:projects/demo",
      files: [
        {
          fileId: "file:index",
          path: "index.ts",
          contentHash: sha256Hex(Buffer.from("same\n")),
          mode: 0o644,
          contentKind: "text" as const,
          byteLength: 5,
          coordinateExtent: 5,
        },
      ],
      nextCursor: null,
    }));
    host.vcs.importSnapshot = vi.fn(async () => ({
      contextId: "ctx:import",
      eventId: "event:imported",
      workUnitId: "work:imported",
      importedRepositoryIds: ["repository:projects/demo"],
    }));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("b".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([commitBlob("index.ts", "same\n")]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([["index.ts", 1, 1, 1]]);

    await expect(
      bridge.importLockedInner(repoPath, { sourceUri: "https://example.test/owner/demo.git" })
    ).resolves.toEqual({
      contextId: expect.stringMatching(/^git-bridge-/),
      eventId: "event:imported",
      changed: true,
    });
    expect(host.vcs.importSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ snapshotRevision: "b".repeat(40) }),
      })
    );
  });

  it("refuses an inconsistent content-store receipt before semantic import", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "captured\n");
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    host.vcs.inspect = vi.fn(async () => {
      const inspected = eventInspection("event:main");
      inspected.node.value.applicationIds = [];
      return inspected;
    });
    host.blobstore.putBase64 = vi.fn(async () => ({
      digest: "0".repeat(64),
      size: 999,
    }));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("a".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob("index.ts", "captured\n"),
    ]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([["index.ts", 1, 1, 1]]);

    await expect(
      bridge.importLockedInner(repoPath, { sourceUri: "https://example.test/owner/demo.git" })
    ).rejects.toThrow(/content store integrity mismatch for index\.ts/);
    expect(host.blobstore.putBase64).toHaveBeenCalledWith(
      Buffer.from("captured\n").toString("base64")
    );
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a tracked path excluded from semantic snapshots before the no-op shortcut", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "same\n");
    writeFileSync(path.join(dir, ".env"), "SECRET=not-imported\n");
    const main = { kind: "event" as const, eventId: "event:main" };
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, main.eventId));
    host.vcs.resolveRepository = vi.fn(async ({ state, repoPath: resolvedPath }) => ({
      state,
      repositoryId: `repository:${resolvedPath}`,
      repoPath: resolvedPath,
    }));
    host.vcs.inspect = vi.fn(async () => repositoryInspection(main, repoPath));
    host.vcs.listFiles = vi.fn(async () => ({
      state: main,
      repositoryId: "repository:projects/demo",
      files: [
        {
          fileId: "file:index",
          path: "index.ts",
          contentHash: sha256Hex(Buffer.from("same\n")),
          mode: 0o644,
          contentKind: "text" as const,
          byteLength: 5,
          coordinateExtent: 5,
        },
      ],
      nextCursor: null,
    }));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("a".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob(".env", "SECRET=not-imported\n"),
      commitBlob("index.ts", "same\n"),
    ]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([
      [".env", 1, 1, 1],
      ["index.ts", 1, 1, 1],
    ]);

    await expect(bridge.importLockedInner(repoPath, {})).rejects.toThrow(
      /Git commit tracks paths excluded from the semantic snapshot \(\.env\)/
    );
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("rejects symlinks and other tracked entry kinds the semantic snapshot cannot represent", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    const bridge = new GitBridge(host);
    const statusMatrix = vi.spyOn(bridge.git, "statusMatrix");
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("a".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      {
        path: "link",
        type: "blob",
        mode: 0o120000,
        oid: "f".repeat(40),
        bytes: Buffer.from("target"),
      },
    ]);

    await expect(bridge.importLockedInner(repoPath, {})).rejects.toThrow(
      /link \(blob, mode 120000\).*only regular files and executable files are importable/
    );
    expect(statusMatrix).not.toHaveBeenCalled();
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a dirty checkout instead of importing timing-derived content", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "index.ts"), "dirty\n");
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit").mockResolvedValue("b".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob("index.ts", "committed\n"),
    ]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([["index.ts", 1, 2, 2]]);

    await expect(bridge.importLockedInner(repoPath, {})).rejects.toThrow(
      /not the exact Git HEAD tree/
    );
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("rejects when HEAD advances after the immutable revision was resolved", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, "event:main"));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit")
      .mockResolvedValueOnce("a".repeat(40))
      .mockResolvedValueOnce("b".repeat(40));
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob("index.ts", "committed\n"),
    ]);
    vi.spyOn(bridge.git, "statusMatrix").mockResolvedValue([["index.ts", 1, 1, 1]]);

    await expect(bridge.importLockedInner(repoPath, {})).rejects.toThrow(
      /Git HEAD advanced while resolving the snapshot/
    );
    expect(host.vcs.importSnapshot).not.toHaveBeenCalled();
  });

  it("exports one protected-main event snapshot and then observes it as up to date", async () => {
    const repoPath = "projects/demo";
    const dir = path.join(root, repoPath);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const main = { kind: "event" as const, eventId: "event:main" };
    const repositoryRef = {
      kind: "repository" as const,
      state: main,
      repositoryId: "repository:projects/demo",
    };
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => status(contextId, main.eventId));
    host.vcs.resolveRepository = vi.fn(async ({ state, repoPath: resolvedPath }) => ({
      state,
      repositoryId: repositoryRef.repositoryId,
      repoPath: resolvedPath,
    }));
    host.vcs.inspect = vi.fn(async ({ node }) =>
      node.kind === "repository"
        ? repositoryInspection(main, repoPath)
        : eventInspection(main.eventId)
    );
    host.vcs.listFiles = vi.fn(async () => ({
      state: main,
      repositoryId: repositoryRef.repositoryId,
      files: [
        {
          fileId: "file:index",
          path: "index.ts",
          contentHash: sha256Hex(Buffer.from("exported\n")),
          mode: 0o755,
          contentKind: "text" as const,
          byteLength: 9,
          coordinateExtent: 9,
        },
      ],
      nextCursor: null,
    }));
    host.vcs.readFile = vi.fn(async () => ({
      repositoryId: repositoryRef.repositoryId,
      fileId: "file:index",
      repoPath,
      path: "index.ts",
      contentHash: sha256Hex(Buffer.from("exported\n")),
      mode: 0o755,
      content: { kind: "text" as const, text: "exported\n" },
    }));
    const bridge = new GitBridge(host);
    vi.spyOn(bridge.git, "getCurrentCommit")
      .mockResolvedValueOnce(null)
      .mockResolvedValue("git:main");
    vi.spyOn(bridge.git, "readCommitTree").mockResolvedValue([
      commitBlob("index.ts", "exported\n", 0o100755),
    ]);
    vi.spyOn(bridge.git, "log").mockResolvedValue([
      {
        oid: "git:main",
        message: `Semantic snapshot\n\nVibestudio-Event: ${main.eventId}`,
        parentOids: [],
        author: { name: "Vibestudio", email: "vibestudio@local", timestamp: 0 },
      },
    ]);
    vi.spyOn(bridge.git, "add").mockResolvedValue(undefined);
    vi.spyOn(bridge.git, "commit").mockResolvedValue("git:main");

    await expect(bridge.exportProtectedRepository(repoPath)).resolves.toEqual({
      exported: 1,
      headCommit: "git:main",
      clobberedLocalEdits: [],
    });
    expect(readFileSync(path.join(dir, "index.ts"), "utf8")).toBe("exported\n");
    await expect(bridge.exportProtectedRepository(repoPath)).resolves.toEqual({
      exported: 0,
      headCommit: "git:main",
      clobberedLocalEdits: [],
    });
    expect(host.vcs.resolveRepository).toHaveBeenCalledTimes(2);
    expect(host.vcs.resolveRepository).toHaveBeenNthCalledWith(1, { state: main, repoPath });
    expect(host.vcs.resolveRepository).toHaveBeenNthCalledWith(2, { state: main, repoPath });
    expect(host.vcs.neighbors).not.toHaveBeenCalled();
    expect(bridge.git.commit).toHaveBeenCalledTimes(1);
  });

  it("refuses to export over an unresolved external candidate", async () => {
    const repoPath = "projects/demo";
    const { host } = baseHost(root);
    host.vcs.status = vi.fn(async ({ contextId }) => ({
      ...status(contextId, "event:main"),
      committed: { kind: "event" as const, eventId: "event:external-candidate" },
      workingHead: { kind: "event" as const, eventId: "event:external-candidate" },
      mainRelation: "ahead" as const,
    }));
    const bridge = new GitBridge(host);

    await expect(bridge.exportProtectedRepository(repoPath)).rejects.toThrow(
      /candidate event:external-candidate.*git-bridge-.*incrementally integrated/
    );
    expect(host.vcs.inspect).not.toHaveBeenCalled();
  });
});
