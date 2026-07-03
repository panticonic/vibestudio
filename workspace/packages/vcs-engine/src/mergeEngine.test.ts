import { describe, expect, it } from "vitest";
import { MergeEngine, type MergeEngineDeps, type StateFileEntry } from "./mergeEngine.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** In-memory content store + state table backing the engine deps. */
function makeStore() {
  const blobs = new Map<string, Uint8Array>();
  const states = new Map<string, StateFileEntry[]>();
  const bases = new Map<string, string | null>();
  let seq = 0;

  const putBlob = (bytes: Uint8Array): string => {
    const digest = `d${(seq += 1).toString(16).padStart(4, "0")}`;
    blobs.set(digest, bytes);
    return digest;
  };
  const putText = (text: string): string => putBlob(enc.encode(text));

  const deps: MergeEngineDeps = {
    async listStateFiles(stateHash) {
      const files = states.get(stateHash);
      if (!files) throw new Error(`unknown state ${stateHash}`);
      return files;
    },
    async getMergeBase(left, right) {
      return bases.get(`${left}|${right}`) ?? null;
    },
    async readBlob(digest) {
      return blobs.get(digest) ?? null;
    },
    async writeBlob(bytes) {
      return { digest: putBlob(bytes), size: bytes.length };
    },
  };

  return {
    deps,
    blobs,
    putText,
    putBlob,
    setState(hash: string, files: StateFileEntry[]) {
      states.set(hash, files);
    },
    setBase(left: string, right: string, base: string | null) {
      bases.set(`${left}|${right}`, base);
    },
    text(digest: string): string {
      const bytes = blobs.get(digest);
      if (!bytes) throw new Error(`no blob ${digest}`);
      return dec.decode(bytes);
    },
  };
}

const file = (path: string, contentHash: string, mode = 33188): StateFileEntry => ({
  path,
  contentHash,
  mode,
});

describe("MergeEngine (userland)", () => {
  it("is up-to-date when ours === theirs (no dep calls at all)", async () => {
    const engine = new MergeEngine({
      listStateFiles: () => Promise.reject(new Error("unexpected")),
      getMergeBase: () => Promise.reject(new Error("unexpected")),
      readBlob: () => Promise.reject(new Error("unexpected")),
      writeBlob: () => Promise.reject(new Error("unexpected")),
    });
    const result = await engine.compute("state:x", "state:x", { ours: "a", theirs: "b" });
    expect(result.status).toBe("up-to-date");
  });

  it("is up-to-date when the base IS theirs (theirs contained in ours)", async () => {
    const s = makeStore();
    s.setBase("state:ours", "state:theirs", "state:theirs");
    const engine = new MergeEngine(s.deps);
    const result = await engine.compute("state:ours", "state:theirs", { ours: "o", theirs: "t" });
    expect(result.status).toBe("up-to-date");
  });

  it("fast-forwards when the base IS ours", async () => {
    const s = makeStore();
    const a = s.putText("one\n");
    s.setState("state:base", [file("a.txt", a)]);
    s.setState("state:theirs", [file("a.txt", a), file("b.txt", s.putText("two\n"))]);
    s.setBase("state:base", "state:theirs", "state:base");
    const engine = new MergeEngine(s.deps);
    const result = await engine.compute("state:base", "state:theirs", { ours: "o", theirs: "t" });
    expect(result.status).toBe("fast-forward");
    expect(result.files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("merges non-overlapping text edits cleanly through diff3 (writes the merged blob)", async () => {
    const s = makeStore();
    const base = s.putText("line1\nline2\nline3\n");
    const ours = s.putText("OURS\nline2\nline3\n");
    const theirs = s.putText("line1\nline2\nTHEIRS\n");
    s.setState("state:base", [file("shared.txt", base)]);
    s.setState("state:ours", [file("shared.txt", ours)]);
    s.setState("state:theirs", [file("shared.txt", theirs)]);
    s.setBase("state:ours", "state:theirs", "state:base");

    const result = await new MergeEngine(s.deps).compute("state:ours", "state:theirs", {
      ours: "ctx:1",
      theirs: "main",
    });
    expect(result.status).toBe("clean");
    expect(result.conflicts).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(s.text(result.files[0]!.contentHash)).toBe("OURS\nline2\nTHEIRS\n");
    expect(result.files[0]!.size).toBeGreaterThan(0);
  });

  it("emits labeled conflict markers for overlapping edits", async () => {
    const s = makeStore();
    const base = s.putText("line1\nline2\n");
    const ours = s.putText("OURS\nline2\n");
    const theirs = s.putText("THEIRS\nline2\n");
    s.setState("state:base", [file("shared.txt", base)]);
    s.setState("state:ours", [file("shared.txt", ours)]);
    s.setState("state:theirs", [file("shared.txt", theirs)]);
    s.setBase("state:ours", "state:theirs", "state:base");

    const result = await new MergeEngine(s.deps).compute("state:ours", "state:theirs", {
      ours: "ctx:1",
      theirs: "main",
    });
    expect(result.status).toBe("conflicted");
    expect(result.conflicts).toEqual([{ path: "shared.txt", kind: "content" }]);
    const merged = s.text(result.files[0]!.contentHash);
    expect(merged).toContain("<<<<<<< ctx:1");
    expect(merged).toContain(">>>>>>> main");
  });

  it("takes one-sided changes, additions, and deletions without content reads", async () => {
    const s = makeStore();
    const keep = s.putText("keep\n");
    const oursOnly = s.putText("ours change\n");
    s.setState("state:base", [file("changed.txt", keep), file("deleted.txt", keep)]);
    s.setState("state:ours", [file("changed.txt", oursOnly), file("deleted.txt", keep)]);
    s.setState("state:theirs", [file("changed.txt", keep), file("added.txt", s.putText("new\n"))]);
    s.setBase("state:ours", "state:theirs", "state:base");

    const result = await new MergeEngine(s.deps).compute("state:ours", "state:theirs", {
      ours: "o",
      theirs: "t",
    });
    expect(result.status).toBe("clean");
    expect(result.files.map((f) => f.path).sort()).toEqual(["added.txt", "changed.txt"]);
    expect(result.files.find((f) => f.path === "changed.txt")!.contentHash).toBe(oursOnly);
  });

  it("flags delete-vs-change and keeps the surviving change", async () => {
    const s = makeStore();
    const base = s.putText("original\n");
    const changed = s.putText("changed\n");
    s.setState("state:base", [file("doc.txt", base)]);
    s.setState("state:ours", []); // ours deleted
    s.setState("state:theirs", [file("doc.txt", changed)]);
    s.setBase("state:ours", "state:theirs", "state:base");

    const result = await new MergeEngine(s.deps).compute("state:ours", "state:theirs", {
      ours: "o",
      theirs: "t",
    });
    expect(result.status).toBe("conflicted");
    expect(result.conflicts).toEqual([{ path: "doc.txt", kind: "delete-vs-change" }]);
    expect(result.files).toEqual([
      { path: "doc.txt", contentHash: changed, size: 0, mode: 33188 },
    ]);
  });

  it("flags binary conflicts (ours wins provisionally)", async () => {
    const s = makeStore();
    const base = s.putBlob(new Uint8Array([0, 1, 2]));
    const ours = s.putBlob(new Uint8Array([0, 9, 9]));
    const theirs = s.putBlob(new Uint8Array([0, 5, 5]));
    s.setState("state:base", [file("bin.dat", base)]);
    s.setState("state:ours", [file("bin.dat", ours)]);
    s.setState("state:theirs", [file("bin.dat", theirs)]);
    s.setBase("state:ours", "state:theirs", "state:base");

    const result = await new MergeEngine(s.deps).compute("state:ours", "state:theirs", {
      ours: "o",
      theirs: "t",
    });
    expect(result.conflicts).toEqual([{ path: "bin.dat", kind: "binary" }]);
    expect(result.files[0]!.contentHash).toBe(ours);
  });

  it("merges a one-sided chmod with the other side's content edit; flags dual chmod", async () => {
    const s = makeStore();
    const base = s.putText("#!/bin/sh\necho one\n");
    const theirsContent = s.putText("#!/bin/sh\necho two\n");
    s.setState("state:base", [file("run.sh", base, 33188)]);
    s.setState("state:ours", [file("run.sh", base, 33261)]); // ours: +x only
    s.setState("state:theirs", [file("run.sh", theirsContent, 33188)]);
    s.setBase("state:ours", "state:theirs", "state:base");

    const result = await new MergeEngine(s.deps).compute("state:ours", "state:theirs", {
      ours: "o",
      theirs: "t",
    });
    expect(result.status).toBe("clean");
    const merged = result.files[0]!;
    expect(merged.mode).toBe(33261);
    expect(s.text(merged.contentHash)).toBe("#!/bin/sh\necho two\n");

    // Dual chmod to DIFFERENT modes conflicts (ours kept). Same content hash
    // on both sides so this exercises the mode arm alone.
    s.setState("state:ours2", [file("run.sh", base, 33261)]);
    s.setState("state:theirs2", [file("run.sh", base, 32768)]);
    s.setBase("state:ours2", "state:theirs2", "state:base");
    const dual = await new MergeEngine(s.deps).compute("state:ours2", "state:theirs2", {
      ours: "o",
      theirs: "t",
    });
    expect(dual.conflicts).toEqual([{ path: "run.sh", kind: "mode" }]);
    expect(dual.files[0]!.mode).toBe(33261);
  });

  it("merges from the empty base when histories are unrelated (add/add different → conflict)", async () => {
    const s = makeStore();
    s.setState("state:ours", [file("f.txt", s.putText("a\n"))]);
    s.setState("state:theirs", [file("f.txt", s.putText("b\n"))]);
    s.setBase("state:ours", "state:theirs", null);

    const result = await new MergeEngine(s.deps).compute("state:ours", "state:theirs", {
      ours: "o",
      theirs: "t",
    });
    expect(result.status).toBe("conflicted");
    expect(result.conflicts).toEqual([{ path: "f.txt", kind: "content" }]);
    expect(result.baseStateHash).toBeNull();
  });

  it("compute3 uses the supplied base without a merge-base lookup", async () => {
    const s = makeStore();
    const base = s.putText("x\n");
    const oursHash = s.putText("x\ny\n");
    s.setState("state:base", [file("f.txt", base)]);
    s.setState("state:ours", [file("f.txt", oursHash)]);
    s.setState("state:theirs", [file("f.txt", base), file("g.txt", s.putText("g\n"))]);
    // No setBase — getMergeBase must not be consulted.
    const engine = new MergeEngine({
      ...s.deps,
      getMergeBase: () => Promise.reject(new Error("must not be called")),
    });
    const result = await engine.compute3(
      { base: "state:base", ours: "state:ours", theirs: "state:theirs" },
      { ours: "o", theirs: "t" }
    );
    expect(result.status).toBe("clean");
    expect(result.files.map((f) => f.path).sort()).toEqual(["f.txt", "g.txt"]);
  });

  it("throws loudly when a referenced blob is missing from the CAS", async () => {
    const s = makeStore();
    const base = s.putText("1\n");
    s.setState("state:base", [file("f.txt", base)]);
    s.setState("state:ours", [file("f.txt", "d-missing")]);
    s.setState("state:theirs", [file("f.txt", s.putText("2\n"))]);
    s.setBase("state:ours", "state:theirs", "state:base");

    await expect(
      new MergeEngine(s.deps).compute("state:ours", "state:theirs", { ours: "o", theirs: "t" })
    ).rejects.toThrow("blob missing from CAS: d-missing");
  });
});
