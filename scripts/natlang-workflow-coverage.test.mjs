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
  const checkouts = { base: path.join(root, "base"), system: path.join(root, "system") };
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
        "runWorkflow/domains/system": "skills/system/natlang",
      },
    })
  );
  await Promise.all([
    write("base", "skills/api/SKILL.md"),
    write("base", "skills/api/natlang/review.nl"),
    write("base", "skills/api/natlang/review/lookup.nl"),
    write("base", "skills/vibestudio-workflows/runWorkflow/operate.nl"),
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
    { id: "managed-direct", execution: "managed-workspace", operations: ["operate"] },
    { id: "managed-ambiguous", execution: "managed-workspace", operations: ["review"] },
    { id: "managed-missing", execution: "managed-workspace", operations: ["lookup"] },
    {
      id: "scoped-api",
      execution: "scoped-fixture",
      request: { work: [{ kind: "domain", domain: "api", operation: "review" }] },
    },
  ]);
  assert.deepEqual(
    coverage.callables.map(({ callable, managedCases, scopedCases }) => [
      callable,
      managedCases,
      scopedCases,
    ]),
    [
      ["api/review", 0, 1],
      ["operate", 1, 0],
      ["system/review", 0, 0],
    ]
  );
  assert.deepEqual(
    coverage.skills.find(({ source }) => source === "skills/api/SKILL.md"),
    {
      template: "base",
      source: "skills/api/SKILL.md",
      localProgramFiles: 2,
      mountedCallables: ["api/review"],
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
    coverage.unresolved.map(({ selector, candidates }) => [
      selector,
      candidates.map(({ callable }) => callable),
    ]),
    [
      ["review", ["api/review", "system/review"]],
      ["lookup", []],
    ]
  );
});
