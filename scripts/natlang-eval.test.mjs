import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  UsageError,
  ensureStagedEval,
  exitCodeFor,
  layoutEvalBundle,
  linkProjectedModules,
  linkSuiteSpecifiers,
  locateSuite,
  openNatlangModels,
  parseArguments,
  resolveNatlangCommit,
  runNatlangEval,
} from "./natlang-eval.mjs";
import { natlangRepository } from "./lib/natlang-stage.mjs";

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "natlang-eval-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("arguments parse as natlang's CLI parses them", () => {
  assert.deepEqual(parseArguments(["--", "--template", "base", "--suite", "a/suite.ts"]), {
    template: "base",
    suite: "a/suite.ts",
    split: "validation",
    preflight: false,
  });
  assert.deepEqual(
    parseArguments([
      "--template",
      "base",
      "--suite",
      "s.ts",
      "--split",
      "test",
      "--preflight",
      "--out",
      "o",
    ]),
    { template: "base", suite: "s.ts", split: "test", preflight: true, out: "o" }
  );
  assert.equal(
    parseArguments(["--template", "base", "--suite", "s.ts", "--case-deadline-ms", "600000"]).caseDeadlineMs,
    600000
  );
  for (const [argv, message] of [
    [["--template", "base", "--suite", "s.ts", "--case-deadline-ms", "soon"], /--case-deadline-ms must be/],
    [["--suite", "s.ts"], /--template is required/],
    [["--template", "base"], /--suite is required/],
    [["--template", "base", "--suite", "s.ts", "--split", "dev"], /--split must be one of/],
    [["--template", "base", "--suite", "s.ts", "--bogus"], /unknown option: --bogus/],
    [["--template", "base", "--template", "x", "--suite", "s.ts"], /duplicate option: --template/],
    [["--template", "base", "--suite"], /missing value: --suite/],
    [["--template", "--suite", "s.ts"], /missing value: --template/],
    [["--template", "base", "--suite", "s.ts", "stray"], /unknown option: stray/],
  ]) {
    assert.throws(
      () => parseArguments(argv),
      (error) => error instanceof UsageError && message.test(error.message)
    );
  }
});

test("a suite is located inside the workspace and must exist", (t) => {
  const root = temporary(t);
  const base = path.join(root, "base");
  const personal = path.join(root, "personal");
  write(path.join(base, "packages/p/suite.ts"));
  write(path.join(personal, "skills/s/suite.mjs"));
  assert.equal(
    locateSuite("packages/p/suite.ts", [base, personal]),
    path.join("packages/p/suite.ts")
  );
  assert.equal(
    locateSuite(path.join(personal, "skills/s/suite.mjs"), [base, personal]),
    path.join("skills/s/suite.mjs")
  );
  const rejected = (suite, message) =>
    assert.throws(
      () => locateSuite(suite, [base, personal]),
      (error) => error instanceof UsageError && message.test(error.message)
    );
  rejected("packages/p/cases.jsonl", /must be a \.ts/);
  rejected("../outside/suite.ts", /stay inside the workspace/);
  rejected("/etc/suite.ts", /not inside a template checkout/);
  rejected("packages/missing/suite.ts", /does not exist/);
});

test("a natlang revision that does not resolve is a usage error naming the repository", (t) => {
  const repository = temporary(t);
  execFileSync("git", ["-C", repository, "init", "-q", "-b", "main"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  ]);
  const head = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.equal(resolveNatlangCommit(repository, "HEAD"), head);
  assert.throws(
    () => resolveNatlangCommit(repository, "origin/main"),
    (error) =>
      error instanceof UsageError &&
      error.message.includes("origin/main") &&
      error.message.includes(repository)
  );
});

test("a missing natlang checkout names NATLANG_REPO", () => {
  assert.throws(
    () => natlangRepository({ NATLANG_REPO: "/nonexistent/natlang" }),
    /set NATLANG_REPO/
  );
});

function fakeStage(calls) {
  return async ({ commit, only, out }) => {
    calls.push({ commit, only });
    write(path.join(out, "eval/natlang-eval.js"), `// ${commit}`);
    write(path.join(out, "natlang-pin.json"), JSON.stringify({ commit }));
    return commit;
  };
}

test("the staged bundle is cached by commit and other commits are retired", async (t) => {
  const root = temporary(t);
  const cacheRoot = path.join(root, "cache");
  const scratchRoot = path.join(root, "scratch");
  fs.mkdirSync(scratchRoot);
  const calls = [];
  const stage = fakeStage(calls);
  const first = await ensureStagedEval({
    repository: "r",
    commit: "aaa",
    cacheRoot,
    scratchRoot,
    stage,
  });
  assert.equal(first, path.join(cacheRoot, "stage/aaa"));
  assert.equal(fs.readFileSync(path.join(first, "eval/natlang-eval.js"), "utf8"), "// aaa");
  assert.deepEqual(calls, [{ commit: "aaa", only: "eval" }]);

  await ensureStagedEval({ repository: "r", commit: "aaa", cacheRoot, scratchRoot, stage });
  assert.equal(calls.length, 1, "a second run reuses the staged commit");

  const second = await ensureStagedEval({
    repository: "r",
    commit: "bbb",
    cacheRoot,
    scratchRoot,
    stage,
  });
  assert.deepEqual(fs.readdirSync(path.join(cacheRoot, "stage")), ["bbb"]);
  assert.ok(fs.existsSync(path.join(second, "natlang-pin.json")));
});

test("a stage that fails or stages another commit leaves nothing visible in the cache", async (t) => {
  const root = temporary(t);
  const cacheRoot = path.join(root, "cache");
  const scratchRoot = path.join(root, "scratch");
  fs.mkdirSync(scratchRoot);
  await assert.rejects(
    ensureStagedEval({
      repository: "r",
      commit: "aaa",
      cacheRoot,
      scratchRoot,
      stage: async () => {
        throw new Error("esbuild failed");
      },
    }),
    /esbuild failed/
  );
  await assert.rejects(
    ensureStagedEval({
      repository: "r",
      commit: "aaa",
      cacheRoot,
      scratchRoot,
      stage: async () => "bbb",
    }),
    /produced bbb/
  );
  assert.equal(fs.existsSync(path.join(cacheRoot, "stage/aaa")), false);
});

test("the bundle is laid out beside the natlang checkout's installed packages", (t) => {
  const root = temporary(t);
  const repository = path.join(root, "natlang");
  write(path.join(repository, "ts-host/node_modules/yaml/package.json"), "{}");
  write(path.join(repository, "node_modules/just-bash/package.json"), "{}");
  const stagedDir = path.join(root, "staged");
  write(path.join(stagedDir, "eval/natlang-eval.js"), "export {}");
  const entry = layoutEvalBundle({ stagedDir, repository, runRoot: path.join(root, "run") });
  assert.equal(entry, path.join(root, "run/ts-host/eval/natlang-eval.js"));
  assert.ok(fs.existsSync(path.join(root, "run/ts-host/node_modules/yaml/package.json")));
  assert.ok(fs.existsSync(path.join(root, "run/node_modules/just-bash/package.json")));
});

test("the laid-out bundle is ES module code, is its own package root, and finds the chat templates", (t) => {
  const root = temporary(t);
  const repository = path.join(root, "natlang");
  write(path.join(repository, "models/templates/LFM3-1.7B.jinja"), "{{ messages }}");
  const stagedDir = path.join(root, "staged");
  write(path.join(stagedDir, "eval/natlang-eval.js"), "export {}");
  const runRoot = path.join(root, "scratch/run");
  layoutEvalBundle({ stagedDir, repository, runRoot });
  // Without a module package the bundle loads through a CommonJS resolver that cannot read import-only exports.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runRoot, "ts-host/package.json"), "utf8")), {
    type: "module",
  });
  // A program compiled for a suite imports the runtime from `../index.js` of the bundle.
  assert.match(fs.readFileSync(path.join(runRoot, "ts-host/index.js"), "utf8"), /natlang-eval\.js/);
  // The bundle looks for templates at `../../../models/templates` of its own file.
  assert.ok(fs.existsSync(path.join(root, "scratch/models/templates/LFM3-1.7B.jinja")));
});

test("the composed workspace resolves the projected npm packages, scoped ones included", (t) => {
  const root = temporary(t);
  const nodeModulesDir = path.join(root, "projected");
  write(path.join(nodeModulesDir, "zod/package.json"), "{}");
  write(path.join(nodeModulesDir, "@scope/dep/package.json"), "{}");
  write(path.join(nodeModulesDir, ".bin/x"), "");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const modules = linkProjectedModules(workspace, nodeModulesDir);
  assert.equal(modules, path.join(workspace, "node_modules"));
  assert.ok(fs.existsSync(path.join(modules, "zod/package.json")));
  assert.ok(fs.existsSync(path.join(modules, "@scope/dep/package.json")));
  assert.equal(fs.existsSync(path.join(modules, ".bin")), false);
});

test("a suite's workspace specifiers for natlang resolve to the staged bundle", async (t) => {
  const root = temporary(t);
  const bundle = path.join(root, "bundle.mjs");
  write(
    bundle,
    "export const defineEvaluationSuite = (suite) => suite;\nexport const executorIdentityForChoice = () => 'id';\n"
  );
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  linkSuiteSpecifiers(linkProjectedModules(workspace, undefined), bundle);
  write(
    path.join(workspace, "suite.mjs"),
    "import { defineEvaluationSuite } from '@workspace/natlang/evaluation';\nimport { executorIdentityForChoice } from '@workspace/natlang/model';\nexport default defineEvaluationSuite({ identity: executorIdentityForChoice() });\n"
  );
  const loaded = await import(path.join(workspace, "suite.mjs"));
  assert.deepEqual(loaded.default, { identity: "id" });
  // The suite is type-checked as natlang builds it: the specifiers carry the bundle's declarations.
  const declaration = fs.readFileSync(path.join(workspace, "node_modules/@workspace/natlang/evaluation.d.ts"), "utf8");
  assert.ok(declaration.includes(JSON.stringify(bundle)));
});

test("a staged bundle without the model session API is refused with the missing export named", async () => {
  await assert.rejects(
    openNatlangModels({ loadModelConfiguration() {} }, { models: {} }),
    /does not export createResolvedModelSession/
  );
});

test("model sessions are opened per suite profile and every one is closed", async () => {
  const closed = [];
  const natlang = {
    loadModelConfiguration: (profile) => ({ choice: { kind: "external", profile } }),
    localModelPrerequisites: () => ({ available: true }),
    executorIdentityForChoice: (choice) => ({ id: choice.profile }),
    sessionDriver: (session) =>
      Object.assign((request) => session.turn(request), {
        decide: (request) => session.decide(request),
      }),
    createResolvedModelSession: (choice) => ({
      turn: async () => ({ text: choice.profile }),
      decide: async (request) => ({ scored: choice.profile, request }),
      close: async () => {
        closed.push(choice.profile);
      },
    }),
  };
  const models = await openNatlangModels(natlang, { models: { executor: "exec", judge: "jdg" } });
  assert.deepEqual(models.identity, { id: "exec" });
  assert.equal((await models.driver({})).text, "exec");
  assert.equal((await models.judge({})).text, "jdg");
  // The decision readout travels on the driver, for the executor and for the judge.
  assert.deepEqual(await models.driver.decide("replies"), { scored: "exec", request: "replies" });
  assert.deepEqual(await models.judge.decide("replies"), { scored: "jdg", request: "replies" });
  await models.close();
  assert.deepEqual(closed.toSorted(), ["exec", "jdg"]);

  await assert.rejects(
    openNatlangModels(
      {
        ...natlang,
        localModelPrerequisites: () => ({ available: false }),
        loadModelConfiguration: () => ({ choice: { kind: "managed-local" } }),
      },
      { models: {} }
    ),
    (error) => error instanceof UsageError && /natlang --setup/.test(error.message)
  );
});

/** A fake run: template checkouts on disk, projection tools that record their retirement, a scripted natlang bundle. */
function harness(t, { evaluate, identity = { id: "scripted" } } = {}) {
  const root = temporary(t);
  const checkouts = { base: path.join(root, "base"), personal: path.join(root, "personal") };
  write(path.join(checkouts.base, "packages/p/suite.ts"));
  fs.mkdirSync(checkouts.personal, { recursive: true });
  const scratchRoot = path.join(root, "scratch");
  fs.mkdirSync(scratchRoot);
  const events = [];
  const output = [];
  const composed = path.join(root, "composed");
  const natlang = {
    fingerprint: (value) => JSON.stringify(value),
    UsageGateway: class {
      constructor(limits) {
        this.limits = limits;
      }
      snapshot() {
        return {
          rollouts: 2,
          proposals: 0,
          elapsedMs: 5,
          usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, cost: null },
        };
      }
    },
    async loadEvaluationSuite(suitePath) {
      events.push(`load ${path.relative(composed, suitePath)}`);
      return {
        suite: {
          id: "fixture/suite",
          executorIdentity: { id: "scripted" },
          budget: { maxRollouts: 8, maxModelCalls: 16 },
        },
        suiteHash: "h".repeat(64),
        cases: [
          { id: "a", split: "validation" },
          { id: "b", split: "train" },
        ],
        program: {},
      };
    },
    evaluate:
      evaluate ??
      (async (prepared, options) => {
        events.push(`evaluate ${options.split}`);
        return {
          quality: 1,
          gatesPassed: true,
          results: [{ caseId: "a", status: "scored", quality: 1, outcome: { kind: "returned" } }],
        };
      }),
    evaluationSummary: (batch) => ({
      quality: batch.quality,
      cases: batch.results.length,
      gatesPassed: batch.gatesPassed,
      modelCalls: 0,
      meanLatencyMs: 3,
    }),
  };
  const dependencies = {
    cacheRoot: path.join(root, "cache"),
    stdout: (text) => output.push(text),
    natlangRepository: () => path.join(root, "natlang"),
    resolveNatlangCommit: () => "c".repeat(40),
    stage: async ({ out, commit }) => {
      events.push("stage");
      write(path.join(out, "eval/natlang-eval.js"));
      write(path.join(out, "natlang-pin.json"), "{}");
      return commit;
    },
    templates: async () => ({
      selected: {
        sources: [
          { id: "base", url: "u" },
          { id: "personal", url: "u" },
        ],
        checkouts,
      },
      assertTemplateCheckoutHygiene: () => events.push("hygiene"),
    }),
    projection: async () => ({
      composeDevelopmentTemplateCheckouts: () => {
        fs.mkdirSync(composed, { recursive: true });
        write(path.join(composed, "packages/p/suite.ts"));
        return {
          root: composed,
          release: () => {
            events.push("release composition");
            fs.rmSync(composed, { recursive: true, force: true });
          },
        };
      },
      prepareUserlandDependencyProjection: async () => ({
        nodeModulesDir: "",
        units: [],
        release: () => events.push("release projection"),
      }),
      retireUserlandProjectionProcess: async (releases) => {
        events.push("retire");
        for (const release of releases) await release();
      },
    }),
    loadEval: async () => natlang,
    openModels: async () => ({
      identity,
      driver: async () => ({}),
      close: async () => {
        events.push("close models");
      },
    }),
  };
  const context = {
    signal: new AbortController().signal,
    ownership: { own: async () => {} },
    scratchRoot,
  };
  return { root, events, output, dependencies, context, composed };
}

test("a run stages, projects, evaluates, writes results, and retires everything in order", async (t) => {
  const { root, events, output, dependencies, context, composed } = harness(t);
  const outcome = await runNatlangEval(
    {
      template: "personal",
      suite: "packages/p/suite.ts",
      split: "validation",
      preflight: false,
      out: path.join(root, "out"),
    },
    context,
    dependencies
  );
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(events, [
    "hygiene",
    "stage",
    "load packages/p/suite.ts",
    "evaluate validation",
    "close models",
    "retire",
    "release projection",
    "release composition",
    "hygiene",
  ]);
  assert.equal(fs.existsSync(composed), false);
  const record = JSON.parse(fs.readFileSync(outcome.resultPath, "utf8"));
  assert.equal(path.dirname(outcome.resultPath), path.join(root, "out"));
  assert.deepEqual(record.suite.cases, { validation: 1, train: 1 });
  assert.equal(record.budget.ledger.rollouts, 2);
  assert.equal(record.natlang.commit, "c".repeat(40));
  assert.match(output[0], /suite fixture\/suite +\(h+\) +template personal +split validation/);
  assert.match(output[0], /budget spent: rollouts 2\/8, model calls 0\/16/);
  assert.ok(output[0].endsWith(`results ${outcome.resultPath}`));
});

test("failed gates exit 3 and a preflight exits 0 without evaluating", async (t) => {
  const failing = harness(t, {
    evaluate: async () => ({
      quality: 0,
      gatesPassed: false,
      results: [{ caseId: "a", status: "scored", quality: 0, outcome: { kind: "returned" } }],
    }),
  });
  const outcome = await runNatlangEval(
    {
      template: "base",
      suite: "packages/p/suite.ts",
      split: "validation",
      preflight: false,
      out: path.join(failing.root, "o"),
    },
    failing.context,
    failing.dependencies
  );
  assert.equal(outcome.exitCode, 3);

  const preflight = harness(t);
  preflight.dependencies.loadEval = async () => ({
    fingerprint: JSON.stringify,
    loadEvaluationSuite: async () => ({
      suite: { id: "s", executorIdentity: { id: "scripted" } },
      suiteHash: "h".repeat(64),
      cases: [],
      program: {},
    }),
    preflightEvaluation: async () => 2,
  });
  const result = await runNatlangEval(
    { template: "base", suite: "packages/p/suite.ts", split: "validation", preflight: true },
    preflight.context,
    preflight.dependencies
  );
  assert.equal(result.exitCode, 0);
  assert.match(preflight.output[0], /preflight ok: suite s .*2 fixtures/);
});

test("input failures surface before anything is staged or composed", async (t) => {
  const run = (overrides, options) => {
    const { dependencies, context, events } = harness(t);
    return {
      events,
      promise: runNatlangEval(
        {
          template: "base",
          suite: "packages/p/suite.ts",
          split: "validation",
          preflight: false,
          ...options,
        },
        context,
        { ...dependencies, ...overrides }
      ),
    };
  };
  const unknown = run({}, { template: "nope" });
  await assert.rejects(
    unknown.promise,
    (error) =>
      error instanceof UsageError &&
      /Unknown template "nope"; expected one of base, personal/.test(error.message)
  );
  const missingSuite = run({}, { suite: "packages/p/absent.ts" });
  await assert.rejects(missingSuite.promise, /does not exist/);
  const missingRepository = run(
    { natlangRepository: () => natlangRepository({ NATLANG_REPO: "/nonexistent/natlang" }) },
    {}
  );
  await assert.rejects(missingRepository.promise, /set NATLANG_REPO/);
  const missingArtifact = run({}, { artifact: "/nonexistent/best.json" });
  await assert.rejects(missingArtifact.promise, /adaptation artifact does not exist/);
  for (const { events } of [unknown, missingSuite, missingRepository, missingArtifact]) {
    assert.equal(events.includes("stage"), false);
    assert.equal(
      events.some((event) => event.startsWith("release")),
      false
    );
  }
});

test("an evaluation failure reaches the caller after the projection and models are retired", async (t) => {
  const failure = Object.assign(new Error("worker exited"), {
    name: "EvaluationInfrastructureError",
  });
  const { dependencies, context, events, composed } = harness(t, {
    evaluate: async () => {
      throw failure;
    },
  });
  await assert.rejects(
    runNatlangEval(
      { template: "base", suite: "packages/p/suite.ts", split: "validation", preflight: false },
      context,
      dependencies
    ),
    (error) => error === failure
  );
  assert.deepEqual(events.slice(-5), [
    "close models",
    "retire",
    "release projection",
    "release composition",
    "hygiene",
  ]);
  assert.equal(fs.existsSync(composed), false);
  assert.equal(exitCodeFor(failure), 4);
  assert.equal(exitCodeFor(new AggregateError([new Error("x"), failure])), 4);
  assert.equal(exitCodeFor(new UsageError("x")), 2);
});

test("a cleanup failure is reported together with the failure it followed", async (t) => {
  const failure = new Error("score threw");
  const { dependencies, context } = harness(t, {
    evaluate: async () => {
      throw failure;
    },
  });
  const projection = dependencies.projection;
  dependencies.projection = async () => ({
    ...(await projection()),
    retireUserlandProjectionProcess: async () => {
      throw new Error("cache drain failed");
    },
  });
  await assert.rejects(
    runNatlangEval(
      { template: "base", suite: "packages/p/suite.ts", split: "validation", preflight: false },
      context,
      dependencies
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(failure) &&
      error.errors.some((item) => /cache drain failed/.test(item.message))
  );
});

test("a mismatched executor identity is refused and the models are still closed", async (t) => {
  const { dependencies, context, events } = harness(t, { identity: { id: "another-model" } });
  await assert.rejects(
    runNatlangEval(
      { template: "base", suite: "packages/p/suite.ts", split: "validation", preflight: false },
      context,
      dependencies
    ),
    (error) => error instanceof UsageError && /executorIdentity does not match/.test(error.message)
  );
  assert.ok(events.includes("close models"));
  assert.ok(events.includes("release composition"));
  assert.equal(
    events.some((event) => event.startsWith("evaluate")),
    false
  );
});
