import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ContentProjectionStore } from "./contentProjectionStore.js";
import { getBytes } from "../services/blobstoreService.js";

describe("ContentProjectionStore ingestion", () => {
  let root: string;
  let blobsDir: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "content-ingest-"));
    blobsDir = path.join(root, "blobs");
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("converges concurrent duplicate content while preserving manifest order", async () => {
    const source = path.join(root, "source");
    await fsp.mkdir(source, { recursive: true });
    const body = "shared content\n";
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        fsp.writeFile(path.join(source, `file-${String(index).padStart(2, "0")}.txt`), body)
      )
    );

    const state = await new ContentProjectionStore({ blobsDir }).localState(source, {
      exact: true,
    });

    expect(state.files.map((file) => file.path)).toEqual(
      Array.from({ length: 64 }, (_, index) => `file-${String(index).padStart(2, "0")}.txt`)
    );
    expect(new Set(state.files.map((file) => file.contentHash)).size).toBe(1);
    expect(await getBytes(blobsDir, state.files[0]!.contentHash)).toEqual(Buffer.from(body));
  });

  it("joins every admitted file write before reporting a materialization failure", async () => {
    const source = path.join(root, "source");
    await fsp.mkdir(source, { recursive: true });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fsp.writeFile(path.join(source, `file-${index}.txt`), `body ${index}\n`)
      )
    );
    const store = new ContentProjectionStore({ blobsDir });
    const state = await store.localState(source, { exact: true });

    let releaseWrites!: () => void;
    const writesReleased = new Promise<void>((resolve) => (releaseWrites = resolve));
    let settledWrites = 0;
    const failure = new Error("disk full");
    const write = vi
      .spyOn(
        store as unknown as {
          writeMaterializedFile(source: string, absPath: string): Promise<void>;
        },
        "writeMaterializedFile"
      )
      .mockImplementation(async (_source, absPath) => {
        if (absPath.endsWith("file-0.txt")) throw failure;
        await writesReleased;
        await fsp.writeFile(absPath, "");
        settledWrites += 1;
      });

    let settled = false;
    const materialization = store
      .materializeState(state.stateHash, path.join(root, "target"))
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(8));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseWrites();
    await expect(materialization).rejects.toBe(failure);
    expect(settledWrites).toBe(7);
  });
});
