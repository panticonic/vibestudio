/**
 * FsService tests — context resolution, mktemp, and error-code preservation.
 *
 *  - `mktemp` creates (and returns) unique paths under `.tmp/` for atomic
 *    write patterns (write to tmp → rename into place) that pi-coding-agent's
 *    edit tool uses.
 *  - `readFile` on a missing file surfaces a `NodeJS.ErrnoException` with
 *    `err.code === "ENOENT"`. This guards the error-code preservation that
 *    pi-coding-agent's tools branch on; if the code is lost (either in
 *    FsService or in the RPC bridge), the tests fail.
 *
 * Context binding has moved upstream: WorkspaceDO is authoritative and the
 * Node-side EntityCache mirrors it. Tests insert active-entity rows directly
 * into the cache to register the panel's context.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  readFileSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsService,
  _setRipgrepPathForTests,
  type GrepResult,
  type FsVcsBridge,
  type FsVcsContent,
  type FsVcsEditOp,
} from "./fsService.js";
import { EntityCache } from "./runtime/entityCache.js";
import type { EntityKind, EntityRecord } from "./runtime/entitySpec.js";
import type { ContextFolderManager } from "./contextFolderManager.js";
import { createVerifiedCaller, type ServiceContext } from "./serviceDispatcher.js";

/**
 * Minimal ContextFolderManager stub.
 */
function makeStubFolderManager(root: string): ContextFolderManager {
  return {
    async ensureContextFolder(contextId: string): Promise<string> {
      const p = path.join(root, contextId);
      mkdirSync(p, { recursive: true });
      return p;
    },
    getContextFolderState(contextId: string) {
      const p = path.join(root, contextId);
      return existsSync(p)
        ? { status: "ready" as const, path: p }
        : { status: "missing" as const, path: p };
    },
    getContextRoot(contextId: string): string | null {
      const p = path.join(root, contextId);
      return existsSync(p) ? p : null;
    },
  } as unknown as ContextFolderManager;
}

/** Test adapter for cases that seed an already-projected managed file on disk.
 * It proves the caller constructed semantic authority without conflating these
 * sandbox tests with semantic mutation behavior, which has its own full mock. */
function makeProjectedReadBridge(root: string): FsVcsBridge {
  const unsupported = async (): Promise<never> => {
    throw new Error("semantic mutation is outside this projection-read test");
  };
  let contextId: string | null = null;
  const repoPathOf = (repositoryId: string) => repositoryId.slice("repository:".length);
  const state = () => ({ kind: "application" as const, applicationId: `application:${contextId}` });
  const repoPaths = ["skills/onboarding", "skills/system-testing"];
  const authorityPath = (repositoryId: string, filePath: string) => {
    if (!contextId) throw new Error("working state was not resolved before file lookup");
    return path.join(root, contextId, repoPathOf(repositoryId), filePath);
  };
  return {
    isTracked: async (relPath) =>
      ["packages", "panels", "projects", "agents", "skills", "workers", "extensions", "meta"].some(
        (root) => relPath === root || relPath.startsWith(`${root}/`)
      ),
    edit: unsupported,
    move: unsupported,
    copy: unsupported,
    status: async ({ contextId: requestedContextId }) => {
      contextId = requestedContextId;
      return {
        contextId,
        committed: { kind: "event", eventId: `event:${contextId}` },
        workingHead: state(),
        clean: false,
        mainEventId: "event:main",
        mainRelation: "ahead",
        workingCounts: { applications: 1, workUnits: 0, changes: 0 },
      };
    },
    neighbors: async ({ root: requestedState }) => {
      if (requestedState.kind !== "event" && requestedState.kind !== "application") {
        throw new Error("expected state root");
      }
      return {
        root: requestedState,
        edges: repoPaths.map((repoPath) => ({
          kind: "contains-repository" as const,
          from: requestedState,
          to: {
            kind: "repository" as const,
            state: requestedState,
            repositoryId: `repository:${repoPath}`,
          },
        })),
        nextCursor: null,
      };
    },
    inspect: async ({ node }) => {
      if (node.kind !== "repository") throw new Error("expected repository inspection");
      const repoPath = repoPathOf(node.repositoryId);
      return {
        root: node,
        node: {
          kind: "repository" as const,
          state: node.state,
          value: {
            kind: "present" as const,
            repositoryId: node.repositoryId,
            repoPath,
            manifestId: `manifest:${repoPath}`,
          },
        },
        edges: [],
        hasMoreEdges: false,
      };
    },
    readFile: async (input) => {
      const filePath =
        input.file.kind === "path" ? input.file.path : input.file.fileId.split("/").at(-1)!;
      const absolute = authorityPath(input.repositoryId, filePath);
      const bytes = readFileSync(absolute);
      const stat = statSync(absolute);
      return {
        repositoryId: input.repositoryId,
        repoPath: repoPathOf(input.repositoryId),
        fileId: `file:${repoPathOf(input.repositoryId)}/${filePath}`,
        path: filePath,
        content: { kind: "bytes", base64: bytes.toString("base64") },
        contentHash: `test-projection:${bytes.toString("base64")}`,
        authoredChangeId: `change:${filePath}`,
        authoredByWorkUnitId: `work:${filePath}`,
        contentClass: "internal" as const,
        externalKeys: [],
        mode: stat.mode & 0o777,
      };
    },
    listFiles: async ({ state: requestedState, repositoryId }) => {
      const repoPath = repoPathOf(repositoryId);
      const repoRoot = path.join(root, contextId!, repoPath);
      const filePath = "SKILL.md";
      const absolute = path.join(repoRoot, filePath);
      const text = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
      return {
        state: requestedState,
        repositoryId,
        files: existsSync(absolute)
          ? [
              {
                fileId: `file:${repoPath}/${filePath}`,
                path: filePath,
                contentHash: `blob:${repoPath}/${filePath}`,
                mode: 0o644,
                contentKind: "text",
                byteLength: statSync(absolute).size,
                coordinateExtent: text.length,
              },
            ]
          : [],
        nextCursor: null,
      };
    },
    ensureMaterialized: async () => {},
    isMaterialized: async () => true,
  };
}

function makeCanonicalSemanticBridge(repositoryPaths: string[]) {
  const files = new Map<string, FsVcsContent>();
  const applyCalls: Array<{ repoPath: string; edits: FsVcsEditOp[] }> = [];
  const moveCalls: import("@vibestudio/service-schemas/vcs").VcsMoveInput[] = [];
  const copyCalls: import("@vibestudio/service-schemas/vcs").VcsCopyInput[] = [];
  const readCalls: import("@vibestudio/service-schemas/vcs").VcsReadFileInput[] = [];
  const heads = new Map<string, number>();
  const repoPathOf = (repositoryId: string) => repositoryId.slice("repository:".length);
  const keyFor = (contextId: string, repoPath: string, filePath: string) =>
    `${contextId}/${repoPath}/${filePath}`;
  const contextFromState = (state: import("@vibestudio/service-schemas/vcs").VcsStateNodeRef) =>
    state.kind === "event"
      ? state.eventId.slice("event:".length)
      : state.applicationId.slice("application:".length).split(":").slice(0, -1).join(":");
  const stateFor = (contextId: string) => {
    const sequence = heads.get(contextId) ?? 0;
    return sequence === 0
      ? { kind: "event" as const, eventId: `event:${contextId}` }
      : { kind: "application" as const, applicationId: `application:${contextId}:${sequence}` };
  };
  const advance = (contextId: string) => {
    heads.set(contextId, (heads.get(contextId) ?? 0) + 1);
    return stateFor(contextId);
  };
  const fileKeyForId = (contextId: string, fileId: string) =>
    [...files.keys()].find(
      (key) =>
        key.startsWith(`${contextId}/`) && `file:${key.slice(contextId.length + 1)}` === fileId
    );
  const mutationResult = (contextId: string, commandId: string, kind: string) => ({
    commandId,
    contextId,
    workUnitId: `work:${kind}:${heads.get(contextId) ?? 0}`,
    applicationId: `application:${kind}:${heads.get(contextId) ?? 0}`,
    changeCount: 1,
    changeIds: [`change:${kind}:${heads.get(contextId) ?? 0}`],
    incorporatedChangeCount: 0,
    incorporatedChangeIds: [],
    decisionIds: [],
    workingHead: advance(contextId),
  });
  const isScratch = (rel: string) =>
    rel === ".tmp" || rel.startsWith(".tmp/") || rel === ".testkit" || rel.startsWith(".testkit/");

  const bridge: FsVcsBridge = {
    isTracked: async (rel) => rel.length > 0 && !isScratch(rel),
    ensureMaterialized: async () => {},
    isMaterialized: async () => true,
    status: async ({ contextId }) => ({
      contextId,
      committed: { kind: "event", eventId: `event:${contextId}` },
      workingHead: stateFor(contextId),
      clean: (heads.get(contextId) ?? 0) === 0,
      mainEventId: "event:main",
      mainRelation: "ahead",
      workingCounts: {
        applications: heads.get(contextId) ?? 0,
        workUnits: heads.get(contextId) ?? 0,
        changes: heads.get(contextId) ?? 0,
      },
    }),
    neighbors: async ({ root }) => {
      if (root.kind !== "event" && root.kind !== "application") {
        throw new Error("expected state root");
      }
      return {
        root,
        edges: repositoryPaths.map((repoPath) => ({
          kind: "contains-repository" as const,
          from: root,
          to: {
            kind: "repository" as const,
            state: root,
            repositoryId: `repository:${repoPath}`,
          },
        })),
        nextCursor: null,
      };
    },
    inspect: async ({ node }) => {
      if (node.kind !== "repository") throw new Error("expected repository inspection");
      const repoPath = repoPathOf(node.repositoryId);
      return {
        root: node,
        node: {
          kind: "repository" as const,
          state: node.state,
          value: {
            kind: "present" as const,
            repositoryId: node.repositoryId,
            repoPath,
            manifestId: `manifest:${repoPath}`,
          },
        },
        edges: [],
        hasMoreEdges: false,
      };
    },
    listFiles: async ({ state, repositoryId }) => {
      const contextId = contextFromState(state);
      const repoPath = repoPathOf(repositoryId);
      const prefix = `${contextId}/${repoPath}/`;
      return {
        state,
        repositoryId,
        files: [...files.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, content]) => {
            const filePath = key.slice(prefix.length);
            const byteLength =
              content.kind === "text"
                ? Buffer.byteLength(content.text)
                : Buffer.from(content.base64, "base64").byteLength;
            return {
              fileId: `file:${repoPath}/${filePath}`,
              path: filePath,
              contentHash: `blob:${repoPath}/${filePath}`,
              mode: 0o644,
              contentKind: content.kind,
              byteLength,
              coordinateExtent: content.kind === "text" ? content.text.length : byteLength,
            };
          }),
        nextCursor: null,
      };
    },
    readFile: async (input) => {
      readCalls.push(input);
      const contextId = contextFromState(input.state);
      const repoPath = repoPathOf(input.repositoryId);
      const filePath =
        input.file.kind === "path"
          ? input.file.path
          : input.file.fileId.slice(`file:${repoPath}/`.length);
      const content = files.get(keyFor(contextId, repoPath, filePath));
      if (!content) return null;
      return {
        repositoryId: input.repositoryId,
        fileId: `file:${repoPath}/${filePath}`,
        repoPath,
        path: filePath,
        contentHash: `blob:${repoPath}/${filePath}`,
        authoredChangeId: `change:${repoPath}/${filePath}`,
        authoredByWorkUnitId: `work:${repoPath}/${filePath}`,
        contentClass: "internal" as const,
        externalKeys: [],
        mode: 0o644,
        content,
      };
    },
    edit: async (input) => {
      for (const change of input.changes) {
        if (change.kind === "repository-create") {
          throw new Error("repository creation is outside this filesystem fixture");
        }
        const repoPath = repoPathOf(change.repositoryId);
        if (change.kind === "file-create") {
          files.set(keyFor(input.contextId, repoPath, change.path), change.content);
          applyCalls.push({
            repoPath,
            edits: [{ kind: "write", path: change.path, content: change.content }],
          });
          continue;
        }
        const key = fileKeyForId(input.contextId, change.fileId);
        if (!key) throw Object.assign(new Error(`missing ${change.fileId}`), { code: "ENOENT" });
        const filePath = key.slice(`${input.contextId}/${repoPath}/`.length);
        if (change.kind === "file-delete") {
          files.delete(key);
          applyCalls.push({
            repoPath,
            edits: [{ kind: "delete", path: filePath }],
          });
        } else if (change.kind === "file-mode") {
          applyCalls.push({
            repoPath,
            edits: [{ kind: "chmod", path: filePath, mode: change.mode }],
          });
        } else {
          const existingContent = files.get(key);
          const content =
            change.kind === "binary-replace"
              ? ({ kind: "bytes", base64: change.base64 } as const)
              : ({
                  kind: "text",
                  text: change.edits.reduce(
                    (text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end),
                    existingContent?.kind === "text" ? existingContent.text : ""
                  ),
                } as const);
          files.set(key, content);
          applyCalls.push({
            repoPath,
            edits: [{ kind: "write", path: filePath, content }],
          });
        }
      }
      return mutationResult(input.contextId, input.commandId, "edit");
    },
    move: async (input) => {
      moveCalls.push(input);
      for (const move of input.moves) {
        if (move.kind !== "file") throw new Error("repository moves are outside this fixture");
        const sourceKey = fileKeyForId(input.contextId, move.fileId);
        if (!sourceKey)
          throw Object.assign(new Error(`missing ${move.fileId}`), { code: "ENOENT" });
        const content = files.get(sourceKey)!;
        files.delete(sourceKey);
        files.set(
          keyFor(input.contextId, repoPathOf(move.destinationRepositoryId), move.destinationPath),
          content
        );
      }
      return mutationResult(input.contextId, input.commandId, "move");
    },
    copy: async (input) => {
      copyCalls.push(input);
      for (const copy of input.copies) {
        const sourceContextId = contextFromState(copy.source.state);
        const sourceKey = fileKeyForId(sourceContextId, copy.source.fileId);
        if (!sourceKey) throw Object.assign(new Error("missing copy source"), { code: "ENOENT" });
        files.set(
          keyFor(input.contextId, repoPathOf(copy.destination.repositoryId), copy.destination.path),
          files.get(sourceKey)!
        );
      }
      return mutationResult(input.contextId, input.commandId, "copy");
    },
  };
  return { bridge, applyCalls, moveCalls, copyCalls, readCalls, files };
}

const INTERNAL_AUTHORIZATION = {
  contextIntegrity: { class: "internal", latchEpoch: 0, externalKeys: [] },
} as unknown as NonNullable<ServiceContext["authorization"]>;

function testContext(caller: ServiceContext["caller"]): ServiceContext {
  return { caller, authorization: INTERNAL_AUTHORIZATION };
}

function makeWorkerCtx(callerId: string): ServiceContext {
  return testContext(createVerifiedCaller(callerId, "worker"));
}

function makeAppCtx(callerId: string): ServiceContext {
  return testContext(createVerifiedCaller(callerId, "app"));
}

function makeDoCtx(callerId: string): ServiceContext {
  return testContext(createVerifiedCaller(callerId, "do"));
}

function makeExtensionCtx(callerId: string): ServiceContext {
  return testContext(createVerifiedCaller(callerId, "extension"));
}

function makeShellCtx(callerId: string): ServiceContext {
  return testContext(createVerifiedCaller(callerId, "shell"));
}

function makeAgentCtx(entityId: string, contextId: string): ServiceContext {
  return {
    caller: createVerifiedCaller(`agent:${entityId}`, "agent", null, {
      entityId,
      contextId,
      channelId: "chan-1",
      agentId: `agent:${entityId}`,
    }),
    authorization: INTERNAL_AUTHORIZATION,
  };
}

describe("FsService", () => {
  let tmpRoot: string;
  let service: FsService;
  let entityCache: EntityCache;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "vibestudio-fsservice-"));
    entityCache = new EntityCache();
    service = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
      contextAuthority: { kind: "semantic", bridge: makeProjectedReadBridge(tmpRoot) },
    });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ─── Error code preservation (ENOENT) ─────────────────────────────────────
  describe("error code preservation", () => {
    it("readFile of a missing file throws an error with code=ENOENT", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-c");

      let caught: unknown;
      try {
        await service.handleCall(ctx, "readFile", ["/does-not-exist.txt"]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
    });
  });

  // ─── mktemp ───────────────────────────────────────────────────────────────
  describe("mktemp", () => {
    it("creates .tmp/ and returns a unique path on each call", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-d");

      const p1 = (await service.handleCall(ctx, "mktemp", [])) as string;
      const p2 = (await service.handleCall(ctx, "mktemp", [])) as string;
      expect(p1).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{32}$/);
      expect(p2).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{32}$/);
      expect(p1).not.toBe(p2);

      expect(existsSync(path.join(tmpRoot, "ctx-d", ".tmp"))).toBe(true);
    });

    it("honors a custom prefix", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-e");
      const p = (await service.handleCall(ctx, "mktemp", ["edit"])) as string;
      expect(p).toMatch(/^\/\.tmp\/edit-[0-9a-f]{32}$/);
    });

    it("sanitizes path separators AND leading dots in prefix to prevent `.tmp/` escape and hidden-file collisions", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-f");
      const p = (await service.handleCall(ctx, "mktemp", ["../evil"])) as string;
      expect(p).toMatch(/^\/\.tmp\/_evil-[0-9a-f]{32}$/);

      const p2 = (await service.handleCall(ctx, "mktemp", [".htaccess"])) as string;
      expect(p2).toMatch(/^\/\.tmp\/htaccess-[0-9a-f]{32}$/);

      const p3 = (await service.handleCall(ctx, "mktemp", ["..."])) as string;
      expect(p3).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{32}$/);
    });

    it("returned path can be used to writeFile (atomic-write pattern)", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-g");
      const tmp = (await service.handleCall(ctx, "mktemp", ["write"])) as string;
      await service.handleCall(ctx, "writeFile", [tmp, "atomic"]);
      await service.handleCall(ctx, "rename", [tmp, "/target.txt"]);
      const content = await service.handleCall(ctx, "readFile", ["/target.txt", "utf8"]);
      expect(content).toBe("atomic");
    });
  });

  describe("context root resolution", () => {
    it("writeFile+readFile roundtrip through the registered context", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-b");
      await service.handleCall(ctx, "writeFile", ["/hello.txt", "world"]);
      expect(existsSync(path.join(tmpRoot, "ctx-b", "hello.txt"))).toBe(true);
      const content = await service.handleCall(ctx, "readFile", ["/hello.txt", "utf8"]);
      expect(content).toBe("world");
    });

    it("writeFile creates missing parent directories for direct context writes", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-nested-write");

      await service.handleCall(ctx, "writeFile", [".vibestudio/tmp/fs-text-roundtrip.txt", "ok"]);

      expect(
        existsSync(
          path.join(tmpRoot, "ctx-nested-write", ".vibestudio", "tmp", "fs-text-roundtrip.txt")
        )
      ).toBe(true);
      await expect(
        service.handleCall(ctx, "readFile", [".vibestudio/tmp/fs-text-roundtrip.txt", "utf8"])
      ).resolves.toBe("ok");
    });

    it("appendFile creates missing parent directories for direct context writes", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-nested-append");

      await service.handleCall(ctx, "appendFile", ["/logs/roundtrip/run.log", "one\n"]);
      await service.handleCall(ctx, "appendFile", ["/logs/roundtrip/run.log", "two\n"]);

      await expect(
        service.handleCall(ctx, "readFile", ["/logs/roundtrip/run.log", "utf8"])
      ).resolves.toBe("one\ntwo\n");
    });

    it("copyFile and rename create missing destination parent directories", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-nested-move");

      await service.handleCall(ctx, "writeFile", ["/source.txt", "source"]);
      await service.handleCall(ctx, "copyFile", ["/source.txt", "/copies/a/source.txt"]);
      await expect(
        service.handleCall(ctx, "readFile", ["/copies/a/source.txt", "utf8"])
      ).resolves.toBe("source");

      await service.handleCall(ctx, "rename", ["/copies/a/source.txt", "/archive/a/source.txt"]);
      await expect(
        service.handleCall(ctx, "readFile", ["/archive/a/source.txt", "utf8"])
      ).resolves.toBe("source");
    });

    it("stat sees files that were placed on disk before the service call", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      mkdirSync(path.join(tmpRoot, "ctx-h"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-h", "greeting.txt"), "hi");

      registerContext(ctx.caller.runtime.id, "do", "ctx-h");
      const stat = (await service.handleCall(ctx, "stat", ["/greeting.txt"])) as {
        isFile: boolean;
        size: number;
      };
      expect(stat.isFile).toBe(true);
      expect(stat.size).toBe(2);
    });

    it("uses an active DO entity context instead of treating the first path argument as a server context id", async () => {
      const ctx = makeDoCtx("do:workers/agent-worker:AiChatWorker:agent-1");
      registerContext(ctx.caller.runtime.id, "do", "ctx-agent");
      mkdirSync(path.join(tmpRoot, "ctx-agent", "skills", "onboarding"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-agent", "skills", "onboarding", "SKILL.md"), "skill");

      await expect(
        service.handleCall(ctx, "access", ["/skills/onboarding/SKILL.md"])
      ).resolves.toBeUndefined();
      await expect(
        service.handleCall(ctx, "readFile", ["/skills/onboarding/SKILL.md", "utf8"])
      ).resolves.toBe("skill");
    });

    it("uses an active app entity context for app callers", async () => {
      const ctx = makeAppCtx("@workspace-apps/shell");
      registerContext(ctx.caller.runtime.id, "app", "ctx-app");

      await service.handleCall(ctx, "writeFile", ["/app.txt", "from-app"]);

      expect(existsSync(path.join(tmpRoot, "ctx-app", "app.txt"))).toBe(true);
      await expect(service.handleCall(ctx, "readFile", ["/app.txt", "utf8"])).resolves.toBe(
        "from-app"
      );
    });
  });

  describe("symlink sandboxing", () => {
    it("rejects reads through an invalid .git/objects symlink escape", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-git-invalid");
      const contextRoot = path.join(tmpRoot, "ctx-git-invalid");
      const repoGit = path.join(contextRoot, "repo", ".git");
      const externalObjects = path.join(tmpRoot, "external-objects");
      mkdirSync(path.join(externalObjects, "ab"), { recursive: true });
      writeFileSync(
        path.join(externalObjects, "ab", "cdef1234567890abcdef1234567890abcdef12"),
        "outside"
      );
      mkdirSync(repoGit, { recursive: true });
      symlinkSync(path.relative(repoGit, externalObjects), path.join(repoGit, "objects"), "dir");

      await expect(
        service.handleCall(ctx, "readFile", [
          "/repo/.git/objects/ab/cdef1234567890abcdef1234567890abcdef12",
          "utf8",
        ])
      ).rejects.toThrow(/Symlink escapes sandbox/i);
    });

    it("rejects writes through dangling symlinks whose target cannot be contained", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-dangling-link");
      const contextRoot = path.join(tmpRoot, "ctx-dangling-link");
      mkdirSync(contextRoot, { recursive: true });
      const outside = path.join(tmpRoot, "outside-created-by-link.txt");
      symlinkSync(path.relative(contextRoot, outside), path.join(contextRoot, "escape.txt"));

      await expect(service.handleCall(ctx, "writeFile", ["escape.txt", "outside"])).rejects.toThrow(
        /Dangling symlink is not allowed/i
      );
      expect(existsSync(outside)).toBe(false);
    });

    it("lets entry operations inspect, rename, and remove dangling leaf symlinks", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-dangling-entry");
      const contextRoot = path.join(tmpRoot, "ctx-dangling-entry");
      mkdirSync(contextRoot, { recursive: true });
      symlinkSync("missing-target.txt", path.join(contextRoot, "dangling-link"));

      await expect(service.handleCall(ctx, "readlink", ["dangling-link"])).resolves.toBe(
        "missing-target.txt"
      );
      await expect(service.handleCall(ctx, "lstat", ["dangling-link"])).resolves.toMatchObject({
        isSymbolicLink: true,
      });
      await expect(service.handleCall(ctx, "exists", ["dangling-link"])).resolves.toBe(false);

      await service.handleCall(ctx, "rename", ["dangling-link", "renamed-link"]);
      await expect(service.handleCall(ctx, "readlink", ["renamed-link"])).resolves.toBe(
        "missing-target.txt"
      );
      await service.handleCall(ctx, "unlink", ["renamed-link"]);
      expect(() => lstatSync(path.join(contextRoot, "renamed-link"))).toThrow();

      symlinkSync("another-missing-target.txt", path.join(contextRoot, "rm-link"));
      await service.handleCall(ctx, "rm", ["rm-link", { force: true }]);
      expect(() => lstatSync(path.join(contextRoot, "rm-link"))).toThrow();
    });

    it("creates contained scratch symlinks that every caller kind can inspect and follow", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-contained-link");

      await service.handleCall(ctx, "writeFile", ["/.tmp/target.txt", "linked"]);
      await service.handleCall(ctx, "symlink", [
        "/.tmp/target.txt",
        "/.tmp/target-link.txt",
        "file",
      ]);

      await expect(
        service.handleCall(ctx, "lstat", ["/.tmp/target-link.txt"])
      ).resolves.toMatchObject({
        isSymbolicLink: true,
      });
      await expect(service.handleCall(ctx, "readlink", ["/.tmp/target-link.txt"])).resolves.toBe(
        "target.txt"
      );
      await expect(
        service.handleCall(ctx, "readFile", ["/.tmp/target-link.txt", "utf8"])
      ).resolves.toBe("linked");
    });

    it("rejects escaping targets and managed workspace link entries", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-link-policy");

      await expect(
        service.handleCall(ctx, "symlink", ["/../../outside.txt", "/.tmp/bad-link"])
      ).rejects.toThrow(/traversal/i);
      await expect(
        service.handleCall(ctx, "symlink", ["/.tmp/target.txt", "/projects/demo/target-link.txt"])
      ).rejects.toThrow(/managed workspace/i);
    });
  });

  describe("extension callers", () => {
    it("fails loud for an extension fs call without an on-behalf-of context or host-fs capability", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/fs-test");
      const absolutePath = path.join(tmpRoot, "outside-context.txt");
      writeFileSync(absolutePath, "extension-visible");

      // Phase 3: no silent unrestricted-host-fs fallback — the call throws
      // instead of reading `/`.
      await expect(service.handleCall(ctx, "readFile", [absolutePath, "utf8"])).rejects.toThrow(
        /host-fs-access capability/i
      );
    });

    it("grants unrestricted host fs only to an extension holding the explicit host-fs capability", async () => {
      const capableService = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "scratch-only" },
        hostFsCapableExtensions: ["@workspace-extensions/fs-test"],
      });
      const ctx = makeExtensionCtx("@workspace-extensions/fs-test");
      const absolutePath = path.join(tmpRoot, "outside-context.txt");
      writeFileSync(absolutePath, "extension-visible");

      await expect(
        capableService.handleCall(ctx, "readFile", [absolutePath, "utf8"])
      ).resolves.toBe("extension-visible");
      await capableService.handleCall(ctx, "writeFile", [absolutePath, "updated"]);
      await expect(
        capableService.handleCall(ctx, "readFile", [absolutePath, "utf8"])
      ).resolves.toBe("updated");
    });

    it("binds extension fs calls to the chained caller context when present", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/file-tools");
      ctx.chainCaller = {
        callerId: "do:workers/agent-worker:AiChatWorker:agent-1",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-1",
      };
      registerContext(ctx.chainCaller.callerId, "do", "ctx-agent");
      mkdirSync(path.join(tmpRoot, "ctx-agent", "skills", "system-testing"), { recursive: true });
      writeFileSync(
        path.join(tmpRoot, "ctx-agent", "skills", "system-testing", "SKILL.md"),
        "skill"
      );

      await expect(
        service.handleCall(ctx, "readFile", ["/skills/system-testing/SKILL.md", "utf8"])
      ).resolves.toBe("skill");
      await expect(
        service.handleCall(ctx, "readFile", [path.join(tmpRoot, "outside-context.txt"), "utf8"])
      ).rejects.toThrow(/ENOENT|no such file|Path traversal/i);
    });

    it("returns the physical context root from realpath for chained extension callers", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/file-tools");
      ctx.chainCaller = {
        callerId: "do:workers/agent-worker:AiChatWorker:agent-2",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-1",
      };
      registerContext(ctx.chainCaller.callerId, "do", "ctx-realpath");
      mkdirSync(path.join(tmpRoot, "ctx-realpath"), { recursive: true });

      await expect(service.handleCall(ctx, "realpath", ["/"])).resolves.toBe(
        path.join(tmpRoot, "ctx-realpath")
      );
    });

    it("fails fast for chained extension fs calls before context materialization", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/file-tools");
      ctx.chainCaller = {
        callerId: "do:workers/agent-worker:AiChatWorker:agent-3",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-1",
      };
      registerContext(ctx.chainCaller.callerId, "do", "ctx-not-ready");

      await expect(service.handleCall(ctx, "realpath", ["/"])).rejects.toMatchObject({
        code: "ENOTREADY",
      });
    });
  });

  describe("explicit-contextId callers (shell)", () => {
    it("shell callers resolve an existing context passed as the first argument", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-shell"), { recursive: true });
      const ctx = makeShellCtx("shell-1");
      await service.handleCall(ctx, "writeFile", ["ctx-shell", "/note.txt", "from-shell"]);
      expect(existsSync(path.join(tmpRoot, "ctx-shell", "note.txt"))).toBe(true);
      await expect(
        service.handleCall(ctx, "readFile", ["ctx-shell", "/note.txt", "utf8"])
      ).resolves.toBe("from-shell");
    });

    it("accepts a contextId known only through an active entity", async () => {
      registerContext("do:src:class:entity-only", "do", "ctx-entity-only");
      const ctx = makeShellCtx("shell-1");
      await service.handleCall(ctx, "writeFile", ["ctx-entity-only", "/x.txt", "ok"]);
      expect(existsSync(path.join(tmpRoot, "ctx-entity-only", "x.txt"))).toBe(true);
    });

    it("rejects unknown contextIds for shell callers", async () => {
      await expect(
        service.handleCall(makeShellCtx("shell-1"), "readFile", ["ctx-nope", "/a.txt", "utf8"])
      ).rejects.toThrow(/Unknown contextId: ctx-nope/);
    });

    it("rejects calls without a contextId first argument", async () => {
      await expect(service.handleCall(makeShellCtx("shell-1"), "readFile", [])).rejects.toThrow(
        /must provide contextId/
      );
    });

    it("server callers may address fresh contexts (created on the fly)", async () => {
      const ctx: ServiceContext = { caller: createVerifiedCaller("server-main", "server") };
      await service.handleCall(ctx, "writeFile", ["ctx-fresh", "/s.txt", "srv"]);
      expect(existsSync(path.join(tmpRoot, "ctx-fresh", "s.txt"))).toBe(true);
    });

    it("agent callers are pinned to their host-verified binding, not a client-supplied context id", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-foreign"), { recursive: true });
      const ctx = makeAgentCtx("session-1", "ctx-agent-bound");

      await service.handleCall(ctx, "writeFile", ["ctx-foreign", "/pwned.txt", "owned"]);
      await service.handleCall(ctx, "writeFile", ["/own.txt", "ok"]);

      expect(existsSync(path.join(tmpRoot, "ctx-foreign", "pwned.txt"))).toBe(false);
      expect(existsSync(path.join(tmpRoot, "ctx-agent-bound", "ctx-foreign"))).toBe(true);
      expect(existsSync(path.join(tmpRoot, "ctx-agent-bound", "own.txt"))).toBe(true);
    });
  });

  describe("removed ownership primitive", () => {
    it("chown is not dispatchable", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-removed");
      await expect(service.handleCall(ctx, "chown", ["/a", 0, 0])).rejects.toThrow(
        /Unknown fs method: chown/
      );
    });
  });

  describe("readdir recursive", () => {
    function setupTree(contextId: string): void {
      const root = path.join(tmpRoot, contextId);
      mkdirSync(path.join(root, "sub", "deeper"), { recursive: true });
      writeFileSync(path.join(root, "top.txt"), "t");
      writeFileSync(path.join(root, "sub", "mid.txt"), "m");
      writeFileSync(path.join(root, "sub", "deeper", "leaf.txt"), "l");
    }

    it("lists nested entries with relative paths", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-rdr");
      setupTree("ctx-rdr");

      const names = (await service.handleCall(ctx, "readdir", [
        "/",
        { recursive: true },
      ])) as string[];
      expect(names.sort()).toEqual([
        "sub",
        "sub/deeper",
        "sub/deeper/leaf.txt",
        "sub/mid.txt",
        "top.txt",
      ]);
    });

    it("supports recursive withFileTypes with nested relative names", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-rdr-ft");
      setupTree("ctx-rdr-ft");

      const entries = (await service.handleCall(ctx, "readdir", [
        "/",
        { recursive: true, withFileTypes: true },
      ])) as Array<{ name: string; _isFile: boolean; _isDirectory: boolean }>;
      const leaf = entries.find((e) => e.name === "sub/deeper/leaf.txt");
      expect(leaf).toBeDefined();
      expect(leaf!._isFile).toBe(true);
      const dir = entries.find((e) => e.name === "sub/deeper");
      expect(dir).toBeDefined();
      expect(dir!._isDirectory).toBe(true);
    });

    it("non-recursive readdir is unchanged", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-rdr-flat");
      setupTree("ctx-rdr-flat");
      const names = (await service.handleCall(ctx, "readdir", ["/"])) as string[];
      expect(names.sort()).toEqual(["sub", "top.txt"]);
    });
  });

  describe("grep", () => {
    function setupSearchTree(contextId: string): string {
      const root = path.join(tmpRoot, contextId);
      mkdirSync(path.join(root, "src"), { recursive: true });
      mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
      mkdirSync(path.join(root, ".git"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "alpha.ts"),
        "line one\nneedle here\nline three\nline four\nNEEDLE again\n"
      );
      writeFileSync(path.join(root, "src", "beta.md"), "no match\nanother needle\n");
      writeFileSync(path.join(root, "node_modules", "dep", "skip.ts"), "needle in dep\n");
      writeFileSync(path.join(root, ".git", "config"), "needle in git\n");
      writeFileSync(path.join(root, "binary.bin"), Buffer.from([0x6e, 0x65, 0x00, 0x6c, 0x65]));
      return root;
    }

    afterEach(() => {
      _setRipgrepPathForTests(undefined);
    });

    for (const [mode, rgOverride] of [
      ["js fallback", null],
      ["auto-detected backend", undefined],
    ] as const) {
      describe(mode, () => {
        function withBackend(): void {
          _setRipgrepPathForTests(rgOverride);
        }

        it("finds matches with sandbox-relative paths and skips .git/node_modules/binary files", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-a");
          setupSearchTree("ctx-grep-a");
          withBackend();

          const result = (await service.handleCall(ctx, "grep", ["needle"])) as GrepResult;
          expect(result.truncated).toBe(false);
          expect(result.matchCount).toBe(2);
          const files = result.matches.map((m) => m.file).sort();
          expect(files).toEqual(["/src/alpha.ts", "/src/beta.md"]);
          const alpha = result.matches.find((m) => m.file === "/src/alpha.ts")!;
          expect(alpha.lineNumber).toBe(2);
          expect(alpha.line).toBe("needle here");
          expect(alpha.before).toEqual([]);
          expect(alpha.after).toEqual([]);
        });

        it("supports caseInsensitive and contextLines", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-b");
          setupSearchTree("ctx-grep-b");
          withBackend();

          const result = (await service.handleCall(ctx, "grep", [
            "needle",
            { path: "/src", glob: "*.ts", caseInsensitive: true, contextLines: 1 },
          ])) as GrepResult;
          expect(result.matchCount).toBe(2);
          const first = result.matches.find((m) => m.lineNumber === 2)!;
          expect(first.before).toEqual(["line one"]);
          expect(first.after).toEqual(["line three"]);
          const second = result.matches.find((m) => m.lineNumber === 5)!;
          expect(second.line).toBe("NEEDLE again");
          expect(second.before).toEqual(["line four"]);
        });

        it("truncates at maxMatches", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-c");
          const root = path.join(tmpRoot, "ctx-grep-c");
          mkdirSync(root, { recursive: true });
          writeFileSync(root + "/many.txt", Array(20).fill("needle").join("\n"));
          withBackend();

          const result = (await service.handleCall(ctx, "grep", [
            "needle",
            { maxMatches: 5 },
          ])) as GrepResult;
          expect(result.matchCount).toBe(5);
          expect(result.truncated).toBe(true);
        });

        it("filters candidate files by glob", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-d");
          setupSearchTree("ctx-grep-d");
          withBackend();

          const result = (await service.handleCall(ctx, "grep", [
            "needle",
            { glob: "*.md" },
          ])) as GrepResult;
          expect(result.matches.map((m) => m.file)).toEqual(["/src/beta.md"]);
        });
      });
    }

    it("rejects paths escaping the sandbox", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-grep-esc");
      mkdirSync(path.join(tmpRoot, "ctx-grep-esc"), { recursive: true });
      await expect(
        service.handleCall(ctx, "grep", ["needle", { path: "../other-context" }])
      ).rejects.toThrow(/Path traversal/);
    });

    it("works for shell callers with an explicit contextId", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-grep-shell"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-grep-shell", "f.txt"), "needle\n");
      const result = (await service.handleCall(makeShellCtx("shell-1"), "grep", [
        "ctx-grep-shell",
        "needle",
      ])) as GrepResult;
      expect(result.matchCount).toBe(1);
      expect(result.matches[0]!.file).toBe("/f.txt");
    });
  });

  describe("glob", () => {
    it("returns matching files sorted by mtime desc, skipping node_modules", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob");
      const root = path.join(tmpRoot, "ctx-glob");
      mkdirSync(path.join(root, "src", "deep"), { recursive: true });
      mkdirSync(path.join(root, "node_modules"), { recursive: true });
      writeFileSync(path.join(root, "src", "old.ts"), "");
      writeFileSync(path.join(root, "src", "deep", "newer.ts"), "");
      writeFileSync(path.join(root, "src", "skip.md"), "");
      writeFileSync(path.join(root, "node_modules", "dep.ts"), "");
      const now = Date.now() / 1000;
      utimesSync(path.join(root, "src", "old.ts"), now - 100, now - 100);
      utimesSync(path.join(root, "src", "deep", "newer.ts"), now, now);

      const result = (await service.handleCall(ctx, "glob", ["**/*.ts"])) as string[];
      expect(result).toEqual(["/src/deep/newer.ts", "/src/old.ts"]);
    });

    it("scopes the search to options.path", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob-scope");
      const root = path.join(tmpRoot, "ctx-glob-scope");
      mkdirSync(path.join(root, "a"), { recursive: true });
      mkdirSync(path.join(root, "b"), { recursive: true });
      writeFileSync(path.join(root, "a", "in.txt"), "");
      writeFileSync(path.join(root, "b", "out.txt"), "");

      const result = (await service.handleCall(ctx, "glob", ["*.txt", { path: "/a" }])) as string[];
      expect(result).toEqual(["/a/in.txt"]);
    });

    it("matches slash-free patterns against basenames anywhere in the tree", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob-base");
      const root = path.join(tmpRoot, "ctx-glob-base");
      mkdirSync(path.join(root, "nested"), { recursive: true });
      writeFileSync(path.join(root, "nested", "match.spec.ts"), "");

      const result = (await service.handleCall(ctx, "glob", ["*.spec.ts"])) as string[];
      expect(result).toEqual(["/nested/match.spec.ts"]);
    });
  });

  function registerContext(callerId: string, kind: EntityKind, contextId: string): void {
    const record: EntityRecord = {
      id: callerId,
      kind,
      source: { repoPath: "", effectiveVersion: "" },
      contextId,
      key: callerId,
      createdAt: Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    entityCache._onActivate(record);
  }

  describe("explicit context filesystem authority", () => {
    it("keeps scratch direct while refusing every managed path without semantic authority", async () => {
      const scratchOnly = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "scratch-only" },
      });
      const ctx = makeWorkerCtx("do:scratch-only");
      registerContext(ctx.caller.runtime.id, "do", "ctx-scratch-only");

      await scratchOnly.handleCall(ctx, "writeFile", ["/.tmp/note.txt", "scratch"]);
      await expect(
        scratchOnly.handleCall(ctx, "readFile", ["/.tmp/note.txt", "utf8"])
      ).resolves.toBe("scratch");

      mkdirSync(path.join(tmpRoot, "ctx-scratch-only", "packages", "lib"), {
        recursive: true,
      });
      writeFileSync(
        path.join(tmpRoot, "ctx-scratch-only", "packages", "lib", "projected.ts"),
        "must not leak"
      );

      for (const [method, args] of [
        ["readFile", ["/packages/lib/projected.ts", "utf8"]],
        ["realpath", ["/packages/lib/projected.ts"]],
        ["writeFile", ["/packages/lib/new.ts", "no"]],
        ["copyFile", ["/.tmp/note.txt", "/packages/lib/imported.ts"]],
        ["rename", ["/.tmp/note.txt", "/packages/lib/moved.ts"]],
        ["ensureMaterialized", ["packages/lib"]],
        ["grep", ["needle", { path: "/" }]],
      ] as const) {
        await expect(scratchOnly.handleCall(ctx, method, [...args])).rejects.toMatchObject({
          code: "ESEMANTICAUTHORITY",
        });
      }

      expect(existsSync(path.join(tmpRoot, "ctx-scratch-only", "packages", "lib", "new.ts"))).toBe(
        false
      );
      expect(
        existsSync(path.join(tmpRoot, "ctx-scratch-only", "packages", "lib", "imported.ts"))
      ).toBe(false);
    });
  });

  // ─── Semantic VCS reroute ─────────────────────────────────────────────────
  describe("semantic VCS reroute", () => {
    function makeMockBridge() {
      return makeCanonicalSemanticBridge(["panels/app", "packages/lib", "skills/x"]);
    }

    it("routes a managed write through semantic state, not raw disk", async () => {
      const { bridge, applyCalls, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-gad");

      await svc.handleCall(ctx, "writeFile", ["/panels/app/index.ts", "export const x = 1;\n"]);

      expect(applyCalls).toHaveLength(1);
      expect(applyCalls[0]!.repoPath).toBe("panels/app");
      expect(applyCalls[0]!.edits).toEqual([
        {
          kind: "write",
          path: "index.ts",
          content: { kind: "text", text: "export const x = 1;\n" },
        },
      ]);
      expect(files.get("ctx-gad/panels/app/index.ts")).toEqual({
        kind: "text",
        text: "export const x = 1;\n",
      });
      // The worktree projection was NOT written directly.
      expect(existsSync(path.join(tmpRoot, "ctx-gad", "panels", "app", "index.ts"))).toBe(false);
    });

    it("reads managed file bytes from the exact semantic state, not stale materialization", async () => {
      const { bridge, readCalls, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:semantic-read");
      registerContext(ctx.caller.runtime.id, "do", "ctx-semantic-read");

      await svc.handleCall(ctx, "writeFile", [
        "/packages/lib/authority.txt",
        "authoritative semantic bytes",
      ]);
      const projected = path.join(tmpRoot, "ctx-semantic-read", "packages", "lib", "authority.txt");
      mkdirSync(path.dirname(projected), { recursive: true });
      writeFileSync(projected, "stale projected bytes");
      expect(files.get("ctx-semantic-read/packages/lib/authority.txt")).toEqual({
        kind: "text",
        text: "authoritative semantic bytes",
      });

      const actual = await svc.handleCall(ctx, "readFile", ["/packages/lib/authority.txt", "utf8"]);
      expect(readCalls).toHaveLength(1);
      expect(actual).toBe("authoritative semantic bytes");
      expect(readCalls[0]).toMatchObject({
        state: { kind: "application", applicationId: "application:ctx-semantic-read:1" },
        repositoryId: "repository:packages/lib",
        file: { kind: "path", path: "authority.txt" },
      });
      expect(readFileSync(projected, "utf8")).toBe("stale projected bytes");
    });

    it("advances the agent context latch before managed bytes are returned", async () => {
      const { bridge } = makeMockBridge();
      const observed: Array<{
        key: string;
        via: string;
        classification: "derived";
        derivedClass: "internal" | "external";
      }> = [];
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
        recordContextIngestion: async (_ctx, input) => {
          observed.push(input);
        },
      });
      const ctx = makeAgentCtx("semantic-ingestion", "ctx-semantic-ingestion");
      registerContext(ctx.caller.runtime.id, "do", "ctx-semantic-ingestion");
      const writer = makeWorkerCtx("do:semantic-ingestion-writer");
      registerContext(writer.caller.runtime.id, "do", "ctx-semantic-ingestion");
      await svc.handleCall(writer, "writeFile", ["/packages/lib/note.txt", "remember me"]);

      await expect(
        svc.handleCall(ctx, "readFile", ["/packages/lib/note.txt", "utf8"])
      ).resolves.toBe("remember me");
      expect(observed).toEqual([
        {
          key: expect.stringMatching(
            /^file:repository%3Apackages%2Flib\/file%3Apackages%2Flib%2Fnote\.txt@/
          ),
          via: "fs-read-file",
          classification: "derived",
          derivedClass: "internal",
        },
      ]);
    });

    it("records exact semantic lineage for names and search results before returning them", async () => {
      const { bridge } = makeMockBridge();
      const observed: Array<{
        key: string;
        via: string;
        classification: "derived";
        derivedClass: "internal" | "external";
      }> = [];
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
        recordContextIngestion: async (_ctx, input) => {
          observed.push(input);
        },
      });
      const contextId = "ctx-semantic-search-ingestion";
      const agent = makeAgentCtx("semantic-search-ingestion", contextId);
      const writer = makeWorkerCtx("do:semantic-search-ingestion-writer");
      registerContext(writer.caller.runtime.id, "do", contextId);
      await svc.handleCall(writer, "writeFile", [
        "/packages/lib/match.txt",
        "needle in semantic content\n",
      ]);
      await svc.handleCall(writer, "writeFile", [
        "/packages/lib/other.txt",
        "other semantic content\n",
      ]);
      const projectedRoot = path.join(tmpRoot, contextId, "packages", "lib");
      mkdirSync(projectedRoot, { recursive: true });
      writeFileSync(path.join(projectedRoot, "match.txt"), "needle in semantic content\n");
      writeFileSync(path.join(projectedRoot, "other.txt"), "other semantic content\n");
      _setRipgrepPathForTests(null);

      await expect(svc.handleCall(agent, "readdir", ["/packages/lib"])).resolves.toEqual([
        "match.txt",
        "other.txt",
      ]);
      const listingRecords = observed.filter((entry) => entry.via === "fs-readdir");
      expect(listingRecords).toHaveLength(2);
      expect(listingRecords.map((entry) => entry.key)).toEqual([
        expect.stringContaining("match.txt@"),
        expect.stringContaining("other.txt@"),
      ]);

      const grep = (await svc.handleCall(agent, "grep", [
        "needle",
        { path: "/packages/lib" },
      ])) as GrepResult;
      expect(grep.matches.map((match) => match.file)).toEqual(["/packages/lib/match.txt"]);
      expect(observed.filter((entry) => entry.via === "fs-grep")).toEqual([
        expect.objectContaining({ key: expect.stringContaining("match.txt@") }),
      ]);

      await expect(
        svc.handleCall(agent, "glob", ["match.*", { path: "/packages/lib" }])
      ).resolves.toEqual(["/packages/lib/match.txt"]);
      expect(observed.filter((entry) => entry.via === "fs-glob")).toEqual([
        expect.objectContaining({ key: expect.stringContaining("match.txt@") }),
      ]);
    });

    it("records a managed handle's exact semantic lineage on its first byte read", async () => {
      const { bridge } = makeMockBridge();
      const observed: Array<{
        key: string;
        via: string;
        classification: "derived";
        derivedClass: "internal" | "external";
      }> = [];
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
        recordContextIngestion: async (_ctx, input) => {
          observed.push(input);
        },
      });
      const contextId = "ctx-semantic-handle-ingestion";
      const agent = makeAgentCtx("semantic-handle-ingestion", contextId);
      const writer = makeWorkerCtx("do:semantic-handle-ingestion-writer");
      registerContext(writer.caller.runtime.id, "do", contextId);
      await svc.handleCall(writer, "writeFile", ["/packages/lib/handle.txt", "semantic bytes"]);
      const projected = path.join(tmpRoot, contextId, "packages", "lib", "handle.txt");
      mkdirSync(path.dirname(projected), { recursive: true });
      writeFileSync(projected, "semantic bytes");

      const { handleId } = (await svc.handleCall(agent, "open", [
        "/packages/lib/handle.txt",
        "r",
      ])) as { handleId: number };
      expect(observed).toEqual([]);

      await svc.handleCall(agent, "handleRead", [handleId, 8, 0]);
      await svc.handleCall(agent, "handleRead", [handleId, 8, 8]);
      expect(observed).toEqual([
        {
          key: expect.stringContaining("handle.txt@"),
          via: "fs-handle-read",
          classification: "derived",
          derivedClass: "internal",
        },
      ]);
      await svc.handleCall(agent, "handleClose", [handleId]);
    });

    it("leaves scratch-path writes (.tmp) on direct disk", async () => {
      const { bridge, applyCalls } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-scratch");

      const tmp = (await svc.handleCall(ctx, "mktemp", ["edit"])) as string;
      await svc.handleCall(ctx, "writeFile", [tmp, "scratch"]);

      expect(applyCalls).toHaveLength(0);
      expect(existsSync(path.join(tmpRoot, "ctx-scratch", tmp.replace(/^\//, "")))).toBe(true);
    });

    it("rejects managed empty-directory mkdir instead of reporting nonexistent state", async () => {
      const { bridge, applyCalls } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:managed-mkdir");
      registerContext(ctx.caller.runtime.id, "do", "ctx-managed-mkdir");

      await expect(
        svc.handleCall(ctx, "mkdir", ["/packages/lib/empty", { recursive: true }])
      ).rejects.toMatchObject({ code: "ENOTSUP" });
      expect(applyCalls).toHaveLength(0);
      expect(existsSync(path.join(tmpRoot, "ctx-managed-mkdir", "packages", "lib", "empty"))).toBe(
        false
      );

      await expect(svc.handleCall(ctx, "mkdir", ["/.tmp/real", { recursive: true }])).resolves.toBe(
        "/.tmp"
      );
      expect(existsSync(path.join(tmpRoot, "ctx-managed-mkdir", ".tmp", "real"))).toBe(true);
    });

    it("routes a managed delete through semantic state", async () => {
      const { bridge, applyCalls, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-del");

      await svc.handleCall(ctx, "writeFile", ["/packages/lib/a.ts", "a"]);
      await svc.handleCall(ctx, "unlink", ["/packages/lib/a.ts"]);

      expect(files.has("ctx-del/packages/lib/a.ts")).toBe(false);
      expect(applyCalls.at(-1)!.repoPath).toBe("packages/lib");
      expect(applyCalls.at(-1)!.edits).toEqual([{ kind: "delete", path: "a.ts" }]);
    });

    it("implements managed truncate with exact byte semantics", async () => {
      const { bridge, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:truncate");
      registerContext(ctx.caller.runtime.id, "do", "ctx-truncate");

      await svc.handleCall(ctx, "writeFile", ["/packages/lib/value.txt", "aéz"]);
      await svc.handleCall(ctx, "truncate", ["/packages/lib/value.txt", 2]);
      expect(files.get("ctx-truncate/packages/lib/value.txt")).toEqual({
        kind: "bytes",
        base64: Buffer.from("aéz").subarray(0, 2).toString("base64"),
      });

      await svc.handleCall(ctx, "writeFile", ["/packages/lib/value.txt", "a"]);
      await svc.handleCall(ctx, "truncate", ["/packages/lib/value.txt", 3]);
      expect(files.get("ctx-truncate/packages/lib/value.txt")).toEqual({
        kind: "bytes",
        base64: Buffer.from([0x61, 0, 0]).toString("base64"),
      });

      await expect(
        svc.handleCall(ctx, "truncate", ["/packages/lib/missing.txt", 0])
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("routes a tracked rename through one identity-preserving move transaction", async () => {
      const { bridge, moveCalls, applyCalls, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-move");
      await svc.handleCall(ctx, "writeFile", ["/packages/lib/a.ts", "identity"]);

      await svc.handleCall(ctx, "rename", ["/packages/lib/a.ts", "/panels/app/a.ts"]);

      expect(moveCalls).toHaveLength(1);
      expect(moveCalls[0]).toMatchObject({
        contextId: "ctx-move",
        expectedWorkingHead: { kind: "application", applicationId: "application:ctx-move:1" },
        moves: [
          {
            kind: "file",
            repositoryId: "repository:packages/lib",
            fileId: "file:packages/lib/a.ts",
            destinationRepositoryId: "repository:panels/app",
            destinationPath: "a.ts",
          },
        ],
      });
      expect(applyCalls).toHaveLength(1);
      expect(files.has("ctx-move/packages/lib/a.ts")).toBe(false);
      expect(files.get("ctx-move/panels/app/a.ts")).toEqual({ kind: "text", text: "identity" });
    });

    it("routes a tracked copy through exact copy-of provenance instead of a write", async () => {
      const { bridge, copyCalls, applyCalls, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-copy");
      await svc.handleCall(ctx, "writeFile", ["/packages/lib/a.ts", "ancestry"]);

      await svc.handleCall(ctx, "copyFile", ["/packages/lib/a.ts", "/panels/app/a.ts"]);

      expect(copyCalls).toHaveLength(1);
      expect(copyCalls[0]).toMatchObject({
        contextId: "ctx-copy",
        expectedWorkingHead: { kind: "application", applicationId: "application:ctx-copy:1" },
        copies: [
          {
            source: {
              state: { kind: "application", applicationId: "application:ctx-copy:1" },
              repositoryId: "repository:packages/lib",
              fileId: "file:packages/lib/a.ts",
            },
            destination: {
              repositoryId: "repository:panels/app",
              path: "a.ts",
            },
          },
        ],
      });
      expect(applyCalls).toHaveLength(1);
      expect(files.get("ctx-copy/packages/lib/a.ts")).toEqual({ kind: "text", text: "ancestry" });
      expect(files.get("ctx-copy/panels/app/a.ts")).toEqual({ kind: "text", text: "ancestry" });
    });

    it("maps a missing managed copy source to ENOENT", async () => {
      const { bridge, copyCalls } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-copy-missing");

      await expect(
        svc.handleCall(ctx, "copyFile", ["/packages/lib/missing.ts", "/panels/app/a.ts"])
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(copyCalls).toHaveLength(0);
    });

    it("propagates exact resolver failures instead of treating them as absence", async () => {
      const { bridge, applyCalls } = makeMockBridge();
      const failure = Object.assign(new Error("semantic authority unavailable"), {
        code: "EAUTHORITY",
      });
      bridge.listFiles = async () => {
        throw failure;
      };
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-resolver-failure");

      await expect(
        svc.handleCall(ctx, "writeFile", ["/packages/lib/a.ts", "content"])
      ).rejects.toBe(failure);
      expect(applyCalls).toHaveLength(0);
    });

    it("creates a managed file from scratch bytes through one semantic edit", async () => {
      const { bridge, applyCalls, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-import");

      await svc.handleCall(ctx, "writeFile", ["/.tmp/external.ts", "external\n"]);
      await svc.handleCall(ctx, "copyFile", ["/.tmp/external.ts", "/packages/lib/external.ts"]);

      expect(applyCalls).toEqual([
        {
          repoPath: "packages/lib",
          edits: [
            {
              kind: "write",
              path: "external.ts",
              content: { kind: "bytes", base64: Buffer.from("external\n").toString("base64") },
            },
          ],
        },
      ]);
      expect(files.get("ctx-import/packages/lib/external.ts")).toEqual({
        kind: "bytes",
        base64: Buffer.from("external\n").toString("base64"),
      });
    });

    it("unlinks a scratch symlink entry without deleting its managed target", async () => {
      const { bridge, applyCalls, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-link-delete");

      await svc.handleCall(ctx, "writeFile", ["/packages/lib/a.ts", "tracked"]);
      const root = path.join(tmpRoot, "ctx-link-delete");
      mkdirSync(path.join(root, ".tmp"), { recursive: true });
      symlinkSync("../packages/lib/a.ts", path.join(root, ".tmp", "tracked-link"));

      await svc.handleCall(ctx, "unlink", ["/.tmp/tracked-link"]);

      expect(files.get("ctx-link-delete/packages/lib/a.ts")).toEqual({
        kind: "text",
        text: "tracked",
      });
      expect(applyCalls).toHaveLength(1);
      expect(() => lstatSync(path.join(root, ".tmp", "tracked-link"))).toThrow();
    });

    it("keeps disk-only leaf symlinks out of semantic delete routing", async () => {
      const { bridge, applyCalls } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-tracked-links");
      const repoRoot = path.join(tmpRoot, "ctx-tracked-links", "packages", "lib");
      mkdirSync(path.join(repoRoot, "target-dir"), { recursive: true });
      writeFileSync(path.join(repoRoot, "target.txt"), "projection");
      symlinkSync("target.txt", path.join(repoRoot, "unlink-link"));
      symlinkSync("target.txt", path.join(repoRoot, "rm-link"));
      symlinkSync("target-dir", path.join(repoRoot, "rmdir-link"), "dir");

      await svc.handleCall(ctx, "unlink", ["/packages/lib/unlink-link"]);
      await svc.handleCall(ctx, "rm", ["/packages/lib/rm-link", { recursive: true }]);
      await expect(
        svc.handleCall(ctx, "rmdir", ["/packages/lib/rmdir-link"])
      ).rejects.toMatchObject({ code: "ENOTDIR" });

      expect(existsSync(path.join(repoRoot, "target.txt"))).toBe(true);
      expect(existsSync(path.join(repoRoot, "target-dir"))).toBe(true);
      expect(lstatSync(path.join(repoRoot, "rmdir-link")).isSymbolicLink()).toBe(true);
      expect(applyCalls).toHaveLength(0);
    });

    it("rejects renaming a symlink entry into a tracked destination", async () => {
      const { bridge, applyCalls } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-link-rename");
      const root = path.join(tmpRoot, "ctx-link-rename");
      mkdirSync(path.join(root, ".tmp"), { recursive: true });
      symlinkSync("missing-target", path.join(root, ".tmp", "source-link"));

      await expect(
        svc.handleCall(ctx, "rename", ["/.tmp/source-link", "/packages/lib/link"])
      ).rejects.toThrow(/cannot move or replace a symbolic link.*managed destination/s);

      expect(lstatSync(path.join(root, ".tmp", "source-link")).isSymbolicLink()).toBe(true);
      expect(applyCalls).toHaveLength(0);
    });

    it("directly renames a disk-only symlink from a malformed reserved path to scratch", async () => {
      const { bridge, applyCalls } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-reserved-link-rename");
      const root = path.join(tmpRoot, "ctx-reserved-link-rename");
      mkdirSync(path.join(root, "agents", "legacy"), { recursive: true });
      mkdirSync(path.join(root, ".tmp"), { recursive: true });
      symlinkSync("missing-target", path.join(root, "agents", "legacy", "source-link"));

      await svc.handleCall(ctx, "rename", ["/agents/legacy/source-link", "/.tmp/moved-link"]);

      expect(() => lstatSync(path.join(root, "agents", "legacy", "source-link"))).toThrow();
      expect(lstatSync(path.join(root, ".tmp", "moved-link")).isSymbolicLink()).toBe(true);
      expect(applyCalls).toHaveLength(0);
    });

    it("refuses scratch-to-managed rename because replacement uses an exact semantic edit", async () => {
      const { bridge, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-atomic");

      const tmp = (await svc.handleCall(ctx, "mktemp", ["w"])) as string;
      await svc.handleCall(ctx, "writeFile", [tmp, "final\n"]);
      await expect(svc.handleCall(ctx, "rename", [tmp, "/skills/x/SKILL.md"])).rejects.toThrow(
        /cannot infer managed replacement intent/
      );

      expect(files.has("ctx-atomic/skills/x/SKILL.md")).toBe(false);
      expect(existsSync(path.join(tmpRoot, "ctx-atomic", tmp.replace(/^\//, "")))).toBe(true);
    });

    it("rejects opening a managed path for writing", async () => {
      const { bridge } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-open");

      await expect(svc.handleCall(ctx, "open", ["/panels/app/index.ts", "w"])).rejects.toThrow(
        /must use the write\/edit tool or vcs\.edit/
      );
    });

    // ─── Per-repo edit routing (section taxonomy) ─────────────────────────
    function makeRoutedBridge() {
      const fixture = makeCanonicalSemanticBridge([
        "packages/lib",
        "projects/scratch",
        "projects/missing",
        "projects/file-roundtrip-test",
        "meta",
      ]);
      return {
        bridge: fixture.bridge,
        applyCalls: fixture.applyCalls,
        files: fixture.files,
      };
    }

    it("routes a write to its owning repository identity and exact working state", async () => {
      const { bridge, applyCalls, files } = makeRoutedBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-r");

      await svc.handleCall(ctx, "writeFile", ["/packages/lib/src/x.ts", "x\n"]);

      expect(applyCalls).toHaveLength(1);
      expect(applyCalls[0]!.repoPath).toBe("packages/lib");
      expect(applyCalls[0]!.edits).toEqual([
        { kind: "write", path: "src/x.ts", content: { kind: "text", text: "x\n" } },
      ]);
      expect(files.get("ctx-r/packages/lib/src/x.ts")).toEqual({ kind: "text", text: "x\n" });
    });

    it("keeps ordinary relative root write/rename/copy operations on context-local scratch disk", async () => {
      const { bridge, applyCalls } = makeRoutedBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-root-scratch");

      const source = ".fs-copy-rename-source.txt";
      const renamed = ".fs-copy-rename-renamed.txt";
      const copied = ".fs-copy-rename-copied.txt";
      const expected = "root scratch content\n";

      await svc.handleCall(ctx, "writeFile", [source, expected]);
      await svc.handleCall(ctx, "rename", [source, renamed]);

      await expect(svc.handleCall(ctx, "exists", [source])).resolves.toBe(false);
      await expect(svc.handleCall(ctx, "exists", [renamed])).resolves.toBe(true);
      await expect(svc.handleCall(ctx, "readFile", [renamed, "utf8"])).resolves.toBe(expected);

      await svc.handleCall(ctx, "copyFile", [renamed, copied]);

      await expect(svc.handleCall(ctx, "exists", [copied])).resolves.toBe(true);
      await expect(svc.handleCall(ctx, "readFile", [copied, "utf8"])).resolves.toBe(expected);
      expect(applyCalls).toHaveLength(0);
    });

    it("rejects malformed paths beneath reserved workspace source roots", async () => {
      const { bridge, applyCalls } = makeRoutedBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-reserved-root");

      for (const target of ["/packages", "/agents/legacy/file.ts"]) {
        await expect(svc.handleCall(ctx, "writeFile", [target, "nope"])).rejects.toThrow(
          /reserved workspace source root/
        );
      }
      expect(applyCalls).toHaveLength(0);
    });

    it("routes in-sandbox symlink aliases to the canonical workspace repo", async () => {
      const { bridge, applyCalls } = makeRoutedBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-repo-alias");

      const root = path.join(tmpRoot, "ctx-repo-alias");
      mkdirSync(path.join(root, "packages", "lib"), { recursive: true });
      symlinkSync("packages", path.join(root, "source-alias"), "dir");

      await svc.handleCall(ctx, "writeFile", ["source-alias/lib/src/x.ts", "x\n"]);
      await svc.handleCall(ctx, "unlink", ["source-alias/lib/src/x.ts"]);

      expect(applyCalls).toEqual([
        {
          repoPath: "packages/lib",
          edits: [{ kind: "write", path: "src/x.ts", content: { kind: "text", text: "x\n" } }],
        },
        {
          repoPath: "packages/lib",
          edits: [{ kind: "delete", path: "src/x.ts" }],
        },
      ]);
      expect(existsSync(path.join(root, "packages", "lib", "src", "x.ts"))).toBe(false);
    });

    it("rejects non-canonical workspace source-root casing", async () => {
      const { bridge, applyCalls } = makeRoutedBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-source-case");

      await expect(
        svc.handleCall(ctx, "writeFile", ["Packages/lib/src/x.ts", "nope"])
      ).rejects.toThrow(/non-canonical casing.*packages/);
      expect(applyCalls).toHaveLength(0);
    });

    it("rejects writes that name a workspace repo root instead of a file inside it", async () => {
      const { bridge, applyCalls } = makeRoutedBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-root");

      await expect(svc.handleCall(ctx, "writeFile", ["/projects/scratch", "nope"])).rejects.toThrow(
        /names a workspace repo root.*projects\/scratch\/README\.md/s
      );
      expect(applyCalls).toHaveLength(0);
    });

    it("preserves fs.rm force semantics for a missing tracked file", async () => {
      const { bridge, applyCalls } = makeRoutedBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-rm-force");

      await expect(
        svc.handleCall(ctx, "rm", ["/meta/tmp-fs-copy-rename/source.txt", { force: true }])
      ).resolves.toBeUndefined();
      expect(applyCalls).toHaveLength(0);
    });

    it("preserves recursive fs.rm force semantics for a missing tracked subtree", async () => {
      const { bridge, applyCalls } = makeRoutedBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-rm-force-recursive");

      await expect(
        svc.handleCall(ctx, "rm", ["/projects/missing/tree", { recursive: true, force: true }])
      ).resolves.toBeUndefined();
      expect(applyCalls).toHaveLength(0);
    });

    it("canonicalizes a dotted project filename into a repo-shaped path", async () => {
      const { bridge, applyCalls } = makeRoutedBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-dotted");

      await expect(
        svc.handleCall(ctx, "writeFile", ["/projects/file-roundtrip-test.txt", "ok"])
      ).resolves.toBeUndefined();
      expect(applyCalls).toEqual([
        expect.objectContaining({
          repoPath: "projects/file-roundtrip-test",
          edits: [
            {
              kind: "write",
              path: "file-roundtrip-test.txt",
              content: { kind: "text", text: "ok" },
            },
          ],
        }),
      ]);
    });
  });

  describe("exact context projection (demand + loud assertion)", () => {
    function makeMaterializeBridge(opts: { materialize: boolean }) {
      const calls: Array<{ contextId: string; repos: string[] | "all" }> = [];
      const present = new Set<string>();
      const bridge = makeCanonicalSemanticBridge(["packages/lib", "panels/foo"]).bridge;
      bridge.ensureMaterialized = async (contextId, repos) => {
        calls.push({ contextId, repos });
        if (!opts.materialize) return;
        if (repos === "all") present.add("*");
        else for (const repo of repos) present.add(repo);
      };
      bridge.isMaterialized = async (_contextId, repo) => present.has("*") || present.has(repo);
      return { bridge, calls };
    }

    it("does not materialize platform scratch paths before direct reads", async () => {
      const { bridge, calls } = makeMaterializeBridge({ materialize: true });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-scratch-read");

      await svc.handleCall(ctx, "writeFile", [".vibestudio/tmp/text-round-trip.txt", "ok"]);

      await expect(
        svc.handleCall(ctx, "readFile", [".vibestudio/tmp/text-round-trip.txt", "utf8"])
      ).resolves.toBe("ok");
      expect(calls).toEqual([]);
    });

    it("keeps fs.mktemp paths usable for read/stat/exists with a VCS bridge installed", async () => {
      const { bridge, calls } = makeMaterializeBridge({ materialize: true });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-mktemp-read");

      const tmp = (await svc.handleCall(ctx, "mktemp", ["stats"])) as string;
      await svc.handleCall(ctx, "writeFile", [tmp, "scratch"]);

      await expect(svc.handleCall(ctx, "readFile", [tmp, "utf8"])).resolves.toBe("scratch");
      await expect(svc.handleCall(ctx, "exists", [tmp])).resolves.toBe(true);
      await expect(svc.handleCall(ctx, "stat", [tmp])).resolves.toMatchObject({ size: 7 });
      expect(calls).toEqual([]);
    });

    it("a read demands ONLY the target path's repo (minimal scope, not 'all')", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-s", "packages", "lib"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-s", "packages", "lib", "x.ts"), "x\n");
      const { bridge, calls } = makeMaterializeBridge({ materialize: true });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-s");

      await svc.handleCall(ctx, "readdir", ["/packages/lib"]);

      // Exactly the one repo was demanded — never "all".
      expect(calls).toEqual([{ contextId: "ctx-s", repos: ["packages/lib"] }]);
    });

    it("a read whose repo stays unmaterialized surfaces a natural ENOENT (not silent-partial)", async () => {
      // A bridge that declines to materialize — simulates a non-existent repo
      // (nothing to project) or a consumer/path that slipped past demand. Every
      // context may read any repo (no read confinement), so an existing repo is
      // always materialized by the preceding ensureMaterialized; reaching here
      // means there is no subtree on disk. The read must NOT silently return
      // empty/partial data — it falls through to the underlying fs op's natural
      // result, which for a missing dir is ENOENT (the code callers handle),
      // rather than a bespoke ENOMATERIALIZE that breaks them.
      const { bridge } = makeMaterializeBridge({ materialize: false });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-s2");

      await expect(svc.handleCall(ctx, "readdir", ["/packages/lib"])).rejects.toThrow(/ENOENT/);
    });

    it("a root grep demands 'all' (the only legitimate blanket case)", async () => {
      const { bridge, calls } = makeMaterializeBridge({ materialize: true });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-s3");

      await svc.handleCall(ctx, "grep", ["needle", { path: "/" }]).catch(() => {});

      expect(calls.some((c) => c.repos === "all")).toBe(true);
    });

    it("a scoped glob demands ONLY options.path's repo, not 'all'", async () => {
      // glob(pattern, opts): the search dir is opts.path on args[1] — NOT the pattern
      // string on args[0]. Reading args[0].path always missed → every glob fell back
      // to "/" → "all" (whole-workspace materialize).
      mkdirSync(path.join(tmpRoot, "ctx-glob-demand", "panels", "foo"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-glob-demand", "panels", "foo", "a.ts"), "x\n");
      const { bridge, calls } = makeMaterializeBridge({ materialize: true });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob-demand");

      await svc.handleCall(ctx, "glob", ["*.ts", { path: "panels/foo" }]);

      expect(calls).toEqual([{ contextId: "ctx-glob-demand", repos: ["panels/foo"] }]);
    });

    it("ensureMaterialized RPC declares a narrow scope (a single repo)", async () => {
      const { bridge, calls } = makeMaterializeBridge({ materialize: true });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-s4");

      await svc.handleCall(ctx, "ensureMaterialized", ["panels/chat/index.tsx"]);

      expect(calls).toEqual([{ contextId: "ctx-s4", repos: ["panels/chat"] }]);
    });

    it("ensureMaterialized RPC ignores direct-disk scratch paths", async () => {
      const { bridge, calls } = makeMaterializeBridge({ materialize: true });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-s5");

      await svc.handleCall(ctx, "ensureMaterialized", [".tmp/file.txt"]);

      expect(calls).toEqual([]);
    });
  });
});
