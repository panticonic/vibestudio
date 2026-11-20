import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectWorkflowCoverage } from "./natlang-workflow-coverage.mjs";

test("workflow coverage lists mounted entry points and leaves ambiguous cases unattributed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "natlang-workflow-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkouts = Object.fromEntries(
    ["base", "system", "harness"].map((id) => [id, path.join(root, id)])
  );
  async function write(template, file, content = "") {
    const filename = path.join(checkouts[template], file);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
  await write(
    "base",
    "skills/vibestudio-workflows/natlang.json",
    JSON.stringify({
      workspaceModules: {
        "runWorkflow/domains/api": "skills/api/natlang",
        "runWorkflow/domains/harness": "skills/harness/natlang",
        "runWorkflow/domains/system": "skills/system/natlang",
      },
    })
  );
  await Promise.all([
    write("base", "meta/vibestudio.yml", "template: { name: Base }"),
    write("harness", "meta/vibestudio.yml", "template: { name: Harness }"),
    write("harness", "skills/harness/natlang/inspectCase.nl"),
    write("system", "meta/vibestudio.yml",
      "template:\n  dependencies:\n    - url: git+https://github.com/example/base.git\n"),
    write("base", "skills/api/SKILL.md"),
    write("base", "skills/api/natlang/review.nl"),
    write("base", "skills/api/natlang/natlang.json",
      JSON.stringify({ include: ["review.nl", "review", "summarize.nl", "tail.nl", "support"] })),
    write("base", "skills/api/natlang/review/lookup.nl", "---\nuses: [summarize, support/checksum, missing]\n---\nLook up a record."),
    write("base", "skills/api/natlang/review/lookup/confirm.nl", "Confirm the lookup."),
    write("base", "skills/api/natlang/support/checksum.ts", "export const checksum: string = 'address';"),
    write("base", "skills/api/natlang/review/types.ts", "export type RecordId = string;"),
    write("base", "skills/api/natlang/review/lookup.d.nl.ts", "export {};"),
    write("base", "skills/api/natlang/summarize.nl", "---\nuses:\n- tail\n---\nSummarize the record."),
    write("base", "skills/api/natlang/tail.nl", "Read the final entry."),
    write("base", "skills/api/natlang/unmounted.nl", "This source is outside the include list."),
    write("base", "skills/vibestudio-workflows/runWorkflow/operate.nl"),
    write("base", "skills/vibestudio-workflows/runWorkflow.nl", "Run the assigned operation."),
    write("system", "skills/system/SKILL.md", "`[Example only](natlang/review.nl)`"),
    write("system", "skills/system/natlang/review.nl"),
    write(
      "system",
      "skills/local-only/SKILL.md",
      "[External workflow](../system/natlang/review.nl#use)\n\n" +
        "`[Quoted command](../../skills/system/natlang/review.nl)`\n"
    ),
    write("system", "skills/local-only/read.nl"),
    write(
      "system",
      "skills/cross-template/SKILL.md",
      "[Base workflow](https://github.com/example/base/blob/main/skills/api/natlang/review.nl#use)\n" +
        "[Outside repository](https://github.com/someone/base/blob/main/skills/vibestudio-workflows/runWorkflow/operate.nl)\n" +
        "[Unrelated branch](https://github.com/example/base/blob/other/skills/vibestudio-workflows/runWorkflow/operate.nl)\n" +
        "[Nested helper](https://github.com/example/base/blob/main/skills/api/natlang/review/lookup.nl)\n"
    ),
  ]);
  for (const cwd of Object.values(checkouts)) {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
  }
  execFileSync("git", ["remote", "add", "origin", "git@github.com:example/base.git"], {
    cwd: checkouts.base,
  });
  const coverage = await inspectWorkflowCoverage(checkouts, [
    { id: "managed-direct", workspace: "system", execution: "managed-workspace", operations: ["operate"],
      program: "skills/vibestudio-workflows/runWorkflow.nl" },
    { id: "managed-unambiguous", workspace: "base", execution: "managed-workspace", operations: ["review"] },
    { id: "managed-overlap", workspace: "base", execution: "managed-workspace", operations: ["review", "summarize"] },
    { id: "managed-ambiguous", workspace: "system", execution: "managed-workspace", operations: ["review"] },
    { id: "managed-missing", workspace: "system", execution: "managed-workspace", operations: ["lookup"] },
    { id: "managed-harness", workspace: "system", execution: "managed-workspace", operations: ["inspectCase"] },
    { id: "managed-wrong-workspace", workspace: "base", execution: "managed-workspace", operations: ["inspectCase"] },
    {
      id: "scoped-api",
      execution: "scoped-fixture",
      program: "skills/vibestudio-workflows/runWorkflow.nl",
      request: { work: [{ kind: "domain", domain: "api", operation: "review" }] },
    },
  ], [
    { id: "base", url: "git+https://github.com/example/base.git" },
    { id: "system", url: "git+https://github.com/example/system.git" },
    { id: "harness", url: "git+https://github.com/example/harness.git", role: "development", consumers: ["system"] },
  ]);
  assert.deepEqual(coverage.workspaceSources, {
    base: ["base"],
    system: ["base", "harness", "system"],
    harness: ["harness"],
  });
  assert.deepEqual(
    coverage.callables.find(({ callable }) => callable === "api/review").programShape,
    { naturalLanguageFiles: 5, typeScriptModules: 1, maxCallableDepth: 4 },
  );
  const nodes = new Map(coverage.programSources.map((entry) => [entry.source, entry]));
  assert.deepEqual(nodes.get("skills/api/natlang/review.nl").children, [
    "skills/api/natlang/review/lookup.nl",
  ]);
  assert.deepEqual(nodes.get("skills/api/natlang/review/lookup.nl").children, [
    "skills/api/natlang/review/lookup/confirm.nl",
    "skills/api/natlang/summarize.nl",
    "skills/api/natlang/support/checksum.ts",
  ]);
  assert.deepEqual(nodes.get("skills/api/natlang/support/checksum.ts"), {
    template: "base", source: "skills/api/natlang/support/checksum.ts",
    kind: "typescript", children: [], managedReachableCases: 2, scopedReachableCases: 1,
  });
  assert.equal(nodes.get("skills/api/natlang/tail.nl").managedReachableCases, 2);
  assert.equal(nodes.has("skills/api/natlang/review/types.ts"), false);
  assert.equal(nodes.has("skills/api/natlang/review/lookup.d.nl.ts"), false);
  assert.equal(nodes.has("skills/api/natlang/unmounted.nl"), false);
  assert.equal(nodes.get("skills/vibestudio-workflows/runWorkflow.nl").managedReachableCases, 1);
  assert.equal(nodes.get("skills/vibestudio-workflows/runWorkflow.nl").scopedReachableCases, 1);
  assert.equal(nodes.get("skills/vibestudio-workflows/runWorkflow/operate.nl").scopedReachableCases, 0);
  assert.deepEqual(coverage.unresolvedUses, [
    { template: "base", source: "skills/api/natlang/review/lookup.nl", item: "missing" },
  ]);
  assert.deepEqual(
    coverage.callables.map(({ callable, managedCases, scopedCases, nestedManagedCases, nestedScopedCases }) => [
      callable,
      managedCases,
      scopedCases,
      nestedManagedCases,
      nestedScopedCases,
    ]),
    [
      ["api/review", 2, 1, 0, 0],
      ["api/summarize", 1, 0, 1, 1],
      ["api/tail", 0, 0, 2, 1],
      ["operate", 1, 0, 0, 0],
      ["system/review", 0, 0, 0, 0],
      ["harness/inspectCase", 1, 0, 0, 0],
    ]
  );
  assert.deepEqual(
    coverage.skills.find(({ source }) => source === "skills/api/SKILL.md"),
    {
      template: "base",
      source: "skills/api/SKILL.md",
      localProgramFiles: 6,
      mountedCallables: ["api/review", "api/summarize", "api/tail"],
      linkedCallables: [],
    }
  );
  assert.deepEqual(
    coverage.skills.find(({ source }) => source === "skills/local-only/SKILL.md"),
    {
      template: "system",
      source: "skills/local-only/SKILL.md",
      localProgramFiles: 1,
      mountedCallables: [],
      linkedCallables: ["system/review"],
    }
  );
  assert.deepEqual(
    coverage.skills.find(({ source }) => source === "skills/system/SKILL.md").linkedCallables,
    []
  );
  assert.deepEqual(
    coverage.skills.find(({ source }) => source === "skills/cross-template/SKILL.md").linkedCallables,
    ["api/review"]
  );
  assert.deepEqual(
    coverage.unresolved.map(({ workspace, selector, candidates }) => [
      workspace,
      selector,
      candidates.map(({ callable }) => callable),
    ]),
    [
      ["system", "review", ["api/review", "system/review"]],
      ["system", "lookup", []],
      ["base", "inspectCase", []],
    ]
  );
});
