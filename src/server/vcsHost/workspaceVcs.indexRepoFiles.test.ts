/**
 * Focused tests for WorkspaceVcs.indexRepoFiles marker discipline (A4).
 *
 * A MISSING CAS blob must abort the pass WITHOUT advancing the `memidx:`
 * marker (so the next main advance retries), while deliberate skips (over the
 * size cap / binary) advance the marker and simply omit the file. These drive
 * the method directly against a real temp CAS with the DO collaborators
 * (marker get/set, indexMemoryFiles, state-file listing) stubbed.
 */

import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLayout, putBytes } from "../services/blobstoreService.js";
import { WorkspaceVcs } from "./workspaceVcs.js";

const MAX_INDEXED_FILE_BYTES = 256 * 1024;

interface StubFile {
  path: string;
  content_hash: string;
}

function makeFakeThis(opts: {
  blobsDir: string;
  stateHash: string;
  markerValue: string | null;
  stateFiles: StubFile[];
}): {
  self: object;
  getMarker: () => string | null;
  indexed: Array<{ files: unknown[]; removedPaths: string[] }>;
} {
  let marker = opts.markerValue;
  const indexed: Array<{ files: unknown[]; removedPaths: string[] }> = [];
  const gad = {
    async call(method: string, input: unknown): Promise<unknown> {
      switch (method) {
        case "getMemoryIndexMarker":
          return { value: marker };
        case "setMemoryIndexMarker":
          marker = (input as { value: string }).value;
          return {};
        case "indexMemoryFiles":
          indexed.push(input as { files: unknown[]; removedPaths: string[] });
          return {};
        default:
          throw new Error(`unexpected gad call ${method}`);
      }
    },
  };
  const self = {
    attached: true,
    deps: { blobsDir: opts.blobsDir },
    async resolveHead(): Promise<string | null> {
      return opts.stateHash;
    },
    gad: () => gad,
    worktrees: {
      async listStateFiles(): Promise<StubFile[]> {
        return opts.stateFiles;
      },
    },
  };
  return { self, getMarker: () => marker, indexed };
}

describe("WorkspaceVcs.indexRepoFiles marker discipline (A4)", () => {
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
    // A hash with no bytes on disk — simulates a transient content-bridge miss.
    const missingHash = "a".repeat(64);

    const first = makeFakeThis({
      blobsDir,
      stateHash: "state:target",
      markerValue: null,
      stateFiles: [
        { path: "notes.txt", content_hash: present.digest },
        { path: "pending.txt", content_hash: missingHash },
      ],
    });
    await WorkspaceVcs.prototype.indexRepoFiles.call(first.self, "panels/demo");

    // Marker unchanged (still null): the pass aborted, nothing was indexed.
    expect(first.getMarker()).toBeNull();
    expect(first.indexed).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("index aborted"));

    // The blob appears; a retry now indexes both files and advances the marker.
    const nowPresent = await putBytes(blobsDir, Buffer.from("now present", "utf8"));
    const retry = makeFakeThis({
      blobsDir,
      stateHash: "state:target",
      markerValue: null,
      stateFiles: [
        { path: "notes.txt", content_hash: present.digest },
        { path: "pending.txt", content_hash: nowPresent.digest },
      ],
    });
    await WorkspaceVcs.prototype.indexRepoFiles.call(retry.self, "panels/demo");
    expect(retry.getMarker()).toBe("state:target");
    expect(retry.indexed).toHaveLength(1);
    expect(retry.indexed[0]!.files).toHaveLength(2);
  });

  it("advances the marker and omits deliberately skipped files (oversized / binary)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previousLogLevel = process.env["VIBESTUDIO_LOG_LEVEL"];
    process.env["VIBESTUDIO_LOG_LEVEL"] = "info";
    try {
      const ok = await putBytes(blobsDir, Buffer.from("small text file", "utf8"));
      const oversized = await putBytes(blobsDir, Buffer.alloc(MAX_INDEXED_FILE_BYTES + 1, 0x61));
      const binary = await putBytes(blobsDir, Buffer.from([0x41, 0x00, 0x42, 0x43]));

      const run = makeFakeThis({
        blobsDir,
        stateHash: "state:target2",
        markerValue: null,
        stateFiles: [
          { path: "keep.txt", content_hash: ok.digest },
          { path: "big.bin", content_hash: oversized.digest },
          { path: "data.bin", content_hash: binary.digest },
        ],
      });
      await WorkspaceVcs.prototype.indexRepoFiles.call(run.self, "panels/demo");

      // Marker advanced: deliberate skips are not a retry condition.
      expect(run.getMarker()).toBe("state:target2");
      expect(run.indexed).toHaveLength(1);
      const files = run.indexed[0]!.files as Array<{ path: string }>;
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe("panels/demo/keep.txt");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      if (previousLogLevel === undefined) {
        delete process.env["VIBESTUDIO_LOG_LEVEL"];
      } else {
        process.env["VIBESTUDIO_LOG_LEVEL"] = previousLogLevel;
      }
    }
  });
});
