import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { requireDevelopmentTemplateCheckouts } from "../src/dev/developmentTemplateConfig.cjs";
import { loadAuthoredScopedWorkflow, loadWorkflowBank } from "./natlang-workflow-bank.mjs";
import {
  loadScopedWorkflowModule,
  runScopedNatlangWorkflow,
} from "./run-scoped-natlang-workflow.mjs";
import {
  hasScopedWorkflowAdapter,
  prepareScopedWorkflowAdapter,
} from "./scoped-workflow-adapters.mjs";

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
  assert(scoped.length >= 632);
  assert.deepEqual(
    scoped.filter((item) => !hasScopedWorkflowAdapter(item.family)).map((item) => item.id),
    []
  );
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
    const load = (source) => loadScopedWorkflowModule(checkouts[template], source);
    const first = await prepareScopedWorkflowAdapter(family, world, load);
    const second = await prepareScopedWorkflowAdapter(family, world, load);
    assert.equal(typeof first.verify, "function", family);
    assert.notEqual(first.bindings, second.bindings, family);
  }
});

test("presentation evidence rejects a well-formed component with an invented number", async () => {
  const { world } = await loadAuthoredScopedWorkflow(checkouts, "visualize-library-capacity");
  const load = (source) => loadScopedWorkflowModule(checkouts.base, source);
  const { verify } = await prepareScopedWorkflowAdapter("visualize", world, load);
  const { renderComponent } = await load(
    "skills/visualize/preparePresentation/prepareSection/render.ts"
  );
  const report = {
    omitted: world.omitted,
    views: world.expected.map(({ id, outcome }) => ({
      id,
      status: "ready",
      rendered: renderComponent(outcome.spec),
    })),
  };
  assert.equal(verify(report), true);
  const changed = structuredClone(report);
  const candidate = changed.views[1].rendered;
  candidate.props.data[0].visits = 63;
  changed.views[1].rendered = renderComponent(candidate);
  assert.equal(verify(changed), false);
  assert.equal(verify({ ...report, views: [...report.views].reverse() }), false);
});

const newlyIntegrated = new Set(["google", "publication", "localModel"]);
test("the newly integrated families require the expected binding evidence for every authored case", async () => {
  const scenarios = (await loadWorkflowBank(checkouts)).filter((item) =>
    newlyIntegrated.has(item.family)
  );
  for (const scenario of scenarios) {
    const { world } = await loadAuthoredScopedWorkflow(checkouts, scenario.id);
    const fixture = await prepareScopedWorkflowAdapter(scenario.family, world, (source) =>
      loadScopedWorkflowModule(checkouts[scenario.template], source)
    );
    const result = { ...world.expected };
    if (scenario.family === "publication") {
      assert.equal(fixture.verify({ ...result, evidence: ["fabricated"] }), false);
      const observed = await fixture.bindings.websiteReadback.observe();
      result.evidence = [
        observed.matchesRequest
          ? observed.artifact.artifactDigest
          : "Different assigned destination",
      ];
      assert.equal(fixture.verify(result), true, scenario.id);
      assert.equal(
        fixture.verify({
          ...result,
          evidence: [observed.matchesRequest ? "fabricated" : observed.artifact.artifactDigest],
        }),
        false,
        scenario.id
      );
      await fixture.bindings.websiteReadback.observe();
      assert.equal(fixture.verify(result), false, scenario.id);
    } else if (scenario.family === "google") {
      result.findings = ["Scoped Drive report"];
      assert.equal(fixture.verify(result), false);
      const drive = fixture.bindings.googleWorkspaceRead;
      assert.equal((await drive.readiness()).state, world.state);
      let token = world.request.cursor ?? null;
      for (const page of world.pages) {
        const request = world.request;
        const pending =
          request.kind === "sync"
            ? drive.readChanges(token)
            : request.kind === "inventory"
              ? drive.listFolder(request.folderId, token)
              : drive.readPermissions(request.fileId, token);
        if (!page) await assert.rejects(pending, /Fixture page unavailable/);
        else token = (await pending).next;
      }
      assert.equal(fixture.verify(result), true, scenario.id);
      await drive.readiness();
      assert.equal(fixture.verify(result), false, scenario.id);
    } else {
      assert.equal(fixture.verify(result).passed, false);
      const { localModelTaskInventory, localModelTaskInstall } = fixture.bindings;
      await localModelTaskInventory.inspect(world.request.modelRef);
      if (world.expectedOperations.length > 1) {
        if (world.installation === "reject" || world.installation === "wrong-model") {
          await assert.rejects(localModelTaskInstall.installOnce(world.request.modelRef));
        } else {
          await localModelTaskInstall.installOnce(world.request.modelRef);
          if (world.expected.receipt) await localModelTaskInventory.inspect(world.request.modelRef);
        }
      }
      assert.equal(fixture.verify(result).passed, true, scenario.id);
    }
  }
});
