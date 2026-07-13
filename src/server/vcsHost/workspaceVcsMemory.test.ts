/**
 * Focused tests for WorkspaceVcsMemory marker discipline and scheduling.
 */

import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateAdvancedEvent } from "../buildV2/stateTrigger.js";
import { ensureLayout, putBytes } from "../services/blobstoreService.js";
import { WorkspaceVcsMemory } from "./workspaceVcsMemory.js";

const MAX_INDEXED_FILE_BYTES = 256 * 1024;

interface StubFile {
  path: string;
  content_hash: string;
  mode: number;
}

function makeMemory(options: {
  blobsDir: string;
  stateHash: string;
  markerValue: string | null;
  stateFiles: StubFile[];
}): {
  memory: WorkspaceVcsMemory;
  getMarker: () => string | null;
  indexed: Array<{ files: unknown[]; removedPaths: string[] }>;
} {
  let marker = options.markerValue;
  const indexed: Array<{ files: unknown[]; removedPaths: string[] }> = [];
  const memory = new WorkspaceVcsMemory({
    blobsDir: options.blobsDir,
    gad: {
      async call<T>(method: string, input: unknown): Promise<T> {
        switch (method) {
          case "getMemoryIndexMarker":
            return { value: marker } as T;
          case "setMemoryIndexMarker":
            marker = (input as { value: string }).value;
            return {} as T;
          case "indexMemoryFiles":
            indexed.push(input as { files: unknown[]; removedPaths: string[] });
            return {} as T;
          default:
            throw new Error(`unexpected gad call ${method}`);
        }
      },
    },
    isAttached: () => true,
    subscribeStateAdvanced: () => () => {},
    discoverRepositories: async () => [],
    resolveMain: async () => options.stateHash,
    diffStates: async () => {
      throw new Error("unexpected diff");
    },
    worktrees: {
      listStateFiles: async () => options.stateFiles,
    },
  });
  return { memory, getMarker: () => marker, indexed };
}

describe("WorkspaceVcsMemory marker discipline", () => {
  let blobsDir: string;

  beforeEach(async () => {
    blobsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-index-"));
    ensureLayout(blobsDir);
  });

  afterEach(async () => {
    await fsp.rm(blobsDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("aborts without advancing the marker when a CAS blob is missing, then indexes on retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const present = await putBytes(blobsDir, Buffer.from("hello indexed", "utf8"));
    const missingHash = "a".repeat(64);

    const first = makeMemory({
      blobsDir,
      stateHash: "state:target",
      markerValue: null,
      stateFiles: [
        { path: "notes.txt", content_hash: present.digest, mode: 0o100644 },
        { path: "pending.txt", content_hash: missingHash, mode: 0o100644 },
      ],
    });
    await first.memory.indexRepository("panels/demo");

    expect(first.getMarker()).toBeNull();
    expect(first.indexed).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("index aborted"));

    const nowPresent = await putBytes(blobsDir, Buffer.from("now present", "utf8"));
    const retry = makeMemory({
      blobsDir,
      stateHash: "state:target",
      markerValue: null,
      stateFiles: [
        { path: "notes.txt", content_hash: present.digest, mode: 0o100644 },
        { path: "pending.txt", content_hash: nowPresent.digest, mode: 0o100644 },
      ],
    });
    await retry.memory.indexRepository("panels/demo");
    expect(retry.getMarker()).toBe("state:target");
    expect(retry.indexed).toHaveLength(1);
    expect(retry.indexed[0]!.files).toHaveLength(2);
  });

  it("advances the marker and omits deliberately skipped files", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previousLogLevel = process.env["VIBESTUDIO_LOG_LEVEL"];
    process.env["VIBESTUDIO_LOG_LEVEL"] = "info";
    try {
      const ok = await putBytes(blobsDir, Buffer.from("small text file", "utf8"));
      const oversized = await putBytes(blobsDir, Buffer.alloc(MAX_INDEXED_FILE_BYTES + 1, 0x61));
      const binary = await putBytes(blobsDir, Buffer.from([0x41, 0x00, 0x42, 0x43]));
      const run = makeMemory({
        blobsDir,
        stateHash: "state:target2",
        markerValue: null,
        stateFiles: [
          { path: "keep.txt", content_hash: ok.digest, mode: 0o100644 },
          { path: "big.bin", content_hash: oversized.digest, mode: 0o100644 },
          { path: "data.bin", content_hash: binary.digest, mode: 0o100644 },
        ],
      });

      await run.memory.indexRepository("panels/demo");

      expect(run.getMarker()).toBe("state:target2");
      expect(run.indexed).toHaveLength(1);
      const files = run.indexed[0]!.files as Array<{ path: string }>;
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe("panels/demo/keep.txt");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      if (previousLogLevel === undefined) delete process.env["VIBESTUDIO_LOG_LEVEL"];
      else process.env["VIBESTUDIO_LOG_LEVEL"] = previousLogLevel;
    }
  });
});

describe("WorkspaceVcsMemory scheduling", () => {
  it("defers catch-up and main-advance indexing behind the startup barrier", async () => {
    let releaseStartup!: () => void;
    const startupBarrier = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    let allIndexed!: () => void;
    const indexingComplete = new Promise<void>((resolve) => {
      allIndexed = resolve;
    });
    const listeners: Array<(event: StateAdvancedEvent) => void> = [];
    const indexCalls: string[] = [];
    const memory = new WorkspaceVcsMemory({
      blobsDir: "/tmp/blobs",
      gad: {
        async call<T>(): Promise<T> {
          throw new Error("unexpected gad call");
        },
      },
      isAttached: () => true,
      subscribeStateAdvanced: (listener) => {
        listeners.push(listener);
        return () => {};
      },
      discoverRepositories: async () => [{ repoPath: "panels/startup", kind: "build-unit" }],
      resolveMain: async (repoPath) => {
        indexCalls.push(repoPath);
        if (indexCalls.length === 2) allIndexed();
        return null;
      },
      diffStates: async () => {
        throw new Error("unexpected diff");
      },
      worktrees: {
        listStateFiles: async () => [],
      },
    });

    memory.enable({ startupBarrier });
    listeners[0]?.({
      head: "main",
      repoPath: "panels/chat",
    } as StateAdvancedEvent);
    await Promise.resolve();
    expect(indexCalls).toEqual([]);

    releaseStartup();
    await indexingComplete;

    expect(indexCalls).toEqual(["panels/startup", "panels/chat"]);
  });
});
