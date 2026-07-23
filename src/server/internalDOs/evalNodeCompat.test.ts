import { describe, expect, it, vi } from "vitest";
import { createEvalNodeCompat } from "./evalNodeCompat.js";

describe("createEvalNodeCompat", () => {
  it("maps Node fs imports to the scoped runtime fs and exposes pure path utilities", async () => {
    const runtimeFs = {
      readFile: vi.fn(async (path: string, encoding?: string) =>
        encoding ? `scoped:${path}` : new Uint8Array([111, 107])
      ),
      readdir: vi.fn(async () => ["a.ts"]),
    };
    const modules = createEvalNodeCompat(runtimeFs);
    const fs = modules["node:fs"] as Record<string, unknown>;
    const promises = modules["node:fs/promises"] as Record<string, unknown>;
    expect(modules["fs"]).toBe(fs);
    expect(modules["fs/promises"]).toBe(promises);
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
    await expect((fs["readFile"] as typeof runtimeFs.readFile)("bytes.bin")).resolves.toSatisfy(
      (value: unknown) => Buffer.isBuffer(value) && value.toString("utf8") === "ok"
    );
    expect(fs["promises"]).toMatchObject({ readFile: expect.any(Function) });
    await expect(
      (promises["readFile"] as typeof runtimeFs.readFile)(
        path.join(process.cwd(), "projects", "demo", "notes.md"),
        "utf8"
      )
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
});
