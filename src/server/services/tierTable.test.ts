import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_AUTHORITY_METHODS } from "@vibestudio/shared/authority/hostAuthorityCatalog.generated";
import { isKernelResidency } from "@vibestudio/shared/serviceAuthority";

type MatrixTier = {
  tier: string;
  session: string;
  rationale: string;
  residency?: string;
  family?: string;
};
type Matrix = Record<string, { methods: Record<string, { tier?: MatrixTier }> }>;

function readMatrix(relative: string): Matrix {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
  ) as Matrix;
}

describe("reviewed host method tiers", () => {
  const METHOD_TIERS = Object.fromEntries(
    Object.entries(HOST_AUTHORITY_METHODS).map(([method, row]) => [method, row.tier])
  );

  it("is an exact schema-generated census of server and main methods", () => {
    const allMethods = new Set<string>();
    const decisions = new Map<string, { rationale: string; residency: string; family: string }>();
    for (const matrix of [
      readMatrix("./__serviceAuthorityMatrix.golden.json"),
      readMatrix("../../main/services/__serviceAuthorityMatrix.golden.json"),
    ]) {
      for (const [service, entry] of Object.entries(matrix)) {
        for (const [method, declaration] of Object.entries(entry.methods)) {
          const qualifiedMethod = `${service}.${method}`;
          allMethods.add(qualifiedMethod);
          const tier = declaration.tier;
          expect(tier, `${qualifiedMethod} has no schema-owned tier`).toBeDefined();
          if (!tier) throw new Error(`${qualifiedMethod} has no schema-owned tier`);
          expect(tier.residency, `${qualifiedMethod} has no colocated residency`).toBeTypeOf(
            "string"
          );
          expect(tier.family, `${qualifiedMethod} has no colocated mechanism family`).toBeTypeOf(
            "string"
          );
          decisions.set(qualifiedMethod, {
            rationale: tier.rationale,
            residency: tier.residency!,
            family: tier.family!,
          });
        }
      }
    }
    expect(Object.keys(METHOD_TIERS).sort()).toEqual([...allMethods].sort());
    expect(decisions.size).toBe(allMethods.size);
    for (const [method, decision] of decisions) {
      expect(decision.rationale, `${method} has no review rationale`).not.toBe("");
      expect(isKernelResidency(decision.residency), `${method} has invalid residency`).toBe(true);
      expect(decision.family, `${method} has no mechanism family`).toMatch(
        /^[a-z][A-Za-z0-9.-]+$/u
      );
    }
  });

  it("rejects migration markers now that every method has durable residency", () => {
    expect(isKernelResidency("legacy-product:P1")).toBe(false);
  });

  it("admits approved eval sessions to the npm acquisition surface", () => {
    expect(METHOD_TIERS["build.getBuildNpm"]).toMatchObject({
      tier: "gated",
      session: "family",
    });
  });

  it("keeps development workflow out of the kernel and scopes the remaining native seam", () => {
    for (const method of [
      "development.getSession",
      "development.listSessions",
      "development.listRecipes",
      "development.listNativeTools",
      "development.get",
      "development.list",
      "development.events",
      "development.openSession",
      "development.closeSession",
      "development.stop",
      "development.keepRunRepair",
      "development.keepSessionRepair",
      "development.start",
      "development.retry",
      "development.destroySession",
      "development.retrySessionCleanup",
      "development.forceRetireSession",
      "development.forceRetire",
    ] as const) {
      expect(METHOD_TIERS[method]).toBeUndefined();
    }

    expect(METHOD_TIERS["build.inspectExecution"]).toMatchObject({
      tier: "open",
      session: "family",
    });
    expect(METHOD_TIERS["developmentNative.openTool"]).toMatchObject({
      tier: "gated",
      session: "codeOnly",
      residency: "native-effect",
    });

    expect(METHOD_TIERS["developmentNative.retireTool"]).toMatchObject({
      tier: "critical",
      session: "codeOnly",
      residency: "native-effect",
    });
  });
});
