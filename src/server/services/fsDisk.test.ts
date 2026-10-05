import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { FsDisk, type FsDiskScope } from "./fsDisk.js";

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("native filesystem handle lifetime", () => {
  let root: string;
  let disk: FsDisk;
  let scope: FsDiskScope;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "vibestudio-fd-lifetime-"));
    disk = new FsDisk(rgPath);
    scope = {
      root,
      panelId: "extension:tools:chain:agent",
      exposeHostPaths: false,
      ownerCallerIds: ["tools", "agent"],
    };
    await fs.writeFile(join(root, "original.txt"), "before");
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      await disk.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("rejects a symlink replacement crossing admitted operation coordinates", async () => {
    await fs.writeFile(join(root, "other.txt"), "private");
    await fs.symlink("original.txt", join(root, "link.txt"));
    expect(await disk.call(scope, "authorityPath", ["link.txt", {}])).toMatchObject({
      path: "original.txt",
    });
    const admitted = {
      ...scope,
      pathAuthority: [
        { kind: "exact" as const, key: "workspace-path/original.txt" },
        { kind: "exact" as const, key: "workspace-path/other.txt" },
      ],
    };
    await expect(disk.call(admitted, "readFile", ["original.txt", "utf8"])).resolves.toBe("before");
    await fs.unlink(join(root, "original.txt"));
    await fs.symlink("other.txt", join(root, "original.txt"));
    await expect(disk.call(admitted, "readFile", ["original.txt", "utf8"])).rejects.toMatchObject({
      code: "EACCES",
    });
  });
  async function open() {
    return (await disk.call(scope, "open", ["original.txt", "r+"])) as { handleId: number };
  }
  it("rejects unowned work before opening a descriptor", async () => {
    await expect(
      disk.call({ ...scope, ownerCallerIds: [] }, "open", ["original.txt", "r"])
    ).rejects.toThrow(/actual caller owners/);
  });
  it("keeps a live handle valid through elapsed idle time, rename, and writes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { handleId } = await open();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await disk.call(scope, "rename", ["original.txt", "renamed.txt"]);
    await disk.call(scope, "writeFile", ["renamed.txt", "after!", "utf8"]);
    const read = (await disk.call(scope, "handleRead", [handleId, 6, 0])) as {
      buffer: { data: string };
    };
    expect(Buffer.from(read.buffer.data, "base64").toString()).toBe("after!");
    await disk.call(scope, "handleClose", [handleId]);
    await expect(disk.call(scope, "handleStat", [handleId])).rejects.toThrow(/Invalid file handle/);
  });
  it.each(["tools", "agent"])(
    "retires handles by actual owner %s rather than their logical access key",
    async (owner) => {
      const { handleId } = await open();
      await disk.closeCaller("unrelated");
      await expect(disk.call(scope, "handleStat", [handleId])).resolves.toMatchObject({
        isFile: true,
      });
      await disk.closeCaller(owner);
      await expect(disk.call(scope, "handleStat", [handleId])).rejects.toThrow(
        /Invalid file handle/
      );
    }
  );
  it("joins a late open before closing the caller's native descriptor", async () => {
    const native = await fs.open(join(root, "original.txt"), "r");
    const entered = deferred<void>();
    const gate = deferred<fs.FileHandle>();
    const close = vi.spyOn(native, "close");
    vi.mocked(fs.open).mockImplementationOnce(async () => {
      entered.resolve();
      return gate.promise;
    });
    const opening = open();
    await entered.promise;
    const retirement = disk.closeCaller("agent");
    const rejectedAdmission = disk.call(scope, "open", ["original.txt", "r"]);
    await expect(rejectedAdmission).rejects.toMatchObject({ code: "EOWNERRETIRED" });
    expect(close).not.toHaveBeenCalled();
    gate.resolve(native);
    const { handleId } = await opening;
    await retirement;
    expect(close).toHaveBeenCalledOnce();
    await expect(disk.call(scope, "handleStat", [handleId])).rejects.toThrow(/Invalid file handle/);
  });
  it("preserves close failure and keeps the descriptor owned until explicit retirement resumes", async () => {
    const native = await fs.open(join(root, "original.txt"), "r");
    const original = new Error("descriptor close rejected");
    const close = vi.spyOn(native, "close").mockRejectedValueOnce(original);
    vi.mocked(fs.open).mockResolvedValueOnce(native);
    const { handleId } = await open();
    await expect(disk.closeCaller("agent")).rejects.toBe(original);
    expect(close).toHaveBeenCalledOnce();
    await expect(disk.call(scope, "handleStat", [handleId])).rejects.toMatchObject({
      code: "EOWNERRETIRED",
    });
    await disk.closeCaller("agent");
    expect(close).toHaveBeenCalledTimes(2);
    await expect(disk.call(scope, "handleStat", [handleId])).rejects.toThrow(/Invalid file handle/);
  });
});
