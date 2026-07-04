import { describe, it, expect } from "vitest";
import { createCommitTool, type CommitClaimsDeps } from "../commit.js";
import type { RecordClaimResult } from "../claims.js";
import { StubVcs } from "./stub-vcs.js";

type RecordClaimInput = Parameters<CommitClaimsDeps["recordClaim"]>[0];

function makeKnowledge(responses: RecordClaimResult[] = []): {
  deps: CommitClaimsDeps;
  calls: RecordClaimInput[];
} {
  const calls: RecordClaimInput[] = [];
  const queue = [...responses];
  const deps: CommitClaimsDeps = {
    logId: "branch:channel:ch",
    head: "branch:channel:ch",
    recordClaim: async (input) => {
      calls.push(input);
      return (
        queue.shift() ?? {
          claimId: `claim-${calls.length}`,
          ledgerEntryId: `l${calls.length}`,
          duplicates: [],
        }
      );
    },
  };
  return { deps, calls };
}

function text(result: { content: ReadonlyArray<unknown> }): string {
  return result.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
}

describe("createCommitTool", () => {
  it("commits and stamps the toolCallId as invocationId (T1/T2)", async () => {
    const vcs = new StubVcs();
    const { deps } = makeKnowledge();
    const tool = createCommitTool(vcs, deps);
    const result = await tool.execute("call-7", { message: "fix the retry budget" });
    expect(vcs.lastCommitInput?.invocationId).toBe("call-7");
    expect(vcs.lastCommitInput?.message).toBe("fix the retry budget");
    expect(result.details.committed).toBe(1);
    expect(text(result)).toContain("committed meta");
  });

  it("records claims anchored to the commit event, never via vcs", async () => {
    const vcs = new StubVcs({ commitResult: { changedPaths: ["a.ts"], editCount: 1 } });
    const { deps, calls } = makeKnowledge([
      { claimId: "claim-abc", ledgerEntryId: "led-1", duplicates: [] },
    ]);
    const tool = createCommitTool(vcs, deps);
    const result = await tool.execute("call-1", {
      message: "seal retry budget owner",
      repoPaths: ["packages/x"],
      claims: [{ text: "retry budget is owned by the scheduler", kind: "ownership" }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      logId: "branch:channel:ch",
      head: "branch:channel:ch",
      invocationId: "call-1",
      claim: { text: "retry budget is owned by the scheduler", kind: "ownership" },
      anchor: { commitEventId: "event-1", repoPath: "packages/x" },
    });
    expect(result.details.claimsRecorded).toEqual(["claim-abc"]);
    expect(text(result)).toContain("recorded claim#claim-abc");
    // No claims were passed to vcs.commit — layering stays clean.
    expect(vcs.lastCommitInput).not.toHaveProperty("claims");
  });

  it("does not guess a commit anchor for multi-repo claims, and honors explicit repoPath", async () => {
    const vcs = new StubVcs({ commitResult: { changedPaths: ["a.ts"], editCount: 1 } });
    const { deps, calls } = makeKnowledge([
      { claimId: "claim-b", ledgerEntryId: "led-b", duplicates: [] },
      { claimId: "claim-general", ledgerEntryId: "led-general", duplicates: [] },
    ]);
    const tool = createCommitTool(vcs, deps);
    const result = await tool.execute("call-1", {
      message: "seal two repos",
      repoPaths: ["packages/a", "packages/b"],
      claims: [
        { text: "repo b owns the scheduler boundary", repoPath: "packages/b" },
        { text: "the two repos share a rollout concern" },
      ],
    });

    expect(calls[0]).toMatchObject({
      anchor: { commitEventId: "event-1-2", repoPath: "packages/b" },
    });
    expect(calls[1]).not.toHaveProperty("anchor");
    expect(result.details.claimsRecorded).toEqual(["claim-b", "claim-general"]);
    expect(text(result)).toContain("claim left unanchored");
  });

  it("surfaces dedup candidates but never blocks the commit", async () => {
    const vcs = new StubVcs({ commitResult: { changedPaths: ["a.ts"], editCount: 1 } });
    const { deps } = makeKnowledge([
      {
        duplicates: [
          { claimId: "claim-old", text: "scheduler owns the retry budget", score: 0.82 },
        ],
      },
    ]);
    const tool = createCommitTool(vcs, deps);
    const result = await tool.execute("call-1", {
      message: "seal retry budget owner",
      claims: [{ text: "retry budget owned by scheduler" }],
    });
    expect(result.details.committed).toBe(1);
    expect(result.details.claimsRecorded).toEqual([]);
    expect(result.details.claimDuplicates).toBe(1);
    const out = text(result);
    expect(out).toContain("committed");
    expect(out).toContain("near-duplicate");
    expect(out).toContain("claim#claim-old");
  });

  it("nudges on a non-trivial diff (>=3 files) when no claims were passed", async () => {
    const vcs = new StubVcs({
      commitResult: { changedPaths: ["a.ts", "b.ts", "c.ts"], editCount: 3 },
    });
    const { deps } = makeKnowledge();
    const tool = createCommitTool(vcs, deps);
    const result = await tool.execute("call-1", { message: "refactor across files" });
    expect(result.details.nudged).toBe(true);
    expect(text(result)).toContain("Anything durable to record?");
  });

  it("does NOT nudge when claims were passed", async () => {
    const vcs = new StubVcs({
      commitResult: { changedPaths: ["a.ts", "b.ts", "c.ts"], editCount: 3 },
    });
    const { deps } = makeKnowledge();
    const tool = createCommitTool(vcs, deps);
    const result = await tool.execute("call-1", {
      message: "refactor across files",
      claims: [{ text: "the three files share one ownership boundary" }],
    });
    expect(result.details.nudged).toBe(false);
    expect(text(result)).not.toContain("Anything durable to record?");
  });

  it("does NOT nudge on a trivial diff", async () => {
    const vcs = new StubVcs({ commitResult: { changedPaths: ["a.ts"], editCount: 1 } });
    const { deps } = makeKnowledge();
    const tool = createCommitTool(vcs, deps);
    const result = await tool.execute("call-1", { message: "one small fix" });
    expect(result.details.nudged).toBe(false);
  });

  it("fails loudly when commit returns no committed snapshots", async () => {
    const vcs = new StubVcs({
      commitResult: { status: "unchanged", changedPaths: [], editCount: 0 },
    });
    const tool = createCommitTool(vcs, makeKnowledge().deps);

    await expect(tool.execute("call-1", { message: "no-op" })).rejects.toThrow(
      /commit produced no snapshots.*scratch\/direct fs writes.*outside VCS/s
    );
  });

  it("fails loudly when any requested repo comes back unchanged", async () => {
    class MixedCommitVcs extends StubVcs {
      override async commit(input: Parameters<StubVcs["commit"]>[0]) {
        this.lastCommitInput = input;
        return [
          {
            repoPath: "packages/a",
            head: "ctx:test",
            stateHash: "state-1",
            eventId: "event-a",
            headHash: "head-a",
            editCount: 1,
            status: "committed" as const,
            changedPaths: ["a.ts"],
          },
          {
            repoPath: "packages/b",
            head: "ctx:test",
            stateHash: "state-1",
            eventId: null,
            headHash: null,
            editCount: 0,
            status: "unchanged" as const,
            changedPaths: [],
          },
        ];
      }
    }
    const vcs = new MixedCommitVcs();
    const tool = createCommitTool(vcs, makeKnowledge().deps);

    await expect(
      tool.execute("call-1", { message: "multi", repoPaths: ["packages/a", "packages/b"] })
    ).rejects.toThrow(/commit returned unchanged repo\(s\).*packages\/b/s);
  });

  it("ignores claims when the agent class has no knowledge client", async () => {
    const vcs = new StubVcs({ commitResult: { changedPaths: ["a.ts"], editCount: 1 } });
    const tool = createCommitTool(vcs);
    const result = await tool.execute("call-1", {
      message: "commit without a DO",
      claims: [{ text: "durable insight that will be dropped" }],
    });
    expect(result.details.committed).toBe(1);
    expect(result.details.claimsRecorded).toEqual([]);
  });

  it("rejects an empty message", async () => {
    const vcs = new StubVcs();
    const tool = createCommitTool(vcs, makeKnowledge().deps);
    await expect(tool.execute("call-1", { message: "   " })).rejects.toThrow(/non-empty message/);
  });
});
