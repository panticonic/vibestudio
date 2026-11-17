import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isFixtureDocument, serializeTeacherIR } from "./lib/natlang-teacher-ir.mjs";

const require = createRequire(import.meta.url);
const host = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { checkouts } =
  require("../src/dev/developmentTemplateConfig.cjs").requireDevelopmentTemplateCheckouts(host);
const catalog = JSON.parse(
  fs.readFileSync(path.join(host, "scripts/natlang-teacher-suites.json"), "utf8")
);
const source = {
  template_commit: "a".repeat(40),
  base_commit: "b".repeat(40),
  natlang_commit: "c".repeat(40),
  vibestudio_commit: "d".repeat(40),
  dirty: false,
};
const casesOf = (selection) =>
  fs
    .readFileSync(
      path.join(checkouts[selection.template], path.dirname(selection.path), "cases.jsonl"),
      "utf8"
    )
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
const irOf = (selection, testCase) =>
  serializeTeacherIR({ selection, testCase, workspaceRoot: checkouts[selection.template], source });

test("all eighteen authored suites and all450 cases have explicit portable IR entries", () => {
  assert.equal(catalog.length, 18);
  let count = 0;
  const namedSources = new Set();
  for (const selection of catalog) {
    for (const testCase of casesOf(selection)) {
      const record = irOf(selection, testCase),
        fixture = record.semantics.evaluation_fixture;
      count++;
      assert.equal(record.version, "natlang.program/2");
      assert.equal(record.kind, "evaluation_fixture");
      assert.equal(record.source_namespace, `vibestudio:${selection.template}:${selection.suite}`);
      assert.equal(fixture.schema, "natlang.evaluation-fixture/1");
      assert.deepEqual(fixture.case, testCase);
      assert.deepEqual(record.semantics.expected, testCase.expected);
      assert.ok(Object.hasOwn(record.semantics.files, record.semantics.root));
      assert.ok(Object.hasOwn(record.semantics.files, fixture.entry.module));
      assert.ok(Object.hasOwn(fixture.host_files, selection.path));
      assert.ok(fixture.entry.export_path.length > 0);
      for (const [relative, text] of Object.entries(record.semantics.files)) {
        if (path.posix.basename(relative) === "types.ts" || relative.endsWith(".d.ts")) {
          assert.equal(fixture.host_files[`${fixture.program_root}/${relative}`], text);
        }
      }
      assert.ok(!Object.hasOwn(fixture.host_files, `${fixture.program_root}/natlang.ts`));
      assert.ok(!Object.keys(fixture.host_files).some((file) => file.endsWith(".nl")));
      assert.ok(
        Object.keys(record.semantics.files).every(
          (file) => !/(?:\.test\.|\.spec\.|\.d\.nl\.ts$|^suite\.|cases\.jsonl$|\.md$)/u.test(file)
        )
      );
      assert.ok(
        Object.keys(fixture.host_files).every(
          (file) => !file.endsWith("cases.jsonl") && !file.includes("/vendor")
        )
      );
      for (const file of Object.keys(record.semantics.files).filter((file) =>
        file.endsWith(".nl")
      )) {
        namedSources.add(`${selection.template}:${fixture.program_root}/${file}`);
      }
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(record)));
    }
  }
  assert.equal(count, 450);
  assert.equal(namedSources.size, 38);
});

test("authored TypeScript workflows keep genuine semantic anchors and full workflow contracts", () => {
  const expectedEntries = [
    ["automations-v1", "extractSchedule", "readSchedule.nl", "natlang.ts", "extractSchedule"],
    ["templates-v1", "summarizeTemplate", "templateRole.nl", "natlang.ts", "summarizeTemplate"],
    ["visualize-v1", "componentProps", "readProps.nl", "natlang.ts", "componentProps"],
    ["workspace-dev-icons-v1", "unitIcon", "iconIntent.nl", "natlang.ts", "unitIcon"],
    ["doc-help-v1", "recoverFromFailure", "docHelp.nl", "docHelp/recoverFromFailure.ts", "default"],
    [
      "vcs-changes-v1",
      "commit",
      "summarizeChanges.nl",
      "summarizeChanges/commitMessage.ts",
      "default",
    ],
  ];
  for (const [suite, variant, anchor, module, exported] of expectedEntries) {
    const selection = catalog.find((entry) => entry.suite === suite);
    const testCase = casesOf(selection).find((entry) => entry.input.function === variant);
    const record = irOf(selection, testCase),
      fixture = record.semantics.evaluation_fixture;
    assert.equal(record.semantics.root, anchor);
    assert.equal(fixture.root_role, "semantic-anchor");
    assert.equal(fixture.entry.kind, "authored-module");
    assert.equal(fixture.entry.module, module);
    assert.equal(fixture.entry.export, exported);
    assert.deepEqual(record.semantics.expected, testCase.expected);
    assert.equal(
      record.semantics.files[anchor],
      fs.readFileSync(
        path.join(checkouts[selection.template], fixture.program_root, anchor),
        "utf8"
      )
    );
  }
});

test("service arguments remain live fixture bindings and never become invented JSON handles", () => {
  const selection = catalog.find((entry) => entry.suite === "workspace-dev-icons-v1");
  const testCase = casesOf(selection)[0],
    record = irOf(selection, testCase);
  const fixture = record.semantics.evaluation_fixture;
  assert.deepEqual(record.semantics.inputs, { unit: testCase.input.args[0] });
  assert.deepEqual(fixture.entry.input_arguments, ["unit", "fs"]);
  assert.deepEqual(fixture.service_inputs, ["fs"]);
  assert.ok(!Object.hasOwn(record.semantics.inputs, "fs"));
  const icon = "skills/workspace-dev/assets/icons/brands/git.svg";
  assert.equal(fixture.host_files[icon], fs.readFileSync(path.join(checkouts.base, icon), "utf8"));
  assert.ok(Object.keys(fixture.host_files).filter((file) => file.endsWith(".svg")).length > 1000);
});

test("document world is self-contained but excludes evaluation feedback and allcase inventories", () => {
  const selection = catalog.find((entry) => entry.suite === "doc-help-v1");
  const testCase = casesOf(selection).find((entry) => entry.input.function === "locateDoc");
  const record = irOf(selection, testCase),
    fixture = record.semantics.evaluation_fixture;
  const api = "skills/sandbox/EVAL.md",
    oracleCatalog = "skills/sandbox/help/catalog.json";
  assert.equal(fixture.host_files[api], fs.readFileSync(path.join(checkouts.base, api), "utf8"));
  assert.equal(
    fixture.host_files[oracleCatalog],
    fs.readFileSync(path.join(checkouts.base, oracleCatalog), "utf8")
  );
  assert.ok(!Object.hasOwn(record.semantics.files, "catalog.json"));
  assert.ok(
    !Object.keys(fixture.host_files).some(
      (file) => file.endsWith("DECOMPOSITION.md") || file.endsWith("cases.jsonl")
    )
  );
  assert.equal(isFixtureDocument("skills/sandbox/EVAL.md"), true);
  assert.equal(isFixtureDocument("skills/sandbox/help/DECOMPOSITION.md"), false);
  assert.equal(isFixtureDocument("eval-results/feedback.md"), false);
});

test("the selected task survives source cleanup and never bundles another partition's input", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-ir-snapshot-"));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspaceRoot, "skills/demo"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, "skills/demo/main.nl"),
    "---\nargs: { value: string }\nreturns: string\n---\nReturn value.\n"
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "skills/demo/suite.ts"),
    "export default { fixture: {}, score() {} };\n"
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "skills/demo/natlang.ts"),
    'export { default as main } from "./main.nl";\n'
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "skills/demo/types.ts"),
    "\ufeffexport type Name = string;\n"
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "skills/demo/cases.jsonl"),
    '{"input":"PROTECTED_SENTINEL"}\n'
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "skills/demo/DECOMPOSITION.md"),
    "PROTECTED_SENTINEL\n"
  );
  const selection = {
    template: "base",
    suite: "demo",
    path: "skills/demo/suite.ts",
    ir: {
      selector: null,
      program_entry: "natlang.ts",
      cases: {
        default: {
          root: "main.nl",
          root_role: "entry",
          entry: {
            kind: "natlang-root",
            module: "main.nl",
            export: "default",
            export_path: ["main"],
          },
          arguments: [{ name: "value", path: ["value"] }],
        },
      },
    },
  };
  const testCase = {
    id: "train-1",
    group: "g1",
    split: "train",
    input: { value: "TRAIN_VALUE" },
    expected: "TRAIN_VALUE",
  };
  const record = serializeTeacherIR({ selection, testCase, workspaceRoot, source });
  fs.rmSync(workspaceRoot, { recursive: true });
  assert.match(record.semantics.files["main.nl"], /Return value/u);
  assert.equal(record.semantics.files["types.ts"], "\ufeffexport type Name = string;\n");
  assert.equal(
    record.semantics.evaluation_fixture.host_files["skills/demo/suite.ts"],
    "export default { fixture: {}, score() {} };\n"
  );
  assert.deepEqual(record.semantics.inputs, { value: "TRAIN_VALUE" });
  assert.ok(!JSON.stringify(record).includes("PROTECTED_SENTINEL"));
});

test("unknown variants, missing actual arguments, and unsafe source paths fail explicitly", () => {
  const selection = catalog.find((entry) => entry.suite === "automations-v1");
  const original = casesOf(selection)[0];
  assert.throws(
    () => irOf(selection, { ...original, input: { function: "invented" } }),
    /no IR entry/u
  );
  assert.throws(
    () => irOf(selection, { ...original, input: { function: "chooseExecutor", args: [] } }),
    /does not supply request/u
  );
  assert.throws(
    () => irOf({ ...selection, path: "../outside/suite.ts" }, original),
    /workspace-relative/u
  );
});
