import { rgPath as bundledRipgrepPath } from "@vscode/ripgrep";
import { FsDisk, _setRipgrepPathForTests } from "./fsDisk.js";
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
  type GrepResult,
  type GlobResult,
  type FsVcsBridge,
  type FsVcsContent,
  type FsVcsEditOp,
} from "./fsService.js";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityKind, EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { ContextFolderManager } from "@vibestudio/shared/contextFolderManager";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";

/**
 * Minimal ContextFolderManager stub.
 */
function makeStubFolderManager(root: string): ContextFolderManager {
  return {
    async ensureContextScratch(contextId: string): Promise<string> {
      const scratch = path.join(root, `${contextId}-scratch`);
      mkdirSync(scratch, { recursive: true });
      return scratch;
    },
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
        integrating: [],
      };
    },
    resolveRepository: async ({ state: requestedState, repoPath }) =>
      repoPaths.includes(repoPath)
        ? {
            state: requestedState,
            repositoryId: `repository:${repoPath}`,
            repoPath,
          }
        : null,
    listDirectory: async ({ state: requestedState, path: directoryPath }) => {
      const prefix = directoryPath ? `${directoryPath}/` : "";
      const entries = new Map<string, (typeof repoPaths)[number]>();
      for (const repoPath of repoPaths) {
        if (!repoPath.startsWith(prefix)) continue;
        const name = repoPath.slice(prefix.length).split("/")[0]!;
        entries.set(name, repoPath);
      }
      return {
        state: requestedState,
        path: directoryPath,
        entries: [...entries.entries()].map(([name, repoPath]) => ({
          name,
          path: prefix + name,
          kind: "directory" as const,
          identity: `directory:${prefix}${name}`,
          repositoryId: `repository:${repoPath}`,
          repositoryRoot: prefix + name === repoPath,
          fileId: null,
          lineage: {
            authoredChangeId: null,
            authoredByWorkUnitId: `work:${repoPath}`,
            contentClass: "internal" as const,
            externalKeys: [],
          },
        })),
        nextCursor: null,
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
                authoredChangeId: `change:${filePath}`,
                authoredByWorkUnitId: `work:${filePath}`,
                contentClass: "internal" as const,
                externalKeys: [],
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

function makeCanonicalSemanticBridge(
  repositoryPaths: string[],
  lineage: { contentClass: "internal" | "external"; externalKeys: string[] } = {
    contentClass: "internal",
    externalKeys: [],
  }
) {
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
      integrating: [],
    }),
    resolveRepository: async ({ state, repoPath }) =>
      repositoryPaths.includes(repoPath)
        ? { state, repositoryId: `repository:${repoPath}`, repoPath }
        : null,
    listDirectory: async ({ state, path: directoryPath }) => {
      const contextId = contextFromState(state);
      const prefix = directoryPath ? `${directoryPath}/` : "";
      const containingRepo = [...repositoryPaths]
        .filter(
          (repoPath) => directoryPath === repoPath || directoryPath.startsWith(`${repoPath}/`)
        )
        .sort((left, right) => right.length - left.length)[0];
      if (containingRepo) {
        const repoRelative =
          directoryPath === containingRepo ? "" : directoryPath.slice(containingRepo.length + 1);
        const filePrefix = `${contextId}/${containingRepo}/${repoRelative ? `${repoRelative}/` : ""}`;
        const visible = new Map<string, { filePath: string; file: boolean }>();
        for (const key of files.keys()) {
          if (!key.startsWith(filePrefix)) continue;
          const filePath = key.slice(`${contextId}/${containingRepo}/`.length);
          const remainder = key.slice(filePrefix.length);
          const name = remainder.split("/")[0]!;
          visible.set(name, { filePath, file: !remainder.includes("/") });
        }
        if (visible.size === 0 && directoryPath !== containingRepo) return null;
        return {
          state,
          path: directoryPath,
          entries: [...visible.entries()].map(([name, visibleEntry]) => ({
            name,
            path: `${prefix}${name}`,
            kind: visibleEntry.file ? ("file" as const) : ("directory" as const),
            identity: visibleEntry.file
              ? `file:${containingRepo}/${visibleEntry.filePath}`
              : `directory:${prefix}${name}`,
            repositoryId: `repository:${containingRepo}`,
            repositoryRoot: false,
            fileId: visibleEntry.file ? `file:${containingRepo}/${visibleEntry.filePath}` : null,
            lineage: {
              authoredChangeId: `change:${containingRepo}/${visibleEntry.filePath}`,
              authoredByWorkUnitId: `work:${containingRepo}/${visibleEntry.filePath}`,
              contentClass: lineage.contentClass,
              externalKeys: lineage.externalKeys,
            },
          })),
          nextCursor: null,
        };
      }
      const entries = new Map<string, string>();
      for (const repoPath of repositoryPaths) {
        if (!repoPath.startsWith(prefix)) continue;
        const name = repoPath.slice(prefix.length).split("/")[0]!;
        entries.set(name, repoPath);
      }
      if (entries.size === 0 && directoryPath !== "") return null;
      return {
        state,
        path: directoryPath,
        entries: [...entries.entries()].map(([name, repoPath]) => ({
          name,
          path: `${prefix}${name}`,
          kind: "directory" as const,
          identity: `directory:${prefix}${name}`,
          repositoryId: `repository:${repoPath}`,
          repositoryRoot: `${prefix}${name}` === repoPath,
          fileId: null,
          lineage: {
            authoredChangeId: null,
            authoredByWorkUnitId: `work:${repoPath}`,
            contentClass: lineage.contentClass,
            externalKeys: lineage.externalKeys,
          },
        })),
        nextCursor: null,
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
              authoredChangeId: `change:${repoPath}/${filePath}`,
              authoredByWorkUnitId: `work:${repoPath}/${filePath}`,
              contentClass: lineage.contentClass,
              externalKeys: lineage.externalKeys,
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
        contentClass: lineage.contentClass,
        externalKeys: lineage.externalKeys,
        mode: 0o644,
        content,
      };
    },
    edit: async (input) => {
      for (const change of input.changes) {
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

const INTERNAL_AUTHORIZATION = {} as unknown as NonNullable<ServiceContext["authorization"]>;

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
      disk: new FsDisk(bundledRipgrepPath),
      contextAuthority: { kind: "semantic", bridge: makeProjectedReadBridge(tmpRoot) },
    });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reports scope and directory-operation phases without exposing path contents", async () => {
    const telemetry: Array<{ method: string; phase: string; contextId?: string }> = [];
    const observed = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
      disk: new FsDisk(bundledRipgrepPath),
      contextAuthority: { kind: "scratch-only" },
      onTelemetry: (event) => telemetry.push(event),
    });
    const ctx = makeWorkerCtx("do:src:class:telemetry");
    registerContext(ctx.caller.runtime.id, "do", "ctx-telemetry");
    mkdirSync(path.join(tmpRoot, "ctx-telemetry-scratch", ".tmp"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "ctx-telemetry-scratch", ".tmp", "entry.txt"), "ready");

    await expect(observed.handleCall(ctx, "readdir", [".tmp"])).resolves.toEqual(["entry.txt"]);

    expect(telemetry).toEqual([
      expect.objectContaining({ method: "readdir", phase: "scope", contextId: "ctx-telemetry" }),
      expect.objectContaining({
        method: "readdir",
        phase: "operation",
        contextId: "ctx-telemetry",
      }),
    ]);
    expect(JSON.stringify(telemetry)).not.toContain("entry.txt");
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

  describe("bounded text reads", () => {
    it("streams only the requested line range with exact UTF-16 coordinates and continuation", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-read-text");
      const root = path.join(tmpRoot, "ctx-read-text-scratch");
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "value.txt"), "one\n🙂two\nthree");

      await expect(
        service.handleCall(ctx, "readText", ["/value.txt", { offset: 2, limit: 1, maxBytes: 100 }])
      ).resolves.toMatchObject({
        text: "🙂two",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        totalLines: 3,
        totalBytes: Buffer.byteLength("one\n🙂two\nthree"),
        startLine: 2,
        endLine: 2,
        start: 4,
        end: 9,
        truncated: true,
        truncatedBy: "lines",
        nextOffset: 3,
        firstLineExceedsLimit: false,
      });
    });

    it("does not return a partial UTF-8 line when the byte budget is too small", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-read-text-long");
      const root = path.join(tmpRoot, "ctx-read-text-long-scratch");
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "value.txt"), "🙂🙂🙂\nnext");

      await expect(
        service.handleCall(ctx, "readText", ["/value.txt", { maxBytes: 5 }])
      ).resolves.toMatchObject({
        text: "",
        startLine: 1,
        endLine: 0,
        truncated: true,
        truncatedBy: "bytes",
        nextOffset: 2,
        firstLineExceedsLimit: true,
      });
    });

    it("rejects an already-cancelled bounded read", async () => {
      const base = makeWorkerCtx("do:src:class:key");
      registerContext(base.caller.runtime.id, "do", "ctx-read-text-cancel");
      const root = path.join(tmpRoot, "ctx-read-text-cancel-scratch");
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "value.txt"), "text");
      const controller = new AbortController();
      controller.abort(new Error("read cancelled"));

      await expect(
        service.handleCall({ ...base, signal: controller.signal }, "readText", ["/value.txt"])
      ).rejects.toThrow("read cancelled");
    });
  });

  describe("bounded binary reads", () => {
    it("streams an exact byte range with a complete-file hash and continuation", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-read-bytes");
      const root = path.join(tmpRoot, "ctx-read-bytes-scratch");
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "value.bin"), Buffer.from([0, 255, 1, 254, 2, 253]));

      await expect(
        service.handleCall(ctx, "readBytes", ["/value.bin", { offset: 1, limit: 3 }])
      ).resolves.toEqual({
        base64: Buffer.from([255, 1, 254]).toString("base64"),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        totalBytes: 6,
        maxBytes: 3,
        start: 1,
        end: 4,
        truncated: true,
        nextOffset: 4,
      });
    });

    it("returns an empty terminal range when the byte offset is past EOF", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-read-bytes-eof");
      const root = path.join(tmpRoot, "ctx-read-bytes-eof-scratch");
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "value.bin"), Buffer.from([1, 2]));

      await expect(
        service.handleCall(ctx, "readBytes", ["/value.bin", { offset: 20, limit: 3 }])
      ).resolves.toMatchObject({
        base64: "",
        totalBytes: 2,
        start: 2,
        end: 2,
        truncated: false,
      });
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

      expect(existsSync(path.join(tmpRoot, "ctx-d-scratch", ".tmp"))).toBe(true);
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
      expect(existsSync(path.join(tmpRoot, "ctx-b-scratch", "hello.txt"))).toBe(true);
      const content = await service.handleCall(ctx, "readFile", ["/hello.txt", "utf8"]);
      expect(content).toBe("world");
    });

    it("writeFile creates missing parent directories for direct context writes", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-nested-write");

      await service.handleCall(ctx, "writeFile", [".vibestudio/tmp/fs-text-roundtrip.txt", "ok"]);

      expect(
        existsSync(
          path.join(
            tmpRoot,
            "ctx-nested-write-scratch",
            ".vibestudio",
            "tmp",
            "fs-text-roundtrip.txt"
          )
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
      mkdirSync(path.join(tmpRoot, "ctx-h-scratch"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-h-scratch", "greeting.txt"), "hi");

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

      expect(existsSync(path.join(tmpRoot, "ctx-app-scratch", "app.txt"))).toBe(true);
      await expect(service.handleCall(ctx, "readFile", ["/app.txt", "utf8"])).resolves.toBe(
        "from-app"
      );
    });
  });

  describe("symlink sandboxing", () => {
    it("rejects reads through an invalid .git/objects symlink escape", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-git-invalid");
      const contextRoot = path.join(tmpRoot, "ctx-git-invalid-scratch");
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
      const contextRoot = path.join(tmpRoot, "ctx-dangling-link-scratch");
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
      const contextRoot = path.join(tmpRoot, "ctx-dangling-entry-scratch");
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
    it("rejects host reads and writes from an extension without an on-behalf-of context", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/fs-test");
      const absolutePath = path.join(tmpRoot, "outside-context.txt");
      writeFileSync(absolutePath, "extension-visible");

      await expect(service.handleCall(ctx, "readFile", [absolutePath, "utf8"])).rejects.toThrow(
        /on-behalf-of context/i
      );
      await expect(service.handleCall(ctx, "writeFile", [absolutePath, "changed"])).rejects.toThrow(
        /on-behalf-of context/i
      );
      expect(readFileSync(absolutePath, "utf8")).toBe("extension-visible");
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

    it("returns explicit source and scratch roots for chained extension callers", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/file-tools");
      ctx.chainCaller = {
        callerId: "do:workers/agent-worker:AiChatWorker:agent-2",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-1",
      };
      registerContext(ctx.chainCaller.callerId, "do", "ctx-realpath");
      mkdirSync(path.join(tmpRoot, "ctx-realpath"), { recursive: true });

      await expect(service.handleCall(ctx, "nativeRoots", [])).resolves.toEqual({
        source: path.join(tmpRoot, "ctx-realpath"),
        scratch: path.join(tmpRoot, "ctx-realpath-scratch"),
      });
      await expect(service.handleCall(ctx, "realpath", ["/"])).rejects.toMatchObject({
        code: "ENOTSUP",
      });
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
      expect(existsSync(path.join(tmpRoot, "ctx-shell-scratch", "note.txt"))).toBe(true);
      await expect(
        service.handleCall(ctx, "readFile", ["ctx-shell", "/note.txt", "utf8"])
      ).resolves.toBe("from-shell");
    });

    it("accepts a contextId known only through an active entity", async () => {
      registerContext("do:src:class:entity-only", "do", "ctx-entity-only");
      const ctx = makeShellCtx("shell-1");
      await service.handleCall(ctx, "writeFile", ["ctx-entity-only", "/x.txt", "ok"]);
      expect(existsSync(path.join(tmpRoot, "ctx-entity-only-scratch", "x.txt"))).toBe(true);
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
      expect(existsSync(path.join(tmpRoot, "ctx-fresh-scratch", "s.txt"))).toBe(true);
    });

    it("agent callers are pinned to their host-verified binding, not a client-supplied context id", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-foreign"), { recursive: true });
      const ctx = makeAgentCtx("session-1", "ctx-agent-bound");

      await service.handleCall(ctx, "writeFile", ["ctx-foreign", "/pwned.txt", "owned"]);
      await service.handleCall(ctx, "writeFile", ["/own.txt", "ok"]);

      expect(existsSync(path.join(tmpRoot, "ctx-foreign", "pwned.txt"))).toBe(false);
      expect(existsSync(path.join(tmpRoot, "ctx-agent-bound-scratch", "ctx-foreign"))).toBe(true);
      expect(existsSync(path.join(tmpRoot, "ctx-agent-bound-scratch", "own.txt"))).toBe(true);
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
      const root = path.join(tmpRoot, `${contextId}-scratch`);
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
      expect(names.sort()).toEqual(["skills", "sub", "top.txt"]);
    });
  });

  describe("grep", () => {
    function setupSearchTree(contextId: string): string {
      const root = path.join(tmpRoot, `${contextId}-scratch`);
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

    for (const [mode, rgOverride] of [["bundled ripgrep", undefined]] as const) {
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

        it("accepts useful context ranges while bounding aggregate result lines", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-context-range");
          const root = path.join(tmpRoot, "ctx-grep-context-range-scratch");
          mkdirSync(root, { recursive: true });
          writeFileSync(
            path.join(root, "context.txt"),
            Array.from({ length: 61 }, (_, index) =>
              index === 30 ? "needle" : `line ${index + 1}`
            ).join("\n")
          );
          withBackend();

          const result = (await service.handleCall(ctx, "grep", [
            "needle",
            { contextLines: 20 },
          ])) as GrepResult;
          expect(result.matches[0]?.before).toHaveLength(20);
          expect(result.matches[0]?.after).toHaveLength(20);
          expect(result.truncated).toBe(false);
        });

        it("truncates at maxMatches", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-c");
          const root = path.join(tmpRoot, "ctx-grep-c-scratch");
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

        it("respects ignore files unless includeIgnored is explicit", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-ignore");
          const root = path.join(tmpRoot, "ctx-grep-ignore-scratch");
          mkdirSync(root, { recursive: true });
          writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
          writeFileSync(path.join(root, "ignored.txt"), "needle\n");
          writeFileSync(path.join(root, "visible.txt"), "needle\n");
          withBackend();

          const normal = (await service.handleCall(ctx, "grep", ["needle"])) as GrepResult;
          expect(normal.matches.map((match) => match.file)).toEqual(["/visible.txt"]);
          const complete = (await service.handleCall(ctx, "grep", [
            "needle",
            { includeIgnored: true },
          ])) as GrepResult;
          expect(complete.matches.map((match) => match.file)).toEqual([
            "/ignored.txt",
            "/visible.txt",
          ]);
        });
      });
    }

    it("propagates cancellation to the ripgrep subprocess", async () => {
      const base = makeWorkerCtx("do:src:class:key");
      registerContext(base.caller.runtime.id, "do", "ctx-grep-cancel");
      const root = path.join(tmpRoot, "ctx-grep-cancel-scratch");
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "large.txt"), "needle\n".repeat(10_000));
      const controller = new AbortController();
      controller.abort(new Error("cancelled by caller"));

      await expect(
        service.handleCall({ ...base, signal: controller.signal }, "grep", ["needle"])
      ).rejects.toThrow("cancelled by caller");
    });

    it("rejects non-integral or out-of-range bounds", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-grep-bounds");
      mkdirSync(path.join(tmpRoot, "ctx-grep-bounds"), { recursive: true });
      await expect(
        service.handleCall(ctx, "grep", ["needle", { contextLines: 1.5 }])
      ).rejects.toThrow(/non-negative safe integer/u);
      await expect(service.handleCall(ctx, "grep", ["needle", { maxMatches: 0 }])).rejects.toThrow(
        /integer from 1 to 1000/u
      );
    });

    it("rejects paths escaping the sandbox", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-grep-esc");
      mkdirSync(path.join(tmpRoot, "ctx-grep-esc"), { recursive: true });
      await expect(
        service.handleCall(ctx, "grep", ["needle", { path: "../other-context" }])
      ).rejects.toThrow(/Path traversal/);
    });

    it("reports a missing search root directly instead of an opaque ripgrep failure", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-grep-missing");
      mkdirSync(path.join(tmpRoot, "ctx-grep-missing"), { recursive: true });

      await expect(
        service.handleCall(ctx, "grep", ["needle", { path: "/not-present" }])
      ).rejects.toMatchObject({
        code: "ENOENT",
        message: "grep search path not found: /not-present",
        path: "/not-present",
      });
    });

    it("works for shell callers with an explicit contextId", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-grep-shell"), { recursive: true });
      mkdirSync(path.join(tmpRoot, "ctx-grep-shell-scratch"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-grep-shell-scratch", "f.txt"), "needle\n");
      const result = (await service.handleCall(makeShellCtx("shell-1"), "grep", [
        "ctx-grep-shell",
        "needle",
      ])) as GrepResult;
      expect(result.matchCount).toBe(1);
      expect(result.matches[0]!.file).toBe("/f.txt");
    });
  });

  describe("glob", () => {
    it("returns matching files in stable lexical order, skipping internal and dependency trees", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob");
      const root = path.join(tmpRoot, "ctx-glob-scratch");
      mkdirSync(path.join(root, "src", "deep"), { recursive: true });
      mkdirSync(path.join(root, "node_modules"), { recursive: true });
      mkdirSync(path.join(root, ".gad"), { recursive: true });
      writeFileSync(path.join(root, "src", "old.ts"), "");
      writeFileSync(path.join(root, "src", "deep", "newer.ts"), "");
      writeFileSync(path.join(root, "src", "skip.md"), "");
      writeFileSync(path.join(root, "node_modules", "dep.ts"), "");
      writeFileSync(path.join(root, ".gad", "CHECKOUT.json"), "{}");
      const now = Date.now() / 1000;
      utimesSync(path.join(root, "src", "old.ts"), now - 100, now - 100);
      utimesSync(path.join(root, "src", "deep", "newer.ts"), now, now);

      const result = (await service.handleCall(ctx, "glob", ["**/*.ts"])) as GlobResult;
      expect(result).toEqual({
        files: ["/src/deep/newer.ts", "/src/old.ts"],
        truncated: false,
      });
    });

    it("scopes the search to options.path", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob-scope");
      const root = path.join(tmpRoot, "ctx-glob-scope-scratch");
      mkdirSync(path.join(root, "a"), { recursive: true });
      mkdirSync(path.join(root, "b"), { recursive: true });
      writeFileSync(path.join(root, "a", "in.txt"), "");
      writeFileSync(path.join(root, "b", "out.txt"), "");

      const result = (await service.handleCall(ctx, "glob", [
        "*.txt",
        { path: "/a" },
      ])) as GlobResult;
      expect(result.files).toEqual(["/a/in.txt"]);
    });

    it("matches slash-free patterns against basenames anywhere in the tree", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob-base");
      const root = path.join(tmpRoot, "ctx-glob-base-scratch");
      mkdirSync(path.join(root, "nested"), { recursive: true });
      writeFileSync(path.join(root, "nested", "match.spec.ts"), "");

      const result = (await service.handleCall(ctx, "glob", ["*.spec.ts"])) as GlobResult;
      expect(result.files).toEqual(["/nested/match.spec.ts"]);
    });

    it("respects ignore files by default and can deliberately include ignored files", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob-ignore");
      const root = path.join(tmpRoot, "ctx-glob-ignore-scratch");
      mkdirSync(path.join(root, "nested"), { recursive: true });
      writeFileSync(path.join(root, ".gitignore"), "ignored.ts\n");
      writeFileSync(path.join(root, "visible.ts"), "");
      writeFileSync(path.join(root, "ignored.ts"), "");
      writeFileSync(path.join(root, "nested", ".ignore"), "local.ts\n");
      writeFileSync(path.join(root, "nested", "local.ts"), "");

      const normal = (await service.handleCall(ctx, "glob", ["**/*.ts"])) as GlobResult;
      expect(normal.files).toEqual(["/visible.ts"]);
      const complete = (await service.handleCall(ctx, "glob", [
        "**/*.ts",
        { includeIgnored: true },
      ])) as GlobResult;
      expect(complete.files).toEqual(["/ignored.ts", "/nested/local.ts", "/visible.ts"]);
    });

    it("returns bounded resumable pages without duplicates", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob-pages");
      const root = path.join(tmpRoot, "ctx-glob-pages-scratch");
      mkdirSync(root, { recursive: true });
      for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(path.join(root, name), "");

      const first = (await service.handleCall(ctx, "glob", ["*.ts", { limit: 2 }])) as GlobResult;
      expect(first).toEqual({
        files: ["/a.ts", "/b.ts"],
        truncated: true,
        nextCursor: "/b.ts",
      });
      const second = (await service.handleCall(ctx, "glob", [
        "*.ts",
        { limit: 2, after: first.nextCursor },
      ])) as GlobResult;
      expect(second).toEqual({ files: ["/c.ts"], truncated: false });
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
        disk: new FsDisk(bundledRipgrepPath),
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
        disk: new FsDisk(bundledRipgrepPath),
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
        disk: new FsDisk(bundledRipgrepPath),
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

    it("a semantic directory read does not demand a disk projection", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-s", "packages", "lib"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-s", "packages", "lib", "x.ts"), "x\n");
      const { bridge, calls } = makeMaterializeBridge({ materialize: true });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        disk: new FsDisk(bundledRipgrepPath),
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-s");

      await svc.handleCall(ctx, "readdir", ["/packages/lib"]);

      expect(calls).toEqual([]);
    });

    it("resolves the ready context root without a blanket materialization", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-root-realpath"), { recursive: true });
      const { bridge, calls } = makeMaterializeBridge({ materialize: true });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        disk: new FsDisk(bundledRipgrepPath),
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-root-realpath");

      await expect(svc.handleCall(ctx, "realpath", ["/"])).resolves.toBe("/");
      expect(calls).toEqual([]);
    });

    it("an existing empty semantic repository lists without a disk projection", async () => {
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
        disk: new FsDisk(bundledRipgrepPath),
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-s2");

      await expect(svc.handleCall(ctx, "readdir", ["/packages/lib"])).resolves.toEqual([]);
    });

    it("a root grep demands 'all' (the only legitimate blanket case)", async () => {
      const { bridge, calls } = makeMaterializeBridge({ materialize: true });
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        disk: new FsDisk(bundledRipgrepPath),
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
        disk: new FsDisk(bundledRipgrepPath),
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
        disk: new FsDisk(bundledRipgrepPath),
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
        disk: new FsDisk(bundledRipgrepPath),
        contextAuthority: { kind: "semantic", bridge },
      });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-s5");

      await svc.handleCall(ctx, "ensureMaterialized", [".tmp/file.txt"]);

      expect(calls).toEqual([]);
    });
  });
});
