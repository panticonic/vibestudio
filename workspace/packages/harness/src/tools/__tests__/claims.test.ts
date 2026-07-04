import { describe, it, expect } from "vitest";
import {
  createRecordClaimTool,
  createRelateClaimsTool,
  createReviseClaimTool,
  createRetractClaimTool,
  stripClaimHandle,
  type KnowledgeToolDeps,
  type RecordClaimResult,
} from "../claims.js";

interface Calls {
  record: Array<Parameters<KnowledgeToolDeps["recordClaim"]>[0]>;
  relate: Array<Parameters<KnowledgeToolDeps["relateClaims"]>[0]>;
  revise: Array<Parameters<KnowledgeToolDeps["reviseClaim"]>[0]>;
  retract: Array<Parameters<KnowledgeToolDeps["retractClaim"]>[0]>;
}

function makeDeps(recordResult?: RecordClaimResult): { deps: KnowledgeToolDeps; calls: Calls } {
  const calls: Calls = { record: [], relate: [], revise: [], retract: [] };
  const deps: KnowledgeToolDeps = {
    logId: "branch:channel:ch",
    head: "branch:channel:ch",
    recordClaim: async (input) => {
      calls.record.push(input);
      return recordResult ?? { claimId: "claim-1", ledgerEntryId: "led-1", duplicates: [] };
    },
    relateClaims: async (input) => {
      calls.relate.push(input);
      return { ledgerEntryId: "led-r", related: input.relations.length };
    },
    reviseClaim: async (input) => {
      calls.revise.push(input);
      return { claimId: input.claimId, ledgerEntryId: "led-v" };
    },
    retractClaim: async (input) => {
      calls.retract.push(input);
      return { claimId: input.claimId, ledgerEntryId: "led-x" };
    },
  };
  return { deps, calls };
}

function text(result: { content: ReadonlyArray<unknown> }): string {
  return result.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
}

describe("stripClaimHandle", () => {
  it("strips the claim# prefix and trims", () => {
    expect(stripClaimHandle("claim#claim-42")).toBe("claim-42");
    expect(stripClaimHandle("  claim-42 ")).toBe("claim-42");
  });
});

describe("createRecordClaimTool", () => {
  it("records a text claim on the agent's own trajectory with the toolCallId", async () => {
    const { deps, calls } = makeDeps();
    const tool = createRecordClaimTool(deps);
    const result = await tool.execute("inv-1", { text: "scheduler owns the retry budget", kind: "ownership" });
    expect(calls.record[0]).toMatchObject({
      logId: "branch:channel:ch",
      head: "branch:channel:ch",
      invocationId: "inv-1",
      claim: { text: "scheduler owns the retry budget", kind: "ownership" },
      force: false,
    });
    expect(result.details.recorded).toBe(true);
    expect(text(result)).toContain("Recorded claim#claim-1");
  });

  it("accepts a subject/predicate/object triple", async () => {
    const { deps, calls } = makeDeps();
    const tool = createRecordClaimTool(deps);
    await tool.execute("inv-1", { subject: "scheduler", predicate: "owns", object: "retry budget" });
    expect(calls.record[0]!.claim).toMatchObject({
      subject: "scheduler",
      predicate: "owns",
      object: "retry budget",
    });
  });

  it("surfaces dedup candidates WITHOUT recording, and never blocks", async () => {
    const { deps } = makeDeps({
      duplicates: [{ claimId: "claim-old", text: "the scheduler owns the retry budget", score: 0.9 }],
    });
    const tool = createRecordClaimTool(deps);
    const result = await tool.execute("inv-1", { text: "scheduler owns retry budget" });
    expect(result.details.recorded).toBe(false);
    expect(result.details.duplicates).toBe(1);
    const out = text(result);
    expect(out).toContain("near-duplicate");
    expect(out).toContain("claim#claim-old");
    expect(out).toContain("force:true");
  });

  it("threads force:true through", async () => {
    const { deps, calls } = makeDeps();
    const tool = createRecordClaimTool(deps);
    await tool.execute("inv-1", { text: "a distinct claim", force: true });
    expect(calls.record[0]!.force).toBe(true);
  });
});

describe("createRelateClaimsTool", () => {
  it("asserts one relation, stripping claim# handles", async () => {
    const { deps, calls } = makeDeps();
    const tool = createRelateClaimsTool(deps);
    const result = await tool.execute("inv-1", {
      src: "claim#claim-7",
      relation: "contradicts",
      dst: "claim#claim-9",
    });
    expect(calls.relate[0]).toMatchObject({
      logId: "branch:channel:ch",
      invocationId: "inv-1",
      relations: [{ src: "claim-7", relation: "contradicts", dst: "claim-9" }],
    });
    expect(text(result)).toContain("claim#claim-7 ·contradicts· claim#claim-9");
  });

  it("passes an optional weight", async () => {
    const { deps, calls } = makeDeps();
    const tool = createRelateClaimsTool(deps);
    await tool.execute("inv-1", { src: "claim-1", relation: "supports", dst: "claim-2", weight: 0.5 });
    expect(calls.relate[0]!.relations[0]).toMatchObject({ weight: 0.5 });
  });
});

describe("createReviseClaimTool", () => {
  it("revises with a partial patch", async () => {
    const { deps, calls } = makeDeps();
    const tool = createReviseClaimTool(deps);
    const result = await tool.execute("inv-1", { claimId: "claim#claim-3", text: "updated claim text" });
    expect(calls.revise[0]).toMatchObject({
      claimId: "claim-3",
      invocationId: "inv-1",
      patch: { text: "updated claim text" },
    });
    expect(text(result)).toContain("Revised claim#claim-3");
  });
});

describe("createRetractClaimTool", () => {
  it("retracts a claim", async () => {
    const { deps, calls } = makeDeps();
    const tool = createRetractClaimTool(deps);
    const result = await tool.execute("inv-1", { claimId: "claim-4" });
    expect(calls.retract[0]).toMatchObject({ claimId: "claim-4", invocationId: "inv-1" });
    expect(text(result)).toContain("Retracted claim#claim-4");
  });
});
