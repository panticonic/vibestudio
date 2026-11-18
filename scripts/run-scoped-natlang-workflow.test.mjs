import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { requireDevelopmentTemplateCheckouts } from "../src/dev/developmentTemplateConfig.cjs";
import { loadAuthoredScopedWorkflow, loadWorkflowBank } from "./natlang-workflow-bank.mjs";
import { runScopedNatlangWorkflow } from "./run-scoped-natlang-workflow.mjs";
import {
  hasScopedWorkflowAdapter,
  prepareScopedWorkflowAdapter,
} from "./scoped-workflow-adapters.mjs";
import { pathToFileURL } from "node:url";

const { checkouts } = requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
const id = "pdf-intake-handover-date";
const programRoot = "skills/vibestudio-workflows";

function valueRef(value) {
  const json = JSON.stringify(value);
  return {
    complete: true,
    hash: createHash("sha256").update(json).digest("hex"),
    bytes: Buffer.byteLength(json),
  };
}

function fakeRuntime(fault, difference = ({ report }) => report) {
  const entries = [];
  return {
    async calls({ parentCallId, roots }) {
      return entries.filter((row) =>
        roots ? row.parentCallId === null : row.parentCallId === parentCallId
      );
    },
    async trace(callId) {
      return { record: entries.find((row) => row.callId === callId).record };
    },
    async load(program, { services }) {
      assert.equal(program, programRoot + "/runWorkflow.nl");
      assert.deepEqual(Object.keys(services).sort(), ["pdfIntakeProbe", "pdfIntakeRead"]);
      return async (request) => {
        assert.deepEqual(Object.keys(request).sort(), ["goal", "work"]);
        const work = request.work[0];
        const probe = await services.pdfIntakeProbe.probe(work.input.document);
        const receipt = await services.pdfIntakeRead.read(
          work.input.document,
          work.input.pages,
          "embedded"
        );
        const line = receipt.pages[0].lines[1];
        const report = {
          status: "verified",
          digest: probe.digest,
          readPages: [1],
          remaining: [],
          unanswered: [],
          citations: [
            {
              page: 1,
              line: 1,
              quote: line.text,
              bounds: line.bounds,
              source: line.source,
              confidence: line.confidence,
            },
          ],
        };
        const displayed = difference({ report: structuredClone(report) });
        const result = {
          results: [
            { kind: "domain", domain: work.domain, operation: work.operation, report: displayed },
          ],
          remaining: [],
        };
        const add = (name, callId, parentCallId, input, output, source) => {
          entries.push({
            callId,
            parentCallId,
            name,
            outcome: "done",
            runId: "isolated-test",
            record: {
              call_id: callId,
              parent_call_id: parentCallId,
              program_root: programRoot,
              definition: { name, source },
              inputs: { request: valueRef(input) },
              output: valueRef(output),
              started_at: "2026-01-01T00:00:00.001Z",
              ended_at: "2026-01-01T00:00:00.002Z",
            },
          });
        };
        add("runWorkflow", "root", null, request, result, "runWorkflow.nl");
        if (fault !== "missing-child")
          add(
            work.operation,
            "child",
            "root",
            fault === "different-input" ? { ...work.input, pages: [2] } : work.input,
            fault === "laundered-output" ? report : displayed,
            fault === "wrong-definition"
              ? "other/" + work.operation + ".nl"
              : "runWorkflow/domains/" + work.domain + "/" + work.operation + ".nl"
          );
        return result;
      };
    },
  };
}

test("accepts scoped PDF evidence tied to the exact completed calls and private oracle", async () => {
  const result = await runScopedNatlangWorkflow(checkouts, id, fakeRuntime());
  assert.equal(result.callId, "root");
  assert.equal(result.passed, true);
});

for (const fault of ["missing-child", "different-input", "laundered-output", "wrong-definition"]) {
  test(`declines the report with ${fault}`, async () => {
    const result = await runScopedNatlangWorkflow(
      checkouts,
      id,
      fakeRuntime(fault, ({ report }) =>
        fault === "laundered-output" ? { ...report, unanswered: ["invented"] } : report
      )
    );
    assert.equal(result.passed, false);
  });
}

test("a genuine call record with wrong PDF evidence still fails the oracle", async () => {
  const result = await runScopedNatlangWorkflow(
    checkouts,
    id,
    fakeRuntime(null, ({ report }) => ({
      ...report,
      citations: [{ ...report.citations[0], quote: "unverified" }],
    }))
  );
  assert.equal(result.passed, false);
});

test("the public bank excludes fixture answers and counts the cases with execution adapters", async () => {
  const bank = await loadWorkflowBank(checkouts);
  const scoped = bank.filter((item) => item.execution === "scoped-fixture");
  assert(scoped.filter((item) => hasScopedWorkflowAdapter(item.family)).length >= 632);
  assert(scoped.every((item) => !Object.hasOwn(item, "world") && !Object.hasOwn(item, "expected")));
});

test("every advertised adapter resolves its template-owned verifier and opens a fresh fixture", async () => {
  const cases = await loadWorkflowBank(checkouts);
  const families = new Map(
    cases
      .filter(
        (item) => item.execution === "scoped-fixture" && hasScopedWorkflowAdapter(item.family)
      )
      .map((item) => [item.family, item])
  );
  for (const [family, { id, template }] of families) {
    const { world } = await loadAuthoredScopedWorkflow(checkouts, id);
    const load = async (source) => {
      const module = await import(pathToFileURL(path.join(checkouts[template], source)).href);
      return module.default ?? module;
    };
    const first = await prepareScopedWorkflowAdapter(family, world, load);
    const second = await prepareScopedWorkflowAdapter(family, world, load);
    assert.equal(typeof first.verify, "function", family);
    assert.notEqual(first.bindings, second.bindings, family);
  }
});
