import { describe, it, expect } from "vitest";
import type {
  VcsProvItem,
  VcsProvenanceForFileResult,
  VcsProvenanceForSessionResult,
} from "@vibestudio/shared/serviceSchemas/vcs";
import { createProvenanceTool, type ProvenanceToolDeps } from "../provenance.js";

const CWD = "/";

function item(line: string, handle: string, exception = false): VcsProvItem {
  return { line, handle, kind: "claim", exception, score: exception ? 0 : 1 };
}

interface DepCalls {
  file: Array<Record<string, unknown>>;
  claim: Array<Record<string, unknown>>;
  session: Array<Record<string, unknown>>;
}

function makeDeps(overrides: Partial<ProvenanceToolDeps> = {}): {
  deps: ProvenanceToolDeps;
  calls: DepCalls;
} {
  const calls: DepCalls = {
    file: [],
    claim: [],
    session: [],
  };
  const fileResult: VcsProvenanceForFileResult = {
    items: [item("claim#42 owns retry budget", "claim#42")],
    shown: 1,
    total: 3,
    nextCursor: "1",
    suppressed: false,
  };
  const sessionResult: VcsProvenanceForSessionResult = {
    items: [item("⚠ unreconciled contradiction claim#7", "claim#7", true)],
    shown: 1,
    total: 1,
  };
  const deps: ProvenanceToolDeps = {
    provenanceForFile: async (input) => {
      calls.file.push(input);
      return fileResult;
    },
    provenanceForClaim: async (input) => {
      calls.claim.push(input);
      return { ...fileResult, items: [item("claim#42 ·supports· claim#7", "claim#7")] };
    },
    provenanceForSession: async (input) => {
      calls.session.push(input);
      return sessionResult;
    },
    head: "ctx:c1",
    sessionLogId: "branch:channel:ch",
    sessionHead: "branch:channel:ch",
    ...overrides,
  };
  return { deps, calls };
}

describe("createProvenanceTool", () => {
  it("drills a file path with deep tier + skipSuppression and pages the tail", async () => {
    const { deps, calls } = makeDeps();
    const tool = createProvenanceTool(CWD, deps);
    const result = await tool.execute("inv-1", { target: "packages/foo/bar.ts" });
    expect(calls.file[0]).toMatchObject({
      repoPath: "packages/foo",
      path: "packages/foo/bar.ts",
      head: "ctx:c1",
      tier: "deep",
      skipSuppression: true,
      invocationId: "inv-1",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("prov · packages/foo/bar.ts · 1 of 3 items");
    // Pageable footer threads the cursor for the next page.
    expect(text).toContain('+2 more → provenance("packages/foo/bar.ts", after "1")');
    expect(result.details).toMatchObject({ shown: 1, total: 3, nextCursor: "1" });
  });

  it("accepts a file: handle prefix", async () => {
    const { deps, calls } = makeDeps();
    const tool = createProvenanceTool(CWD, deps);
    await tool.execute("inv-1", { target: "file:workers/x/index.ts" });
    expect(calls.file[0]).toMatchObject({ repoPath: "workers/x", path: "workers/x/index.ts" });
  });

  it("drills a claim handle (cited touch is DO-side)", async () => {
    const { deps, calls } = makeDeps();
    const tool = createProvenanceTool(CWD, deps);
    const result = await tool.execute("inv-9", { target: "claim#42", after: "0" });
    expect(calls.claim[0]).toMatchObject({
      claimId: "42",
      sessionLogId: "branch:channel:ch",
      invocationId: "inv-9",
      after: "0",
    });
    expect((result.content[0] as { text: string }).text).toContain("prov · claim#42 ·");
  });

  it("orients on the whole session", async () => {
    const { deps, calls } = makeDeps();
    const tool = createProvenanceTool(CWD, deps);
    const result = await tool.execute("inv-1", { target: "session" });
    expect(calls.session[0]).toMatchObject({
      sessionLogId: "branch:channel:ch",
      sessionHead: "branch:channel:ch",
    });
    expect((result.content[0] as { text: string }).text).toContain("prov · session · 1 of 1 items");
  });

  it("defaults an omitted target to whole-session orientation", async () => {
    const { deps, calls } = makeDeps();
    const tool = createProvenanceTool(CWD, deps);
    const result = await tool.execute("inv-1", {});
    expect(calls.session).toHaveLength(1);
    expect(result.details.target).toBe("session");
  });

  it("treats a session:<head> handle as session orientation", async () => {
    const { deps, calls } = makeDeps();
    const tool = createProvenanceTool(CWD, deps);
    await tool.execute("inv-1", { target: "session:other" });
    expect(calls.session).toHaveLength(1);
  });

  it("returns guidance (never a dead end) for a commit handle", async () => {
    const { deps, calls } = makeDeps();
    const tool = createProvenanceTool(CWD, deps);
    const result = await tool.execute("inv-1", { target: "commit:9f2e" });
    expect((result.content[0] as { text: string }).text).toContain("not independently drillable");
    expect(calls.file).toHaveLength(0);
    expect(calls.claim).toHaveLength(0);
  });

  it("reports non-repo file targets without calling the DO", async () => {
    const { deps, calls } = makeDeps();
    const tool = createProvenanceTool(CWD, deps);
    const result = await tool.execute("inv-1", { target: "loose.txt" });
    expect((result.content[0] as { text: string }).text).toContain("not inside any repo");
    expect(calls.file).toHaveLength(0);
  });
});
