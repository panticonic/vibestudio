import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadAuthoredScopedWorkflow } from "./natlang-workflow-bank.mjs";
import { prepareScopedWorkflowAdapter } from "./scoped-workflow-adapters.mjs";

function verification(value) {
  if (typeof value === "boolean") return { passed: value };
  if (Array.isArray(value)) return { passed: value.length === 0, reasons: value };
  if (value && typeof value.passed === "boolean") return value;
  throw new Error("The scoped workflow verifier returned an invalid verdict");
}

function assignedResults(request, report, fixture) {
  if (!Array.isArray(report?.results) || !Array.isArray(report?.remaining)) return false;
  if (!fixture.wholeReport && (report.results.length !== 1 || report.remaining.length !== 0))
    return false;
  return (
    report.results.length > 0 &&
    report.results.every(
      (item) =>
        item?.kind === "domain" &&
        request.work.some(
          (work) =>
            work.kind === item.kind &&
            work.domain === item.domain &&
            work.operation === item.operation
        )
    )
  );
}

function matchesValue(ref, value) {
  if (!ref?.complete || value === undefined) return false;
  const text = JSON.stringify(value);
  return (
    ref.bytes === Buffer.byteLength(text) &&
    ref.hash === createHash("sha256").update(text).digest("hex")
  );
}

function matchesInput(record, value) {
  const inputs = Object.values(record.inputs ?? {});
  return inputs.length === 1 && matchesValue(inputs[0], value);
}

function matchesSource(definition, source) {
  return definition.source === source || definition.source?.endsWith(`/${source}`);
}

/**
 * Execute one authored scoped case from a trusted harness with an isolated
 * Natlang runtime. The Natlang calls API supplies evidence after the root returns.
 */
export async function runScopedNatlangWorkflow(checkouts, id, natlang) {
  const { scenario, world } = await loadAuthoredScopedWorkflow(checkouts, id);
  const load = async (relative) => {
    const imported = await import(
      pathToFileURL(path.join(checkouts[scenario.template], relative)).href
    );
    return imported.default ?? imported;
  };
  const fixture = await prepareScopedWorkflowAdapter(scenario.family, world, load);
  const options = { roots: true, name: "runWorkflow", limit: 2 };
  const earlier = new Set((await natlang.calls(options)).map((call) => call.callId));
  const run = await natlang.load(scenario.program, { services: fixture.bindings });
  const report = await run(structuredClone(scenario.request));
  const roots = (await natlang.calls(options)).filter((call) => !earlier.has(call.callId));
  if (
    roots.length !== 1 ||
    roots[0].parentCallId !== null ||
    roots[0].outcome !== "done" ||
    !roots[0].runId
  ) {
    throw new Error(`Expected one new completed workflow root for ${id}`);
  }
  const root = roots[0];
  const { record } = await natlang.trace(root.callId, { raw: true });
  const programRoot = path.posix.dirname(scenario.program);
  if (
    record?.program_root !== programRoot ||
    record.call_id !== root.callId ||
    record.definition?.name !== "runWorkflow" ||
    !matchesSource(record.definition, path.posix.basename(scenario.program)) ||
    record.parent_call_id !== null ||
    !matchesInput(record, scenario.request) ||
    !matchesValue(record.output, report)
  ) {
    throw new Error(
      `The completed root for ${id} lacks a matching program, input, or output record`
    );
  }
  const result = { id, callId: root.callId, report };
  const invalid = () => ({
    ...result,
    passed: false,
    reasons: ["The workflow report does not match the assigned direct calls."],
  });
  const listed = await natlang.calls({
    parentCallId: root.callId,
    limit: scenario.request.work.length + 1,
  });
  if (
    !assignedResults(scenario.request, report, fixture) ||
    listed.length !== report.results.length ||
    !listed.every(
      (call) =>
        call.parentCallId === root.callId && call.runId === root.runId && call.outcome === "done"
    )
  )
    return invalid();
  const calls = await Promise.all(
    listed.map(async (call) => {
      const { record: child } = await natlang.trace(call.callId, { raw: true });
      return {
        ...call,
        child,
        startedAt: Date.parse(child?.started_at),
        endedAt: Date.parse(child?.ended_at),
      };
    })
  );
  calls.sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      (left.child?.parent_action_index ?? 0) - (right.child?.parent_action_index ?? 0)
  );
  for (const [index, call] of calls.entries()) {
    const resultItem = report.results[index];
    const work = scenario.request.work.find(
      (item) => item.domain === resultItem.domain && item.operation === resultItem.operation
    );
    const source = `runWorkflow/domains/${work.domain}/${work.operation}.nl`;
    const child = call.child;
    if (
      call.name !== work.operation ||
      child?.definition?.name !== work.operation ||
      child.call_id !== call.callId ||
      child.parent_call_id !== root.callId ||
      child.program_root !== programRoot ||
      !matchesSource(child.definition, source) ||
      !Number.isFinite(call.startedAt) ||
      !Number.isFinite(call.endedAt) ||
      !matchesInput(child, work.input) ||
      !matchesValue(child.output, resultItem.report)
    )
      return invalid();
  }
  return {
    ...result,
    ...verification(
      await fixture.verify(fixture.wholeReport ? report : report.results[0].report, calls)
    ),
  };
}
