import { describe, expect, it } from "vitest";
import { EVAL_CAPABILITY_ACQUISITION_LEDGER } from "./evalInvocationExposure.generated.js";
import { resolveEvalDirectSurface } from "./evalDirectSurface.js";

describe("resolveEvalDirectSurface", () => {
  it("resolves inherited direct methods by canonical capability", () => {
    expect(resolveEvalDirectSurface("workers/agent-worker", "subscribeChannel")).toMatchObject({
      source: "packages/agentic-do",
      method: "subscribeChannel",
      capability: "rpc:subscribeChannel",
      sensitivity: "write",
      acquisition: { kind: "baseline" },
    });
  });

  it("prefers an exact definition source when present", () => {
    const source = "product/browser-data";
    const row = EVAL_CAPABILITY_ACQUISITION_LEDGER.find(
      (candidate) =>
        candidate.rpcPlane === "workspace-do" &&
        "source" in candidate &&
        candidate.source === source
    )!;
    expect(resolveEvalDirectSurface(source, row.method)).toBe(row);
  });

  it("fails closed for an undeclared direct method", () => {
    expect(() => resolveEvalDirectSurface("workers/agent-worker", "notReviewed")).toThrow(
      expect.objectContaining({ code: "EVAL_CAPABILITY_CLOSED" })
    );
  });

  it("fails closed when an unreviewed runtime source happens to name a reviewed method", () => {
    expect(() => resolveEvalDirectSurface("workers/unreviewed", "subscribeChannel")).toThrow(
      expect.objectContaining({ code: "EVAL_CAPABILITY_CLOSED" })
    );
  });

  it("keeps duplicate direct capability policies globally consistent", () => {
    const signatures = new Map<string, Set<string>>();
    for (const row of EVAL_CAPABILITY_ACQUISITION_LEDGER) {
      if (row.rpcPlane !== "workspace-do") continue;
      const values = signatures.get(row.capability) ?? new Set<string>();
      values.add(
        JSON.stringify({
          acquisition: row.acquisition,
          sensitivity: "sensitivity" in row ? row.sensitivity : null,
        })
      );
      signatures.set(row.capability, values);
    }
    expect([...signatures].filter(([, values]) => values.size !== 1)).toEqual([]);
  });
});
