import { describe, expect, it } from "vitest";
import { contextIdToPartition } from "./contextIdToPartition.js";

describe("workspace context native storage", () => {
  it("shares storage only within the same workspace and context", () => {
    expect(contextIdToPartition("personal", "main")).toBe(contextIdToPartition("personal", "main"));
    expect(contextIdToPartition("personal", "main")).not.toBe(contextIdToPartition("untrusted", "main"));
    expect(contextIdToPartition("personal", "main")).not.toBe(contextIdToPartition("personal", "branch"));
  });

  it("cannot collide through delimiters or encoded names", () => {
    const identities = [["a:b", "c"], ["a", "b:c"], ["a%3Ab", "c"], ["a/b", "c"], ["a", "b/c"]];
    const partitions = identities.map(([workspace, context]) => contextIdToPartition(workspace!, context!));
    expect(new Set(partitions).size).toBe(identities.length);
  });

  it("cannot fall back to a shared default partition when identity is missing", () => {
    expect(() => contextIdToPartition("", "main")).toThrow("identities are required");
    expect(() => contextIdToPartition("workspace", "")).toThrow("identities are required");
  });
});
