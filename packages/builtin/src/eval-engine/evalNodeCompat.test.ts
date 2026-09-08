import { describe, expect, it, vi } from "vitest";
import { createEvalNodeCompat } from "./evalNodeCompat.js";

describe("createEvalNodeCompat", () => {
  it("aliases Node fs imports to the exact injected runtime fs and exposes pure utilities", async () => {
    const runtimeFs = {
      readFile: vi.fn(async (path: string, encoding?: string) =>
        encoding ? `scoped:${path}` : new Uint8Array([111, 107])
      ),
      readdir: vi.fn(async () => ["a.ts"]),
      appendFile: vi.fn(async () => undefined),
      stat: vi.fn(async () => {
        throw new Error("missing");
      }),
      lstat: vi.fn(() => {
        throw new Error("invalid path");
      }),
      exists: vi.fn(async () => true),
    };
    const callbackTasks: Promise<void>[] = [];
    const modules = createEvalNodeCompat(
      runtimeFs,
      (task) => callbackTasks.push(task),
      () => true
    );
    const fs = modules["node:fs"] as Record<string, unknown>;
    const promises = modules["node:fs/promises"] as Record<string, unknown>;
    expect(modules["fs"]).toBe(fs);
    expect(modules["fs/promises"]).toBe(promises);
    expect(promises).toBe(runtimeFs);
    expect(fs["promises"]).toBe(runtimeFs);
    expect(fs["default"]).toBe(fs);
    expect(modules["os"]).toBe(modules["node:os"]);
    expect(modules["path"]).toBe(modules["node:path"]);
    expect(modules["util"]).toBe(modules["node:util"]);
    expect(modules["crypto"]).toBe(modules["node:crypto"]);
    expect(modules["buffer"]).toBe(modules["node:buffer"]);
    const os = modules["node:os"] as typeof import("node:os");
    const path = modules["node:path"] as typeof import("node:path");
    const util = modules["node:util"] as typeof import("node:util");

    await expect((fs["readFile"] as typeof runtimeFs.readFile)("notes.md", "utf8")).resolves.toBe(
      "scoped:notes.md"
    );
    await expect((fs["readFile"] as typeof runtimeFs.readFile)("bytes.bin")).resolves.toEqual(
      new Uint8Array([111, 107])
    );
    await new Promise<void>((resolve, reject) => {
      (
        fs["readFile"] as (
          path: string,
          encoding: string,
          callback: (error: unknown, value?: string) => void
        ) => void
      )("notes.md", "utf8", (error, value) => {
        if (error) return reject(error);
        expect(value).toBe("scoped:notes.md");
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      (
        fs["appendFile"] as (
          path: string,
          data: string,
          callback: (error?: unknown) => void
        ) => void
      )(".tmp/notes.md", "second chunk\n", (error) => {
        if (error) return reject(error);
        resolve();
      });
    });
    expect(runtimeFs.appendFile).toHaveBeenCalledWith(".tmp/notes.md", "second chunk\n");
    await new Promise<void>((resolve) => {
      (fs["stat"] as (path: string, callback: (error: unknown) => void) => void)(
        "missing",
        (error) => {
          expect(error).toEqual(new Error("missing"));
          resolve();
        }
      );
    });
    await Promise.all(callbackTasks);
    await new Promise<void>((resolve) => {
      (fs["lstat"] as (path: string, callback: (error: unknown) => void) => void)(
        "invalid",
        (error) => {
          expect(error).toEqual(new Error("invalid path"));
          resolve();
        }
      );
    });
    await new Promise<void>((resolve) =>
      (fs["exists"] as (path: string, callback: (exists: boolean) => void) => void)(
        "notes.md",
        (exists) => {
          expect(exists).toBe(true);
          resolve();
        }
      )
    );
    await expect((promises["exists"] as typeof runtimeFs.exists)()).resolves.toBe(true);
    await expect(
      (promises["readFile"] as typeof runtimeFs.readFile)("projects/demo/notes.md", "utf8")
    ).resolves.toBe("scoped:projects/demo/notes.md");
    expect(path.join("projects", "demo")).toBe("projects/demo");
    expect(os.tmpdir()).toBe("/.tmp");
    expect(path.join(os.tmpdir(), "payload.bin")).toBe("/.tmp/payload.bin");
    expect(os.hostname()).toBe("vibestudio");
    expect(new util.TextDecoder().decode(new Uint8Array([111, 107]))).toBe("ok");
    expect(util.inspect({ ok: true })).toContain("ok");
    const crypto = modules["node:crypto"] as typeof import("node:crypto");
    expect(crypto.createHash("sha256").update("ok").digest("hex")).toHaveLength(64);
    const buffer = modules["node:buffer"] as typeof import("node:buffer");
    expect(buffer.Buffer.byteLength("α", "utf8")).toBe(2);
    expect(modules).not.toHaveProperty("node:child_process");
  });

  it("reports exceptions from callback consumers to the owning eval task", async () => {
    const callbackTasks: Promise<void>[] = [];
    const fs = createEvalNodeCompat(
      { readFile: async () => "ok" },
      (task) => {
        callbackTasks.push(task);
        void task.catch(() => undefined);
      },
      () => true
    )["node:fs"] as Record<string, unknown>;

    (fs["readFile"] as (path: string, callback: () => void) => void)("notes.md", () => {
      throw new Error("callback failed");
    });
    expect(callbackTasks).toHaveLength(1);
    await expect(callbackTasks[0]).rejects.toThrow("callback failed");
  });

  it("does not deliver a scoped filesystem callback after its eval owner closes", async () => {
    let finish!: (value: string) => void;
    let open = true;
    const callback = vi.fn();
    const fs = createEvalNodeCompat(
      { readFile: () => new Promise<string>((resolve) => (finish = resolve)) },
      (task) => void task.catch(() => undefined),
      () => open
    )["node:fs"] as Record<string, unknown>;

    (fs["readFile"] as (path: string, callback: (error: unknown, value: string) => void) => void)(
      "notes.md",
      callback
    );
    open = false;
    expect(() =>
      (fs["readFile"] as (path: string, callback: () => void) => void)("later.md", () => undefined)
    ).toThrow("completed eval run");
    finish("late");
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
  });
});
