import assert from "node:assert/strict";
import { test } from "node:test";
import { groupLiveTeacherCases, terminalStartupFailure } from "./live-teacher-groups.mjs";

test("teacher groups recycle bounded instances and preserve historical baseline placement", () => {
  const selection = ["a", "b", "c", "historical", "system"];
  const baseline = "a".repeat(40);
  const workflows = new Map(selection.map(scenario => [scenario,
    scenario === "system" ? {} : { workspace: "examples",
      ...(scenario === "historical" ? { workspaceBaseline: baseline } : {}) }]));
  const groups = groupLiveTeacherCases(selection, workflows, 2);
  assert.deepEqual(groups.map(({ cases, key }) => [cases, key]), [
    [["a", "b"], "examples/batch-1"], [["c"], "examples/batch-2"],
    [["historical"], `examples@${baseline}`], [["system"], "system"],
  ]);
  assert.equal(groups[2].workspaceBaseline, baseline);
  assert.equal(new Set(groups.map(({ instance }) => instance)).size, 4);
  assert.ok(groups.every(({ instance }) => instance.startsWith("natlang-live-")));
  assert.deepEqual(groupLiveTeacherCases(selection, workflows, 0).map(({ cases }) => cases),
    [["a", "b", "c"], ["historical"], ["system"]]);
});


test("only an explicit terminal startup error suppresses a repeated workspace boot", () => {
  assert.equal(terminalStartupFailure('[system-test] Created workspace\n{"error":"Missing immutable dependency","recoverable":false}'), true);
  assert.equal(terminalStartupFailure('{"error":"Timeout","recoverable":true}'), false);
  assert.equal(terminalStartupFailure("[system-test] No doctor report"), false);
});
