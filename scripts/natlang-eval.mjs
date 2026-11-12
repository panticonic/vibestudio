#!/usr/bin/env node
/**
 * Run a natlang evaluation suite from the host against a host-owned projection of a template's workspace sources.
 *
 *   pnpm natlang:eval -- --template T --suite PATH [--split train|validation|test] [--artifact FILE]
 *                        [--preflight] [--out DIR] [--natlang-commit REV] [--case-deadline-ms N] [--instance ID]
 *
 * Natlang's evaluation system (`defineEvaluationSuite`: train/validation/locked-test splits, scorers, judges, budgets,
 * GEPA/reflection adaptation) is Node-only, because every rollout runs in a fresh worker. It therefore cannot run inside a
 * workspace panel, DO, or eval cell. This script is the matching command of `natlang eval suite.ts --split validation`
 * (ts-host/src/cli/adaptation.ts), as a thin driver over natlang's own evaluation API:
 *
 *   - natlang bundle: `ts-host/scripts/stage-vibestudio.mjs --only eval` of a natlang commit (`origin/main` unless
 *     `--natlang-commit`), staged from a temporary git worktree of `NATLANG_REPO` (default ~/natlang; the checkout is
 *     shared with live editors, so it is never staged in place) by scripts/lib/natlang-stage.mjs. The staged bundle is
 *     cached by commit in `.cache/natlang-eval/stage/<commit>`; a run copies it next to the natlang checkout's installed
 *     packages, which are the bundle's external npm dependencies (yaml, just-bash, ...).
 *   - projection: the same machinery as `pnpm test:userland`. The configured Base (plus template T) checkouts are composed
 *     (`composeDevelopmentTemplateCheckouts`) and their declared npm dependencies projected
 *     (`prepareUserlandDependencyProjection`); the suite runs from that composed copy, so natlang's compile output
 *     (`.natlang/`) lands in scratch and never in a template checkout. The composed root's `node_modules` holds the
 *     projected npm packages, so suite and program files import their declared dependencies normally. Workspace
 *     packages are TypeScript source and natlang's evaluation workers are worker threads, which no loader reaches on this
 *     Node (tsx does not apply in worker threads, and Node has no type stripping), so suite and program files cannot import
 *     `@workspace/*` source; a program a suite evaluates is self-contained (its `.nl`/`.ts` files, services as declarations
 *     and recorded fixtures, npm packages).
 *   - everything the run owns (process-tree scratch, projection, composition) is retired in a finally-equivalent path
 *     before the command returns, on success, failure, or a stop signal. Only the staged-bundle cache and the results
 *     persist.
 *
 * Suite conventions
 *   - A suite imports natlang's API from `@workspace/natlang/evaluation` (`defineEvaluationSuite`, ...) and
 *     `@workspace/natlang/model` (`executorIdentityForChoice`, `loadModelConfiguration`, ...): type-checked in the
 *     workspace against the vendored declarations, resolved here to the staged bundle.
 *   - A suite lives beside its program as `suite.ts` + `cases.jsonl` in the template's workspace tree, and `--suite` names
 *     it by path relative to the workspace root (an absolute path inside a template checkout is mapped to that).
 *   - `suite.ts` default-exports an `EvaluationSuite` (natlang `defineEvaluationSuite`'s argument), with `program.root`
 *     the program's directory (conventionally `.`) and `cases: "./cases.jsonl"`: one JSON object per line with `id`,
 *     `group`, an explicit `split` and `input`/`expected`. It may import its program files and npm packages.
 *   - `executorIdentity` is the identity of the model under test. It must equal `executorIdentityForChoice` of the
 *     profile `suite.models.executor` names (checked as natlang's CLI does), so an adaptation artifact is bound to the
 *     model that produced it.
 *   - Services in cases are recorded fixtures (natlang `recordingServices` / the case's service replays) that the
 *     suite's `fixture.create` binds into the runtime. No live Vibestudio service is needed, or reachable.
 *   - The executor is natlang's resolved model: on this host its managed local runtime with the stock LFM3 model.
 *     Quality runs are explicit and budgeted: the suite's `budget` is enforced by natlang's usage gateway.
 *
 * Recording
 *   `--instance ID` also posts the result's summary (suite, split, executor, quality, per-case scores, gates) to the managed
 *   instance's natlang records service through its paired CLI (`pnpm cli --instance ID`, scripts/lib/natlang-instance-
 *   records.mjs), so the natlang panel's Evaluations page shows the latest result per program with its gates. The instance
 *   is resolved before anything runs; the result file is written first, and a failure to record is reported (exit 4)
 *   with the file's path.
 *
 * Contract
 *   exit 0  every case scored and every gate passed        exit 3  cases ran; a gate failed or a case was not scored
 *   exit 2  usage, configuration or suite error            exit 4  evaluation infrastructure failure (worker, model)
 *   exit 128+N  stopped by signal N (workers cancelled, scratch retired)
 *   stdout: a human summary (suite, executor, per-case lines, quality, budget spent, result path).
 *   stderr: progress while it runs, one line per case start and per model request start or finish (`watchProgress`), so a
 *   slow run on the shared local model is told from a stalled one.
 *   Results: JSON at `<out>/<split>-<UTC stamp>.json`, `--out` defaulting to
 *   `.cache/natlang-eval/results/<template>/<suite id>`; the path is printed.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runWithOwnedCleanup, runOwnedCleanupSteps } from "./lib/owned-cleanup.mjs";
import { ownedEntry } from "./lib/owned-entry.mjs";
import { natlangRepository, stageNatlang } from "./lib/natlang-stage.mjs";
import { RecordingError, openInstanceRecorder } from "./lib/natlang-instance-records.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPLITS = ["train", "validation", "test"];
/** The longest delay a timer takes (a larger one fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;
const SUITE_EXTENSION = /\.m?[jt]s$/u;
const STAGE_PIN = "natlang-pin.json";
const EVAL_BUNDLE = "eval/natlang-eval.js";

/** A failure of the command's input: reported with exit status 2. */
export class UsageError extends Error {
  name = "UsageError";
}

/** Parse the command line as natlang's CLI does: unknown, duplicate, valueless options and stray words are errors. */
export function parseArguments(argv) {
  const valued = {
    "--template": "template",
    "--suite": "suite",
    "--split": "split",
    "--artifact": "artifact",
    "--out": "out",
    "--natlang-commit": "natlangCommit",
    "--case-deadline-ms": "caseDeadlineMs",
    "--instance": "instance",
  };
  const options = { split: "validation", preflight: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
    if (argument === "--preflight") {
      seen.add(argument);
      options.preflight = true;
    } else if (argument in valued) {
      seen.add(argument);
      const value = argv[(index += 1)];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`missing value: ${argument}`);
      }
      options[valued[argument]] = value;
    } else {
      throw new UsageError(`unknown option: ${argument}`);
    }
  }
  if (!options.template) throw new UsageError("--template is required");
  if (!options.suite) throw new UsageError("--suite is required");
  if (!SPLITS.includes(options.split)) {
    throw new UsageError(`--split must be one of ${SPLITS.join(", ")}`);
  }
  if (options.caseDeadlineMs !== undefined) {
    options.caseDeadlineMs = Number(options.caseDeadlineMs);
    if (!Number.isInteger(options.caseDeadlineMs) || options.caseDeadlineMs < 1 || options.caseDeadlineMs > MAX_TIMER_MS) {
      throw new UsageError(`--case-deadline-ms must be a whole number of milliseconds between 1 and ${MAX_TIMER_MS}`);
    }
  }
  return options;
}

/** The suite's path relative to the workspace root; it must exist beneath one of the `roots` (checkouts or the composition). */
export function locateSuite(suite, roots, checkouts = roots) {
  if (!SUITE_EXTENSION.test(suite)) {
    throw new UsageError(`--suite must be a .ts, .mts, .js or .mjs module: ${suite}`);
  }
  let relative = suite;
  if (path.isAbsolute(suite)) {
    const owner = checkouts.find((checkout) => !path.relative(checkout, suite).startsWith(".."));
    if (!owner) {
      throw new UsageError(`--suite ${suite} is not inside a template checkout of this run`);
    }
    relative = path.relative(owner, suite);
  }
  relative = path.normalize(relative);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError(`--suite must stay inside the workspace: ${suite}`);
  }
  if (
    !roots.some((root) =>
      fs.statSync(path.join(root, relative), { throwIfNoEntry: false })?.isFile()
    )
  ) {
    throw new UsageError(
      `suite ${relative} does not exist in the ${roots.length > 1 ? "composed " : ""}workspace`
    );
  }
  return relative;
}

/** The natlang commit to stage: `revision` resolved in `repository` (no fetch: it names what the checkout already has). */
export function resolveNatlangCommit(repository, revision = "origin/main") {
  try {
    return execFileSync(
      "git",
      ["-C", repository, "rev-parse", "--verify", `${revision}^{commit}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
  } catch (cause) {
    throw new UsageError(
      `natlang revision ${revision} does not resolve in ${repository}: ${cause.stderr?.trim() ?? cause.message}`
    );
  }
}

/**
 * The staged eval bundle of `commit`: `<cacheRoot>/stage/<commit>`, staged (through `stage`, in `scratchRoot`) when absent.
 * A staged directory becomes visible only complete (rename), so a stop mid-stage or a concurrent run never sees half of one;
 * the other commits' directories are retired once this one is in place.
 */
export async function ensureStagedEval({
  repository,
  commit,
  cacheRoot,
  scratchRoot,
  stage = stageNatlang,
}) {
  const stageRoot = path.join(cacheRoot, "stage");
  const target = path.join(stageRoot, commit);
  if (!fs.existsSync(path.join(target, STAGE_PIN))) {
    const out = path.join(scratchRoot, `stage-${commit}`);
    const staged = await stage({ repository, commit, only: "eval", out, scratchRoot });
    if (staged !== commit) throw new Error(`staging ${commit} produced ${staged}`);
    fs.mkdirSync(stageRoot, { recursive: true });
    const incoming = fs.mkdtempSync(path.join(stageRoot, ".incoming-"));
    try {
      fs.cpSync(out, incoming, { recursive: true });
      // A concurrent run that published the same commit first wins; both hold identical content.
      if (!fs.existsSync(path.join(target, STAGE_PIN))) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(incoming, target);
      }
    } finally {
      fs.rmSync(incoming, { recursive: true, force: true });
    }
  }
  for (const entry of fs.readdirSync(stageRoot)) {
    if (entry !== commit && !entry.startsWith(".incoming-")) {
      fs.rmSync(path.join(stageRoot, entry), { recursive: true, force: true });
    }
  }
  return target;
}

/**
 * Arrange a staged bundle the way natlang's own worktree is laid out, so its external npm packages resolve from the
 * natlang checkout that installed them (`ts-host/node_modules`, then the repository's `node_modules`).
 * Returns the bundle's entry module.
 */
export function layoutEvalBundle({ stagedDir, repository, runRoot }) {
  const tsHost = path.join(runRoot, "ts-host");
  fs.mkdirSync(tsHost, { recursive: true });
  fs.cpSync(path.join(stagedDir, "eval"), path.join(tsHost, "eval"), { recursive: true });
  // The bundle is ES module code. Natlang's own tree says so in `ts-host/package.json`; without it the bundle is loaded
  // through tsx's CommonJS resolver, which cannot read the `import`-only exports of its npm packages (pi-ai).
  fs.writeFileSync(path.join(tsHost, "package.json"), '{ "type": "module" }\n');
  for (const [from, to] of [
    [path.join(repository, "ts-host/node_modules"), path.join(tsHost, "node_modules")],
    [path.join(repository, "node_modules"), path.join(runRoot, "node_modules")],
  ]) {
    if (fs.existsSync(from)) fs.symlinkSync(from, to);
  }
  // natlang compiles a suite's program against `new URL("../index.js", import.meta.url)` of the bundle (its package
  // root); the bundle exports the same runtime API from its own entry.
  fs.writeFileSync(path.join(tsHost, "index.js"), 'export * from "./eval/natlang-eval.js";\n');
  fs.writeFileSync(path.join(tsHost, "index.d.ts"), 'export * from "./eval/natlang-eval.js";\n');
  // The bundle finds model chat templates at `../../../models/templates` from its own file, as the source tree does
  // from `ts-host/src/llama`; without them the managed model reports itself unavailable.
  const models = path.join(repository, "models");
  if (fs.existsSync(models)) fs.symlinkSync(models, path.join(path.dirname(runRoot), "models"));
  return path.join(tsHost, EVAL_BUNDLE);
}

/** Make `workspaceRoot` resolve the projected npm packages, as an installed workspace's `node_modules` does. */
export function linkProjectedModules(workspaceRoot, nodeModulesDir) {
  const modules = path.join(workspaceRoot, "node_modules");
  fs.mkdirSync(modules);
  if (nodeModulesDir) {
    for (const name of fs.readdirSync(nodeModulesDir)) {
      if (!name.startsWith("."))
        fs.symlinkSync(path.join(nodeModulesDir, name), path.join(modules, name));
    }
  }
  return modules;
}

/**
 * The specifiers a suite imports natlang's evaluation API and model session API from. In the workspace they are the
 * type-only exports `@workspace/natlang/evaluation` and `/model` (the vendored declarations of this same bundle); here
 * they resolve to the staged bundle that runs the suite.
 */
export function linkSuiteSpecifiers(modulesDir, entry) {
  const directory = path.join(modulesDir, "@workspace", "natlang");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "@workspace/natlang",
      type: "module",
      exports: {
        "./evaluation": { types: "./evaluation.d.ts", default: "./evaluation.js" },
        "./model": { types: "./evaluation.d.ts", default: "./evaluation.js" },
      },
    })
  );
  fs.writeFileSync(
    path.join(directory, "evaluation.js"),
    `export * from ${JSON.stringify(pathToFileURL(entry).href)};\n`
  );
  // The suite is type-checked as natlang builds it (strict): its imports need the bundle's declarations.
  fs.writeFileSync(
    path.join(directory, "evaluation.d.ts"),
    `export * from ${JSON.stringify(entry)};\n`
  );
}

/**
 * The executor (and judge) models of a suite, resolved as natlang's CLI resolves them: the profiles `suite.models` name,
 * opened as sessions of natlang's managed local runtime (or the external provider the profile selects).
 * Returns `{ identity, driver, judge, close }`; `close` stops what the sessions started.
 */
export async function openNatlangModels(
  natlang,
  suite,
  { environment = process.env, error = process.stderr } = {}
) {
  for (const name of [
    "loadModelConfiguration",
    "createResolvedModelSession",
    "localModelPrerequisites",
    "sessionDriver",
  ]) {
    if (typeof natlang[name] !== "function") {
      throw new Error(
        `the staged natlang eval bundle does not export ${name}; ` +
          "stage a natlang commit whose ts-host/src/entry/evaluation.ts exports the model session API"
      );
    }
  }
  const configurations = [
    natlang.loadModelConfiguration(suite.models?.executor),
    ...(suite.models?.judge ? [natlang.loadModelConfiguration(suite.models.judge)] : []),
  ];
  if (
    configurations.some((configuration) => configuration.choice.kind === "managed-local") &&
    !natlang.localModelPrerequisites().available
  ) {
    throw new UsageError("managed model is unavailable; run natlang --setup");
  }
  const identity = natlang.executorIdentityForChoice(configurations[0].choice);
  const sessions = [];
  const open = (configuration) => {
    const session = natlang.createResolvedModelSession(configuration.choice, environment, error);
    sessions.push(session);
    // The session as a runtime driver, with the capabilities the runtime reads off the driver itself (the decision
    // readout, the Neuralese runtime), so no wrapper of ours can drop one.
    return natlang.sessionDriver(session);
  };
  try {
    return {
      identity,
      driver: open(configurations[0]),
      judge: configurations[1] ? open(configurations[1]) : undefined,
      close: () =>
        runOwnedCleanupSteps(
          sessions.map((session) => () => session.close()),
          "model session cleanup failed"
        ),
    };
  } catch (failure) {
    await runOwnedCleanupSteps(
      sessions.map((session) => () => session.close()),
      "model session cleanup failed"
    );
    throw failure;
  }
}

function stamp(date = new Date()) {
  return date.toISOString().replaceAll(/[:.]/gu, "-");
}

const slug = (value) => value.replaceAll(/[^A-Za-z0-9._-]+/gu, "_");

function formatSummary(record) {
  const { summary, budget } = record;
  const lines = [
    `suite ${record.suite.id}  (${record.suite.hash.slice(0, 12)})  template ${record.template}  split ${record.split}`,
    `executor ${JSON.stringify(record.executorIdentity)}`,
    `natlang ${record.natlang.commit.slice(0, 12)}`,
    `cases ${Object.entries(record.suite.cases)
      .map(([split, count]) => `${split}=${count}`)
      .join(" ")}`,
  ];
  for (const result of record.batch.results) {
    const detail = result.outcome.error
      ? ` ${result.outcome.error.outcome ?? result.outcome.error.name}`
      : "";
    lines.push(`  ${result.caseId}: ${result.status} quality=${result.quality ?? "n/a"}${detail}`);
  }
  lines.push(
    `quality ${summary.quality ?? "n/a"}  cases ${summary.cases}  gates ${summary.gatesPassed ? "passed" : "FAILED"}  ` +
      `model calls ${summary.modelCalls}  mean latency ${summary.meanLatencyMs === null ? "n/a" : `${Math.round(summary.meanLatencyMs)}ms`}`,
    `budget spent: rollouts ${budget.ledger.rollouts}/${budget.limits.maxRollouts}, ` +
      `model calls ${budget.ledger.usage.modelCalls}/${budget.limits.maxModelCalls}, ` +
      `tokens in ${budget.ledger.usage.inputTokens ?? "unknown"} out ${budget.ledger.usage.outputTokens ?? "unknown"}, ` +
      `elapsed ${budget.ledger.elapsedMs}ms`
  );
  return lines.join("\n");
}

/**
 * Report the evaluation's progress on `write` as the gateway meters it: one line when a case starts and each time a model
 * request starts or finishes, with how many are in flight. The evaluation says nothing else until it ends, and on the shared
 * local model a validation run takes hours, so without these lines a slow run cannot be told from a stalled one: a run
 * that is moving prints a line per request, and silence with a request in flight means the model server owes an answer.
 */
export function watchProgress(gateway, write, now = Date.now) {
  const started = now();
  let previous = "";
  gateway.onUpdate = (ledger) => {
    const inFlight = ledger.reserved?.modelCalls ?? 0;
    const key = `${ledger.rollouts}|${ledger.usage.modelCalls}|${inFlight}`;
    if (key === previous) return;
    previous = key;
    const seconds = Math.round((now() - started) / 1000);
    const clock = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
    write(
      `[+${clock}] case ${ledger.rollouts}  model requests ${ledger.usage.modelCalls} started, ${inFlight} in flight` +
        `  tokens in ${ledger.usage.inputTokens ?? "unknown"} out ${ledger.usage.outputTokens ?? "unknown"}`
    );
  };
}

/** The collaborators a run uses; the defaults are the real ones. Tests substitute the heavy ones. */
export const defaultDependencies = {
  natlangRepository,
  resolveNatlangCommit,
  stage: stageNatlang,
  async templates() {
    const { requireDevelopmentTemplateCheckouts } = createRequire(import.meta.url)(
      "../src/dev/developmentTemplateConfig.cjs"
    );
    const { assertTemplateCheckoutHygiene } = await import("./lib/template-checkout-hygiene.mjs");
    return {
      selected: requireDevelopmentTemplateCheckouts(appRoot),
      assertTemplateCheckoutHygiene,
    };
  },
  async projection() {
    const { composeDevelopmentTemplateCheckouts } =
      await import("../src/dev/developmentTemplateComposition.ts");
    const { prepareUserlandDependencyProjection } =
      await import("./lib/userland-dependency-projection.ts");
    const { retireUserlandProjectionProcess } =
      await import("./lib/userland-projection-process-owner.ts");
    return {
      composeDevelopmentTemplateCheckouts,
      prepareUserlandDependencyProjection,
      retireUserlandProjectionProcess,
    };
  },
  loadEval: (entry) => import(pathToFileURL(entry).href),
  openModels: openNatlangModels,
  openInstanceRecorder,
  stdout: (text) => process.stdout.write(`${text}\n`),
  progress: (text) => process.stderr.write(`${text}\n`),
  cacheRoot: path.join(appRoot, ".cache/natlang-eval"),
};

/**
 * Run the suite and return `{ exitCode, resultPath, record }`. `context` is `ownedEntry`'s `{ signal, ownership,
 * scratchRoot }`. Every resource the run creates is retired before this settles, whatever happened.
 */
export async function runNatlangEval(options, context, dependencies = defaultDependencies) {
  const { signal, ownership, scratchRoot } = context;
  const deps = { ...defaultDependencies, ...dependencies };
  const { selected, assertTemplateCheckoutHygiene } = await deps.templates();
  const known = selected.sources.map(({ id }) => id);
  if (!known.includes(options.template)) {
    throw new UsageError(
      `Unknown template ${JSON.stringify(options.template)}; expected one of ${known.join(", ")}`
    );
  }
  const sources = selected.sources.filter(({ id }) => id === "base" || id === options.template);
  const checkouts = sources.map(({ id }) => selected.checkouts[id]);
  assertTemplateCheckoutHygiene(selected);
  locateSuite(options.suite, checkouts);
  if (
    options.artifact &&
    !fs.statSync(path.resolve(options.artifact), { throwIfNoEntry: false })?.isFile()
  ) {
    throw new UsageError(`adaptation artifact does not exist: ${options.artifact}`);
  }
  const repository = deps.natlangRepository();
  const commit = deps.resolveNatlangCommit(repository, options.natlangCommit);
  // A stopped or mistyped instance fails now, not after the evaluation has run.
  const recorder = options.instance ? await deps.openInstanceRecorder(options.instance) : undefined;

  const retirements = [];
  const projectionTools = await deps.projection();
  return runWithOwnedCleanup(
    async () => {
      const stagedDir = await ensureStagedEval({
        repository,
        commit,
        cacheRoot: deps.cacheRoot,
        scratchRoot,
        stage: deps.stage,
      });
      const entry = layoutEvalBundle({
        stagedDir,
        repository,
        runRoot: path.join(scratchRoot, "natlang"),
      });

      const composition = projectionTools.composeDevelopmentTemplateCheckouts(
        sources.map(({ id, url }) => ({ checkout: selected.checkouts[id], url }))
      );
      retirements.push(composition.release);
      await ownership.own(composition.root, "template composition");
      signal.throwIfAborted();
      const projection = await projectionTools.prepareUserlandDependencyProjection({
        appRoot,
        workspaceRoot: composition.root,
        includeDevelopmentDependencies: true,
      });
      retirements.unshift(projection.release);
      signal.throwIfAborted();
      linkSuiteSpecifiers(linkProjectedModules(composition.root, projection.nodeModulesDir), entry);
      const suiteRelative = locateSuite(options.suite, [composition.root], checkouts);

      const natlang = await deps.loadEval(entry);
      const prepared = await natlang.loadEvaluationSuite(
        path.join(composition.root, suiteRelative)
      );
      const models = await deps.openModels(natlang, prepared.suite);
      return runWithOwnedCleanup(
        () =>
          evaluateSuite({
            natlang,
            prepared,
            models,
            options,
            signal,
            deps,
            commit,
            suiteRelative,
            recorder,
          }),
        () => models.close(),
        "Model session cleanup failed"
      );
    },
    async () => {
      await projectionTools.retireUserlandProjectionProcess(retirements);
      assertTemplateCheckoutHygiene(selected);
    },
    "natlang eval and its cleanup failed"
  );
}

async function evaluateSuite({
  natlang,
  prepared,
  models,
  options,
  signal,
  deps,
  commit,
  suiteRelative,
  recorder,
}) {
  const { suite } = prepared;
  // The artifact is bound to the executor identity, so the identity must be the one the suite declares.
  if (natlang.fingerprint(models.identity) !== natlang.fingerprint(suite.executorIdentity)) {
    throw new UsageError(
      "suite executorIdentity does not match the resolved executor profile; compare it with executorIdentityForChoice"
    );
  }
  if (options.preflight) {
    const fixtures = await natlang.preflightEvaluation(prepared);
    deps.stdout(
      `preflight ok: suite ${suite.id} (${prepared.suiteHash.slice(0, 12)}), ${prepared.cases.length} cases, ${fixtures} fixtures`
    );
    return { exitCode: 0, record: undefined, resultPath: undefined };
  }
  const candidate = options.artifact
    ? natlang.bindAdaptation(
        natlang.loadAdaptation(path.resolve(options.artifact)),
        prepared.program,
        models.identity
      ).candidate
    : undefined;
  const gateway = new natlang.UsageGateway(suite.budget);
  watchProgress(gateway, deps.progress);
  const batch = await natlang.evaluate(prepared, {
    split: options.split,
    candidate,
    driver: models.driver,
    judge: models.judge,
    gateway,
    signal,
    // A case runs until it ends: slow local inference is not a failure. `--case-deadline-ms` is an explicit bound for an
    // investigation; without it the worker's watchdog is set to the longest timer the platform allows.
    timeoutMs: options.caseDeadlineMs ?? MAX_TIMER_MS,
  });
  const cases = {};
  for (const testCase of prepared.cases) cases[testCase.split] = (cases[testCase.split] ?? 0) + 1;
  const record = {
    schema: "vibestudio.natlang-eval/1",
    template: options.template,
    natlang: { commit },
    suite: { id: suite.id, path: suiteRelative, hash: prepared.suiteHash, cases },
    split: options.split,
    artifact: options.artifact ?? null,
    executorIdentity: models.identity,
    summary: natlang.evaluationSummary(batch, prepared.cases),
    budget: { limits: suite.budget, ledger: gateway.snapshot() },
    batch,
  };
  const directory = path.resolve(
    options.out ?? path.join(deps.cacheRoot, "results", slug(options.template), slug(suite.id))
  );
  fs.mkdirSync(directory, { recursive: true });
  const resultPath = path.join(directory, `${options.split}-${stamp()}.json`);
  fs.writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`);
  deps.stdout(`${formatSummary(record)}\nresults ${resultPath}`);
  if (recorder) {
    try {
      const evaluationId = await recorder.record(record);
      deps.stdout(`recorded on instance ${options.instance}: ${evaluationId}`);
    } catch (error) {
      throw new RecordingError(
        `the evaluation ran and its result is in ${resultPath}, but instance ${options.instance} did not record it: ${error?.message ?? error}`
      );
    }
  }
  return { exitCode: batch.gatesPassed ? 0 : 3, record, resultPath };
}

/** The exit status of a failed run. */
export function exitCodeFor(error) {
  const failures = error instanceof AggregateError ? error.errors : [error];
  if (failures.some((failure) => ["EvaluationInfrastructureError", "RecordingError"].includes(failure?.name))) return 4;
  return 2;
}

export async function main(argv = process.argv.slice(2)) {
  let outcome;
  try {
    const options = parseArguments(argv);
    outcome = await ownedEntry((context) => runNatlangEval(options, context), {
      appRoot,
      scratchPrefix: "natlang-eval-",
    });
  } catch (error) {
    console.error(
      error instanceof AggregateError
        ? error.errors.map((item) => item?.message ?? item).join("\n")
        : (error?.message ?? error)
    );
    process.exitCode ||= exitCodeFor(error);
    return;
  }
  // A stop request settles `ownedEntry` without a value and has set the exit status itself.
  if (outcome) process.exitCode ||= outcome.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
