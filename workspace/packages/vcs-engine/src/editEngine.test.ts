/**
 * EditEngine + path policy — the userland edit semantics (P5c). The gad-store
 * DO drives these end-to-end (gadStoreVcs.test.ts); this pins the pure parts:
 * op application over a file map, provenance-hunk derivation for whole-file
 * writes, exact-range replace, and the edit-boundary path guards.
 */
import { describe, expect, it } from "vitest";
import {
  EditEngine,
  applyReplaceHunks,
  decodeUtf8Text,
  hasConflictMarkers,
  type WorkingFileEntry,
} from "./editEngine.js";
import { assertSafeVcsPath, assertWritableVcsEditPath } from "./paths.js";

const ENC = new TextEncoder();

function memoryEngine() {
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  const digests = new Map<string, string>(); // content key → digest (idempotent)
  const engine = new EditEngine({
    readBlob: async (digest) => blobs.get(digest) ?? null,
    writeBlob: async (bytes) => {
      const key = Array.from(bytes).join(",");
      let digest = digests.get(key);
      if (!digest) {
        digest = `blob-${(n += 1)}`;
        digests.set(key, digest);
        blobs.set(digest, bytes);
      }
      return { digest, size: bytes.length };
    },
  });
  const seed = (text: string): string => {
    const bytes = ENC.encode(text);
    const digest = `seed-${(n += 1)}`;
    blobs.set(digest, bytes);
    return digest;
  };
  const textOf = (digest: string): string => {
    const bytes = blobs.get(digest);
    if (!bytes) throw new Error(`no blob ${digest}`);
    return new TextDecoder().decode(bytes);
  };
  return { engine, seed, textOf };
}

function fileMap(entries: WorkingFileEntry[]): Map<string, WorkingFileEntry> {
  return new Map(entries.map((e) => [e.path, e]));
}

describe("EditEngine.applyEditOps", () => {
  it("applies create/write/replace/chmod/delete and returns provenance rows", async () => {
    const { engine, seed, textOf } = memoryEngine();
    const base = fileMap([
      { path: "a.txt", contentHash: seed("hello world\n"), mode: 33188 },
      { path: "gone.txt", contentHash: seed("bye\n"), mode: 33188 },
    ]);
    const { files, rows } = await engine.applyEditOps(base, [
      { kind: "create", path: "new.txt", content: { kind: "text", text: "N\n" } },
      {
        kind: "replace",
        path: "a.txt",
        hunks: [{ start: 6, end: 11, oldText: "world", newText: "gad" }],
      },
      { kind: "chmod", path: "a.txt", mode: 33261 },
      { kind: "delete", path: "gone.txt" },
    ]);
    expect(base.has("gone.txt")).toBe(true); // input map not mutated
    expect(files.has("gone.txt")).toBe(false);
    expect(textOf(files.get("a.txt")!.contentHash)).toBe("hello gad\n");
    expect(files.get("a.txt")!.mode).toBe(33261);
    expect(rows.map((r) => r.kind)).toEqual(["create", "replace", "chmod", "delete"]);
    const replaceRow = rows[1]!;
    expect(replaceRow.oldContentHash).not.toBe(replaceRow.newContentHash);
    expect(replaceRow.hunks).toBeTruthy();
  });

  it("derives hunk provenance for a whole-file text write; none for binary", async () => {
    const { engine, seed } = memoryEngine();
    const base = fileMap([
      { path: "a.txt", contentHash: seed("line1\nline2\n"), mode: 33188 },
      { path: "b.bin", contentHash: "missing", mode: 33188 },
    ]);
    const { rows } = await engine.applyEditOps(base, [
      { kind: "write", path: "a.txt", content: { kind: "text", text: "line1\nline2!\n" } },
    ]);
    expect(rows[0]!.hunks).toBeTruthy();
    expect(rows[0]!.binary).toBe(false);

    const binary = await engine.applyEditOps(base, [
      {
        kind: "write",
        path: "b.bin",
        content: { kind: "bytes", base64: Buffer.from([0, 1, 2]).toString("base64") },
      },
    ]);
    expect(binary.rows[0]!.hunks).toBeUndefined();
    // Explicit binary marker distinguishes "no line structure" from missing data.
    expect(binary.rows[0]!.binary).toBe(true);
  });

  it("marks binary on write/create per content, false on text/replace/chmod/delete", async () => {
    const { engine, seed } = memoryEngine();
    const bin = Buffer.from([0, 1, 2, 3]).toString("base64");
    const base = fileMap([
      { path: "a.txt", contentHash: seed("hello\n"), mode: 33188 },
      { path: "gone.txt", contentHash: seed("x\n"), mode: 33188 },
    ]);
    const { rows } = await engine.applyEditOps(base, [
      { kind: "create", path: "new.txt", content: { kind: "text", text: "N\n" } },
      { kind: "create", path: "pic.bin", content: { kind: "bytes", base64: bin } },
      {
        kind: "replace",
        path: "a.txt",
        hunks: [{ start: 0, end: 5, oldText: "hello", newText: "HELLO" }],
      },
      { kind: "chmod", path: "a.txt", mode: 33261 },
      { kind: "delete", path: "gone.txt" },
    ]);
    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get("new.txt")!.binary).toBe(false);
    expect(byPath.get("pic.bin")!.binary).toBe(true);
    expect(byPath.get("pic.bin")!.hunks).toBeUndefined();
    expect(byPath.get("a.txt")!.kind).toBe("chmod"); // last write wins in the map
    // The replace row (text) is marked non-binary.
    expect(rows.find((r) => r.kind === "replace")!.binary).toBe(false);
    expect(rows.find((r) => r.kind === "chmod")!.binary).toBe(false);
    expect(rows.find((r) => r.kind === "delete")!.binary).toBe(false);
  });

  it("write of binary over existing binary → binary:true, hunks absent (no throw)", async () => {
    const { engine } = memoryEngine();
    const firstBin = Buffer.from([0, 9, 9]).toString("base64");
    // Create a binary file, then overwrite it with different binary bytes.
    const created = await engine.applyEditOps(new Map(), [
      { kind: "create", path: "b.bin", content: { kind: "bytes", base64: firstBin } },
    ]);
    expect(created.rows[0]!.binary).toBe(true);
    const overwrite = await engine.applyEditOps(created.files, [
      {
        kind: "write",
        path: "b.bin",
        content: { kind: "bytes", base64: Buffer.from([1, 0, 2]).toString("base64") },
      },
    ]);
    expect(overwrite.rows[0]!.binary).toBe(true);
    expect(overwrite.rows[0]!.hunks).toBeUndefined();
  });

  it("resolves blob-ref content without moving bytes (the revert shape)", async () => {
    const { engine, seed, textOf } = memoryEngine();
    const original = seed("v1\n");
    const base = fileMap([{ path: "a.txt", contentHash: seed("v2\n"), mode: 33188 }]);
    const { files, rows } = await engine.applyEditOps(base, [
      { kind: "write", path: "a.txt", content: { kind: "blob", contentHash: original } },
    ]);
    expect(files.get("a.txt")!.contentHash).toBe(original);
    expect(textOf(files.get("a.txt")!.contentHash)).toBe("v1\n");
    expect(rows[0]!.hunks).toBeTruthy(); // provenance still derived by digest reads
  });

  it("rejects create-over-existing, missing targets, and binary replace", async () => {
    const { engine, seed } = memoryEngine();
    const base = fileMap([
      { path: "a.txt", contentHash: seed("x\n"), mode: 33188 },
      { path: "b.bin", contentHash: (() => seed("\u0000binary"))(), mode: 33188 },
    ]);
    await expect(
      engine.applyEditOps(base, [
        { kind: "create", path: "a.txt", content: { kind: "text", text: "y\n" } },
      ])
    ).rejects.toThrow(/already exists/);
    await expect(engine.applyEditOps(base, [{ kind: "delete", path: "nope.txt" }])).rejects.toThrow(
      /no such path/
    );
    await expect(
      engine.applyEditOps(base, [
        { kind: "replace", path: "b.bin", hunks: [{ start: 0, end: 1, newText: "x" }] },
      ])
    ).rejects.toThrow(/binary file/);
  });
});

describe("applyReplaceHunks", () => {
  it("applies right-to-left, verifies oldText, rejects overlap and out-of-range", () => {
    expect(
      applyReplaceHunks("abcdef", [
        { start: 0, end: 2, oldText: "ab", newText: "AB" },
        { start: 4, end: 6, newText: "EF" },
      ])
    ).toBe("ABcdEF");
    expect(() =>
      applyReplaceHunks("abcdef", [{ start: 0, end: 2, oldText: "xy", newText: "AB" }])
    ).toThrow(/oldText mismatch/);
    expect(() =>
      applyReplaceHunks("abcdef", [
        { start: 0, end: 3, newText: "A" },
        { start: 2, end: 4, newText: "B" },
      ])
    ).toThrow(/overlapping/);
    expect(() => applyReplaceHunks("abc", [{ start: 2, end: 9, newText: "x" }])).toThrow(
      /out of range/
    );
  });
});

describe("path policy", () => {
  it("assertSafeVcsPath rejects escapes; assertWritableVcsEditPath rejects platform-ignored", () => {
    expect(() => assertSafeVcsPath("../up.txt")).toThrow(/escapes/);
    expect(() => assertSafeVcsPath("/abs.txt")).toThrow(/escapes/);
    expect(() => assertSafeVcsPath("")).toThrow(/empty/);
    expect(() => assertSafeVcsPath("ok/nested.txt")).not.toThrow();

    // The guard must match the tree encoder exactly: `.` segments, empty
    // segments (`a//b`, `./a`, `foo/`, `.`), and backslash are all rejected so
    // they never enter the working map as phantom keys.
    for (const bad of ["a/./b", "a//b", "./a", "foo/", ".", "a\\b"]) {
      expect(() => assertSafeVcsPath(bad), bad).toThrow(/valid tree path|escapes/);
    }
    for (const ok of ["a/b", "a.b/c", "ok/nested.txt", "single"]) {
      expect(() => assertSafeVcsPath(ok), ok).not.toThrow();
    }

    for (const bad of [
      ".env",
      ".env.local",
      "x.log",
      "dir/.git",
      ".git/hooks/pre-commit",
      "node_modules/a.js",
      "a.tsbuildinfo",
      "foo~",
    ]) {
      expect(() => assertWritableVcsEditPath(bad), bad).toThrow(/platform-ignored/);
    }
    // Bare-suffix basenames the host ignores via gitignore `*` (zero-or-more):
    // these must be rejected too now that the userland regexes use `.*`.
    for (const bad of [
      "~",
      ".log",
      ".swp",
      ".sublime-workspace",
      ".env.",
      "dir/~",
      "dir/.log",
    ]) {
      expect(() => assertWritableVcsEditPath(bad), bad).toThrow(/platform-ignored/);
    }
    for (const ok of [
      "src/env.ts",
      "docs/log.md",
      "panels/chat/main.tsx",
      "environment.txt",
      "probe.tmp",
      ".tmp/vcs-probe.txt",
    ]) {
      expect(() => assertWritableVcsEditPath(ok), ok).not.toThrow();
    }
  });
});

describe("text helpers", () => {
  it("decodeUtf8Text and conflict markers", () => {
    expect(decodeUtf8Text(ENC.encode("plain"))).toBe("plain");
    expect(decodeUtf8Text(new Uint8Array([0, 1, 2]))).toBeNull();
    expect(hasConflictMarkers("a\n<<<<<<< ours\nb\n")).toBe(true);
    expect(hasConflictMarkers("no markers")).toBe(false);
  });
});
