#!/usr/bin/env node
/** Collect verified teacher executions of the canonical skill suites, using natlang:eval's owned projection. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runNatlangEval, resolveNatlangCommit } from "./natlang-eval.mjs";
import { natlangRepository, withNatlangWorktree } from "./lib/natlang-stage.mjs";
import { ownedEntry, retireOnAbort } from "./lib/owned-entry.mjs";
import { canonical, sha256, verifySemantics, acquireCollectionLock } from "./lib/natlang-teacher-data.mjs";
import { serializeTeacherIR } from "./lib/natlang-teacher-ir.mjs";
import { joinChildProcess } from "./lib/join-child-process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "scripts/natlang-teacher-suites.json");
const git = (directory, ...args) =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
const writeJSON = (file, value) => {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
};

export function parseArguments(argv) {
  const options = {
    provider: "openai-codex",
    model: "gpt-6-luna",
    effort: "low",
    replicate: 0,
    limit: 0,
    preflight: false,
    all: false,
    list: false,
  };
  const strings = new Set([
    "template",
    "suite",
    "out",
    "provider",
    "model",
    "effort",
    "natlang-commit",
    "case",
    "held-manifest",
  ]);
  const numbers = new Set(["limit", "replicate"]);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (!arg.startsWith("--") || seen.has(arg))
      throw new Error(`unknown or duplicate option ${arg}`);
    seen.add(arg);
    const name = arg.slice(2);
    if (["all", "list", "preflight", "export-only"].includes(name)) options[name === "export-only" ? "exportOnly" : name] = true;
    else if (strings.has(name) || numbers.has(name)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      const key = name === "natlang-commit" ? "natlangCommit" : name === "export-only" ? "exportOnly" : name;
      options[key] = numbers.has(name) ? Number(value) : value;
      if (numbers.has(name) && (!Number.isSafeInteger(options[key]) || options[key] < 0))
        throw new Error(`${arg} needs a nonnegative integer`);
    } else throw new Error(`unknown option ${arg}`);
  }
  if (
    !options.list &&
    (!options.out ||
      (options.all ? options.suite || options.template : !options.template || !options.suite))
  ) {
    throw new Error(
      "usage: natlang:teacher -- --all | --template T --suite PATH --out DIR [--preflight] [--case ID] [--limit N] [--replicate N] [--provider P --model M]"
    );
  }
  return options;
}

function provenance(directory, label, preflight = false) {
  const untracked = git(directory, "ls-files", "--others", "--exclude-standard")
    .split("\n")
    .filter((name) => name && !(label === "vibestudio" && name.startsWith("docs/")));
  if (!preflight && (git(directory, "diff", "HEAD", "--name-only") || untracked.length))
    throw new Error(`${label} has uncommitted source; commit before teacher collection`);
  return git(directory, "rev-parse", "HEAD");
}

function sourceCase(template, suite, testCase, commit) {
  const namespace = `vibestudio:${template}:${suite.id}`;
  return {
    id: testCase.id,
    group: testCase.group,
    split: testCase.split,
    input_sha256: sha256(testCase.input),
    suite: { id: suite.id, hash: suite.hash },
    source_ids: [...new Set([`${namespace}:${testCase.id}`, ...(testCase.source_ids ?? [])])],
    source_groups: [
      ...new Set([`${namespace}:${testCase.group}`, ...(testCase.source_groups ?? [])]),
    ],
    source_revisions: [...new Set([commit, ...(testCase.source_revisions ?? [])])],
  };
}

/** Children and their descendants share the launcher's ownership, including on interruption. */
async function runOwned(context, executable, args, cwd, env = process.env) {
  const owned = context.ownership.spawn(executable, args, {
    kill: "immediate", label: "natlang-teacher", cwd, env, stdio: "inherit",
  });
  retireOnAbort(context.ownership, context.signal, owned);
  const result = await joinChildProcess(owned.child);
  await owned.join();
  context.signal.throwIfAborted();
  if (result.error || result.code !== 0)
    throw new Error(`teacher subprocess failed (${result.signal ?? result.code}): ${executable}`, {
      cause: result.error,
    });
}

async function completeAdmission({ directory, work, pin, python, env, context, models, signal,
  caseByTaskId, source, assertSourceSnapshot }) {
  const helper = path.join(pin, "scripts/neuralese_data/teacher_admission.py");
  const draftFile = path.join(directory, "admission-drafts.json");
  await runOwned(context, python, [helper, "replay", "--pool", work, "--out", draftFile,
    "--runtime-repo", pin, "--work", path.join(directory, "admission-replay"), "--workers", "1"], pin, env);
  const drafts = JSON.parse(fs.readFileSync(draftFile, "utf8"));
  const manifestFile = path.join(work, "manifest.jsonl");
  const manifest = fs.readFileSync(manifestFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const bind = (file) => ({ path: path.resolve(file), sha256: sha256(fs.readFileSync(file, "utf8")) });
  const admissions = path.join(directory, "admissions");
  fs.mkdirSync(admissions, { recursive: true, mode: 0o700 });
  for (const draft of drafts.records) {
    const receipt = draft.receipt;
    receipt.inventory = bind(path.join(directory, "inventory.jsonl"));
    receipt.source = source;
    receipt.rejected_samples = [];
    const accepted = [];
    for (const sample of receipt.samples) {
      signal.throwIfAborted();
      const evidence = sample.outcome;
      let reason = !sample.replay.request_hashes?.length ? "no-model-turns"
        : !sample.replay.verified ? "replay-failed"
        : evidence.quality !== 1 ? "quality-below-one"
        : !Object.keys(evidence.gates ?? {}).length || !Object.values(evidence.gates).every((value) => value === true)
          ? "gate-failed" : evidence.tool_error_count ? "failed-action" : null;
      if (!reason) {
        const result = evidence.evaluation;
        const testCase = caseByTaskId.get(sample.task_id);
        if (!testCase) throw new Error(`canonical result has unknown source case ${sample.task_id}`);
        const reviewJournal = path.join(admissions, `${sha256({ result: sample.result,
          teacher: receipt.teacher, task_id: sample.task_id, sample: sample.sample })}.review.jsonl`);
        const auditedReviewer = async (request, callSignal) => {
          const append = (event) => fs.appendFileSync(reviewJournal, `${JSON.stringify(event)}\n`, { mode: 0o600 });
          append({ phase: "request", request });
          try {
            const reply = await models.judge(request, callSignal);
            append({ phase: "reply", reply });
            return reply;
          } catch (error) {
            append({ phase: "error", error: error.stack ?? String(error) });
            throw error;
          }
        };
        const semantic = await verifySemantics(auditedReviewer, testCase, result, signal);
        const requestCanonical = canonical(semantic.request);
        sample.semantic = { ...semantic, reviewer: { ...receipt.teacher, identity: models.identity },
          request_canonical: requestCanonical, request_sha256: sha256(requestCanonical) };
        if (semantic.verdict !== "accepted") reason = `semantic-${semantic.verdict}`;
      }
      (reason ? receipt.rejected_samples : accepted).push(reason ? { ...sample, rejection: reason } : sample);
    }
    receipt.samples = accepted;
    const receiptFile = path.join(admissions, `t${String(draft.manifest_index).padStart(6, "0")}.json`);
    assertSourceSnapshot();
    writeJSON(receiptFile, receipt);
    const entry = manifest[draft.manifest_index];
    if (!entry || path.resolve(entry.rollouts) !== path.resolve(draft.rollouts))
      throw new Error("canonical teacher manifest changed during admission");
    entry.admission = bind(receiptFile);
    console.log(JSON.stringify({ event: "admission", task: entry.task_id,
      accepted: accepted.length, rejected: receipt.rejected_samples.length }));
  }
  assertSourceSnapshot();
  fs.writeFileSync(`${manifestFile}.tmp`, manifest.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  fs.renameSync(`${manifestFile}.tmp`, manifestFile);
  await runOwned(context, python, [helper, "check", "--pool", work], pin, env);
}

/** Export the original suite as program IR, then use Natlang's canonical collector and admission path. */
export async function collectSuite(options, context, dependencies = {}) {
  const directory = path.resolve(options.out);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const releaseLock = acquireCollectionLock(path.join(directory, ".collect.lock"));
  const sessions = [];
  try {
    const configured = createRequire(import.meta.url)(
      "../src/dev/developmentTemplateConfig.cjs"
    ).requireDevelopmentTemplateCheckouts(root);
    const templateCommit = provenance(configured.checkouts[options.template], options.template, options.preflight);
    const baseCommit = provenance(configured.checkouts.base, "base", options.preflight);
    const hostCommit = provenance(root, "vibestudio", options.preflight);
    const assertSourceSnapshot = () => {
      if (options.preflight) return;
      if (provenance(configured.checkouts[options.template], options.template) !== templateCommit ||
          provenance(configured.checkouts.base, "base") !== baseCommit ||
          provenance(root, "vibestudio") !== hostCommit)
        throw new Error("source changed during collection; use a fresh pinned snapshot and output directory");
    };
    const openModels = async (natlang) => {
      const choice = {
        kind: "pi-provider", provider: options.provider, model: options.model,
        piMode: "native", promptRendering: "full", piOptions: { reasoningEffort: options.effort },
      };
      const session = natlang.createResolvedModelSession(choice, process.env, process.stderr);
      sessions.push(session);
      return {
        identity: natlang.executorIdentityForChoice(choice),
        judge: natlang.sessionDriver(session),
        close: async () => { for (const owned of sessions.splice(0)) await owned.close(); },
      };
    };
    return await runNatlangEval(
      { template: options.template, suite: options.suite, natlangCommit: options.natlangCommit }, context,
      { ...dependencies, openModels,
        evaluateSuite: async ({ natlang, prepared, models, signal, commit, suiteRelative, workspaceRoot }) => {
          assertSourceSnapshot();
          const suite = { id: prepared.suite.id, hash: prepared.suiteHash, path: suiteRelative };
          const source = {
            template: options.template, template_commit: templateCommit, base_commit: baseCommit,
            program_sha256: prepared.program.buildHash, natlang_commit: commit,
            vibestudio_commit: hostCommit, dirty: Boolean(options.preflight),
          };
          const selection = JSON.parse(fs.readFileSync(catalogPath, "utf8")).find(
            (item) => item.template === options.template && item.path === suiteRelative
          );
          if (!selection) throw new Error(`suite has no reviewed IR decomposition: ${suiteRelative}`);
          const records = prepared.cases.map((testCase) => serializeTeacherIR({
            selection, testCase, workspaceRoot, source,
            sourceCase: sourceCase(options.template, suite, testCase, templateCommit),
          }));
          const selected = records.filter((record) => record.split === "train" &&
            (!options.case || record.id === options.case || record.id.endsWith(`:${options.case}`)))
            .slice(0, options.limit || undefined);
          if (!selected.length) throw new Error("no selected training cases; validation and test cases are protected");
          const content = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
          const inventory = content(records), pool = content(selected);
          const binding = { schema: "vibestudio.teacher-ir-export/1", suite, source,
            teacher: { provider: options.provider, model_id: options.model, reasoning_effort: options.effort },
            replicate: options.replicate, inventory_sha256: sha256(inventory), pool_sha256: sha256(pool),
          };
          const manifestPath = path.join(directory, "source.json");
          if (fs.existsSync(manifestPath) && canonical(JSON.parse(fs.readFileSync(manifestPath, "utf8"))) !== canonical(binding))
            throw new Error("IR source, teacher, split inventory or replicate changed; use a new --out");
          fs.writeFileSync(path.join(directory, "inventory.jsonl"), inventory, { mode: 0o600 });
          fs.writeFileSync(path.join(directory, "pool.jsonl"), pool, { mode: 0o600 });
          writeJSON(manifestPath, binding);
          if (options.preflight) {
            const result = await natlang.preflightEvaluation(prepared);
            console.log(JSON.stringify({ event: "preflight", suite: suite.id, ir_records: records.length, ...result }));
            return { exitCode: 0 };
          }
          if (options.exportOnly) return { exitCode: 0, resultPath: manifestPath };
          const pin = options.runtimePin;
          if (!pin) throw new Error("teacher collection requires its pinned Natlang checkout");
          const python = path.join(natlangRepository(), ".venv-neuralese/bin/python");
          const work = path.join(directory, "teacher");
          const env = { ...process.env, NATLANG_REPO: pin,
            PYTHONPATH: `${pin}/training/neuralese:${pin}`, OMP_NUM_THREADS: "1", MKL_NUM_THREADS: "1" };
          await runOwned(context, python, [path.join(pin, "scripts/neuralese_data/teacher_gen.py"),
            "--work", work, "--pool", path.join(directory, "pool.jsonl"), "--root-mode", "authored",
            "--teacher", JSON.stringify({ ...binding.teacher, slots: 1 }),
            "--samples", "1", "--seed-base", String(50000000 + options.replicate * 1000000),
            ...(options["held-manifest"] ? ["--held-manifest", path.resolve(options["held-manifest"])] : []),
          ], pin, env);
          assertSourceSnapshot();
          // Replay and semantic receipts are bound to canonical program IR, native results and rollout bytes.
          await completeAdmission({ directory, work, pin, python, env, context, models, signal,
            caseByTaskId: new Map(records.map((record) => [record.id, record.semantics.evaluation_fixture.case])), source, assertSourceSnapshot });
          return { exitCode: 0, resultPath: path.join(work, "manifest.jsonl") };
        },
      }
    );
  } finally {
    try { for (const session of sessions.splice(0)) await session.close(); }
    finally { releaseLock(); }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  if (options.list) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }
  options.natlangCommit = resolveNatlangCommit(natlangRepository(), options.natlangCommit);
  const selections = options.all ? catalog : [{ template: options.template, path: options.suite }];
  await ownedEntry(async (context) => {
    const collect = async (runtimePin) => {
      for (const selection of selections) {
        const out = options.all
          ? path.join(options.out, selection.template, path.dirname(selection.path).replaceAll("/", "_"))
          : options.out;
        const result = await collectSuite({ ...options, runtimePin,
          template: selection.template, suite: selection.path, out }, context);
        if (result?.exitCode) throw new Error(`teacher suite failed: ${selection.path}`);
      }
    };
    if (options.preflight || options.exportOnly) return collect();
    await withNatlangWorktree(natlangRepository(), options.natlangCommit, async (tsHost) => {
      const runtimePin = path.dirname(tsHost);
      await runOwned(context, path.join(path.dirname(process.execPath), "npm"),
        ["run", "build:node"], tsHost);
      await collect(runtimePin);
    }, context.scratchRoot);
  }, { appRoot: root, scratchPrefix: "natlang-teacher-" });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
