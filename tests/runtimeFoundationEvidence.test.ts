import { describe, expect, it } from "vitest";
import { runtimeFoundationEvidence } from "../scripts/runtime-foundation-evidence.mjs";
import {
  assertNoOrphanEvidence,
  resolveLedgerEvidence,
  testEvidence,
  validateEvidenceManifest,
  validateEvidenceRegistry,
  validateRepositoryPath,
} from "../scripts/lib/runtime-foundation-evidence.mjs";

const root = process.cwd();

describe("runtime-foundation evidence contract", () => {
  it("validates every registered repository file before ledger generation", () => {
    expect(() =>
      validateEvidenceRegistry({ root, registry: runtimeFoundationEvidence })
    ).not.toThrow();
  });

  it("rejects invalid and escaping repository paths directly", () => {
    for (const candidate of ["../outside.test.ts", "/absolute.test.ts", "a\\b.test.ts"]) {
      expect(() => validateRepositoryPath(candidate)).toThrow(
        `evidence has invalid repository path ${JSON.stringify(candidate)}`
      );
    }
  });

  it("reports one actionable missing-file error", () => {
    expect(() =>
      validateEvidenceRegistry({
        root,
        registry: {
          tests: { "missing.test": { path: "tests/not-present.test.ts" } },
          sourceContracts: {},
        },
      })
    ).toThrow(
      'runtime-foundation-evidence: evidence "missing.test" points to missing or ignored file tests/not-present.test.ts'
    );
  });

  it("rejects duplicate ids across evidence kinds", () => {
    expect(() =>
      validateEvidenceRegistry({
        root,
        registry: {
          tests: {
            duplicate: { path: "tests/runtimeFoundationEvidence.test.ts" },
          },
          sourceContracts: {
            duplicate: {
              path: "workspace/workers/pubsub-channel/types.ts",
              exportName: "LockedChannelMembershipPolicy",
            },
          },
        },
      })
    ).toThrow('runtime-foundation-evidence: duplicate evidence id "duplicate"');
  });

  it("rejects missing source-contract exports without importing product modules", () => {
    expect(() =>
      validateEvidenceRegistry({
        root,
        registry: {
          tests: {},
          sourceContracts: {
            "channel.missing-export": {
              path: "workspace/workers/pubsub-channel/types.ts",
              exportName: "NotAnExport",
            },
          },
        },
      })
    ).toThrow(
      'runtime-foundation-evidence: source contract "channel.missing-export" cannot find export "NotAnExport" in workspace/workers/pubsub-channel/types.ts'
    );
  });

  it("rejects unknown, orphaned, untyped, and wrong-kind evidence", () => {
    const registry = validateEvidenceRegistry({ root, registry: runtimeFoundationEvidence });
    expect(() =>
      resolveLedgerEvidence({
        ledger: "execution-update-ledger",
        subject: 'surface "planned"',
        evidence: testEvidence("execution.not-implemented"),
        registry,
        used: new Set(),
      })
    ).toThrow(
      'execution-update-ledger: surface "planned" references unknown evidence "execution.not-implemented"'
    );
    expect(() =>
      resolveLedgerEvidence({
        ledger: "execution-update-ledger",
        subject: 'surface "planned"',
        evidence: null,
        registry,
        used: new Set(),
      })
    ).toThrow('execution-update-ledger: surface "planned" has untyped evidence');
    expect(() =>
      resolveLedgerEvidence({
        ledger: "execution-update-ledger",
        subject: 'surface "planned"',
        evidence: { kind: "prose", path: "README.md" },
        registry,
        used: new Set(),
      })
    ).toThrow('execution-update-ledger: surface "planned" uses unknown evidence kind "prose"');
    expect(() => assertNoOrphanEvidence(registry, new Set())).toThrow(
      /registry entry ".+" is not used by any ledger row/
    );
  });

  it("requires registration equality, file agreement, and passing status", () => {
    const registry = {
      tests: {
        "channel.test": { path: "workspace/channel.test.ts" },
      },
      sourceContracts: {},
    };
    expect(() =>
      validateEvidenceManifest({
        registry,
        expectedProjects: ["userland"],
        fragments: [
          {
            project: "userland",
            entries: [
              {
                id: "channel.test",
                file: "workspace/wrong.test.ts",
                project: "userland",
                status: "failed",
              },
              {
                id: "undeclared.test",
                file: "workspace/other.test.ts",
                project: "userland",
                status: "passed",
              },
            ],
          },
        ],
      })
    ).toThrowErrorMatchingInlineSnapshot(`
      [Error: Runtime-foundation evidence is invalid:
      - ledger test "channel.test" ran from workspace/wrong.test.ts; registry expects workspace/channel.test.ts
      - ledger test "channel.test" did not pass (status: failed)
      - declared ledger test "undeclared.test" is absent from the evidence registry]
    `);
  });
});
