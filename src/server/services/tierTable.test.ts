import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { METHOD_TIERS } from "@vibestudio/shared/authority/tierTable";

type Matrix = Record<string, { methods: Record<string, unknown> }>;

function readMatrix(relative: string): Matrix {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
  ) as Matrix;
}

describe("reviewed host method tiers", () => {
  it("is an exact, non-orphaned census of server and main methods", () => {
    const methods = new Set<string>();
    for (const matrix of [
      readMatrix("./__serviceAuthorityMatrix.golden.json"),
      readMatrix("../../main/services/__serviceAuthorityMatrix.golden.json"),
    ]) {
      for (const [service, entry] of Object.entries(matrix)) {
        for (const method of Object.keys(entry.methods)) methods.add(`${service}.${method}`);
      }
    }
    expect(Object.keys(METHOD_TIERS).sort()).toEqual([...methods].sort());
    for (const [method, decision] of Object.entries(METHOD_TIERS)) {
      expect(decision.rationale, `${method} has no review rationale`).not.toBe("");
    }
  });

  it("admits approved eval sessions to the npm acquisition surface", () => {
    expect(METHOD_TIERS["build.getBuildNpm"]).toMatchObject({
      tier: "gated",
      session: "family",
    });
  });
});
