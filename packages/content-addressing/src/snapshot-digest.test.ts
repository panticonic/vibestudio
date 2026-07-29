import { describe, expect, it } from "vitest";
import { canonicalSnapshotDigest } from "./snapshot-digest.js";
import { sha256Hex } from "./worktree-hash.js";

const entry = (path: string, text: string, mode = 0o100644) => ({
  path,
  mode,
  size: new TextEncoder().encode(text).byteLength,
  contentHash: sha256Hex(new TextEncoder().encode(text)),
});

describe("canonicalSnapshotDigest", () => {
  const vectors = [
    {
      name: "empty tree",
      entries: [],
      digest: "v1-sha256:ff00ea91bf412654ad2bc2e13f7b1ebe9fb30da53bc54729420a166ba6c576cb",
    },
    {
      name: "single file",
      entries: [entry("README.md", "hello\n")],
      digest: "v1-sha256:f6e585943a3f1e2355ccca17e094e8edc66629f142c5b6f1f9c608ec3c8b175d",
    },
    {
      name: "executable",
      entries: [entry("bin/run", "#!/bin/sh\n", 0o100755)],
      digest: "v1-sha256:bb64729d3c0a0f4ae944f3168db38dd0b6a85e66ebaf9fc900992bc33bb4ba6a",
    },
    {
      name: "nested paths",
      entries: [entry("src/z.ts", "z"), entry("src/a.ts", "a"), entry("package.json", "{}")],
      digest: "v1-sha256:a95f872c6e17c57c602f4410c5f9a4503d60564996ad1266fbfcf1e3f86b4a24",
    },
    {
      name: "non-ASCII paths",
      entries: [entry("文/é.txt", "ok"), entry("文/e.txt", "ok")],
      digest: "v1-sha256:304503e5e049bfcb4884ca5a1cdfda5a8d4b2ea1db1276867c9a7483266ad1c3",
    },
    {
      name: "UTF-16 ordering",
      entries: [entry("\u{10000}.txt", "astral"), entry("\uE000.txt", "bmp")],
      digest: "v1-sha256:27d0e230de7b904eabc5a860bf6a215d07506184d3669f00c517c62d6417eb42",
    },
  ] as const;

  it.each(vectors)("matches the committed $name vector", ({ entries, digest: expected }) => {
    const digest = canonicalSnapshotDigest(entries);
    expect(digest).toBe(expected);
    expect(canonicalSnapshotDigest([...entries].reverse())).toBe(digest);
  });

  it("changes for every admitted coordinate", () => {
    const base = entry("a", "x");
    const digest = canonicalSnapshotDigest([base]);
    expect(canonicalSnapshotDigest([{ ...base, path: "b" }])).not.toBe(digest);
    expect(canonicalSnapshotDigest([{ ...base, mode: 0o100755 }])).not.toBe(digest);
    expect(canonicalSnapshotDigest([{ ...base, size: base.size + 1 }])).not.toBe(digest);
    expect(canonicalSnapshotDigest([entry("a", "y")])).not.toBe(digest);
  });

  it("rejects duplicates and malformed descriptors", () => {
    const valid = entry("a", "x");
    expect(() => canonicalSnapshotDigest([valid, valid])).toThrow("duplicate path");
    expect(() => canonicalSnapshotDigest([{ ...valid, mode: 0o120000 }])).toThrow(
      "regular file mode"
    );
    expect(() => canonicalSnapshotDigest([{ ...valid, contentHash: "ABC" }])).toThrow(
      "lowercase SHA-256"
    );
  });
});
