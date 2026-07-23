import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type ParityRow = {
  id: string;
  className: string;
  method: string;
  kind: "call" | "event" | "host-control" | "inherited-call";
  mergeBaseGuard: string;
  currentDeclaration: string;
  comparison: "equivalent" | "WIDER" | "narrower" | "undeclared" | "absent-method";
  disposition: "tighten" | "keep" | "reviewed-widening";
  rationale: string;
};

const root = process.cwd();
const worksheet = JSON.parse(
  fs.readFileSync(path.join(root, "docs/runtime-foundations/p1-parity-worksheet.json"), "utf8")
) as { mergeBase: string; rows: ParityRow[] };
const authorityLedger = JSON.parse(
  fs.readFileSync(path.join(root, "docs/runtime-foundations/authority-ledger.json"), "utf8")
) as { rows: Array<{ rpcPlane: string; owner: string; method: string }> };

const owners = new Map([
  ["src/server/internalDOs/browserDataDO.ts", "BrowserDataDO"],
  ["src/server/internalDOs/workspaceDO.ts", "WorkspaceDO"],
  ["src/server/internalDOs/evalDO.ts", "EvalDO"],
  ["src/server/internalDOs/webhookStoreDO.ts", "WebhookStoreDO"],
]);

describe("P1 receiver parity worksheet", () => {
  it("covers every live direct-RPC declaration on guarded internal receivers", () => {
    const expected = authorityLedger.rows
      .filter((row) => row.rpcPlane === "workspace-do" && owners.has(row.owner))
      .map((row) => `${owners.get(row.owner)}.${row.method}`)
      .sort();
    const actual = worksheet.rows
      .filter((row) => row.kind === "call")
      .map((row) => row.id)
      .sort();
    expect(actual).toEqual(expected);
  });

  it("contains no unreviewed widening or incomplete disposition", () => {
    for (const row of worksheet.rows) {
      expect(row.disposition).toMatch(/^(tighten|keep|reviewed-widening)$/);
      expect(row.rationale.trim()).not.toBe("");
      if (row.comparison === "WIDER") expect(row.disposition).toBe("reviewed-widening");
    }
  });

  it("expresses the BrowserData broker as an exact code-source relationship", () => {
    const calls = worksheet.rows.filter(
      (row) => row.className === "BrowserDataDO" && row.kind === "call"
    );
    expect(calls).toHaveLength(57);
    expect(
      calls.every((row) => row.currentDeclaration.includes("code-source:<manifest-broker>"))
    ).toBe(true);
    expect(calls.every((row) => row.comparison !== "WIDER")).toBe(true);
  });

  it("keeps legacy guards installed while parity evidence soaks", () => {
    for (const file of owners.keys()) {
      expect(fs.readFileSync(path.join(root, file), "utf8")).toContain("assertInboundAllowed(");
    }
  });
});
