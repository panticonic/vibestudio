#!/usr/bin/env node
/** Collect verified teacher executions of the canonical skill suites, using natlang:eval's owned projection. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runNatlangEval, resolveNatlangCommit } from "./natlang-eval.mjs";
import { natlangRepository } from "./lib/natlang-stage.mjs";
import { ownedEntry } from "./lib/owned-entry.mjs";
import {
  canonical,
  sha256,
  requestHash,
  replayDriver,
  trainingTurn,
  eligibility,
  toolErrorCount,
  verifySemantics,
  validateEpisode,
  acquireCollectionLock,
} from "./lib/natlang-teacher-data.mjs";

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
    if (["all", "list", "preflight"].includes(name)) options[name] = true;
    else if (strings.has(name) || numbers.has(name)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      const key = name === "natlang-commit" ? "natlangCommit" : name;
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

/** The same owned fixture projection and model session implementation as evaluation; no second compiler path. */
export async function collectSuite(options, context, dependencies = {}) {
  const directory = path.resolve(options.out);
  fs.mkdirSync(path.join(directory, "episodes"), { recursive: true, mode: 0o700 });
  const releaseLock = acquireCollectionLock(path.join(directory, ".collect.lock"));
  const sessions = [];
  try {
    const configured = createRequire(import.meta.url)(
      "../src/dev/developmentTemplateConfig.cjs"
    ).requireDevelopmentTemplateCheckouts(root);
    const templateCommit = provenance(
      configured.checkouts[options.template],
      options.template,
      options.preflight
    );
    const baseCommit = provenance(configured.checkouts.base, "base", options.preflight);
    const hostCommit = provenance(root, "vibestudio", options.preflight);
    const assertSourceSnapshot = () => {
      if (options.preflight) return;
      if (
        provenance(configured.checkouts[options.template], options.template) !== templateCommit ||
        provenance(configured.checkouts.base, "base") !== baseCommit ||
        provenance(root, "vibestudio") !== hostCommit
      ) {
        throw new Error(
          "source changed during collection; use a fresh pinned snapshot and output directory"
        );
      }
    };
    const openModels = async (natlang) => {
      // Explicit provider selection cannot accidentally start a local student server or use its credentials.
      const choice = {
        kind: "pi-provider",
        provider: options.provider,
        model: options.model,
        piMode: "native",
        promptRendering: "full",
        piOptions: { reasoningEffort: options.effort },
      };
      const session = natlang.createResolvedModelSession(choice, process.env, process.stderr);
      sessions.push(session);
      const backend = natlang.sessionDriver(session);
      // A hosted teacher demonstrates a choice through the normal tool loop; it does not fabricate scoring receipts.
      const driver = (request, signal) => backend(request, signal);
      return {
        identity: natlang.executorIdentityForChoice(choice),
        driver,
        judge: driver,
        close: async () => {
          for (const owned of sessions.splice(0)) await owned.close();
        },
      };
    };
    return await runNatlangEval(
      { template: options.template, suite: options.suite, natlangCommit: options.natlangCommit },
      context,
      {
        ...dependencies,
        openModels,
        evaluateSuite: async ({ natlang, prepared, models, signal, commit, suiteRelative }) => {
          assertSourceSnapshot();
          const suite = { id: prepared.suite.id, hash: prepared.suiteHash };
          const source = {
            template: options.template,
            template_commit: templateCommit,
            base_commit: baseCommit,
            program_sha256: prepared.program.buildHash,
            natlang_commit: commit,
            vibestudio_commit: hostCommit,
            dirty: false,
          };
          const teacher = {
            provider: options.provider,
            model_id: options.model,
            identity: models.identity,
          };
          const cases = prepared.cases.map((testCase) =>
            sourceCase(options.template, suite, testCase, templateCommit)
          );
          const binding = {
            schema: "vibestudio.teacher-collection/1",
            suite: { ...suite, path: suiteRelative },
            source,
            teacher,
            replicate: options.replicate,
            cases,
          };
          const manifestPath = path.join(directory, "manifest.json");
          if (fs.existsSync(manifestPath)) {
            const prior = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            if (sha256(prior.binding) !== sha256(binding))
              throw new Error(
                "collection source, teacher, split inventory or replicate changed; use a new --out"
              );
          }
          if (options.preflight) {
            const result = await natlang.preflightEvaluation(prepared);
            console.log(JSON.stringify({ event: "preflight", suite: suite.id, ...result }));
            return { exitCode: 0 };
          }
          const selected = prepared.cases
            .filter(
              (testCase) =>
                testCase.split === "train" && (!options.case || testCase.id === options.case)
            )
            .slice(0, options.limit || undefined);
          if (!selected.length)
            throw new Error("no selected training cases; validation and test cases are protected");
          const persist = () => {
            assertSourceSnapshot();
            const episodes = fs
              .readdirSync(path.join(directory, "episodes"))
              .filter((name) => name.endsWith(".json"))
              .sort()
              .map((name) =>
                validateEpisode(
                  JSON.parse(fs.readFileSync(path.join(directory, "episodes", name), "utf8")),
                  binding,
                  name
                )
              );
            const content =
              episodes.map((episode) => JSON.stringify(episode)).join("\n") +
              (episodes.length ? "\n" : "");
            fs.writeFileSync(path.join(directory, "episodes.jsonl.tmp"), content, { mode: 0o600 });
            fs.renameSync(
              path.join(directory, "episodes.jsonl.tmp"),
              path.join(directory, "episodes.jsonl")
            );
            writeJSON(manifestPath, {
              ...binding,
              binding,
              episodes: { path: "episodes.jsonl", sha256: sha256(content) },
            });
          };
          persist();
          for (const testCase of selected) {
            signal.throwIfAborted();
            const id = sha256({ binding, case: testCase.id });
            const file = path.join(directory, "episodes", `${id}.json`);
            if (fs.existsSync(file)) continue;
            console.error(`teacher ${suite.id}/${testCase.id}`);
            const attempts = path.join(directory, "attempts");
            fs.mkdirSync(attempts, { recursive: true, mode: 0o700 });
            const attempt = fs.mkdtempSync(path.join(attempts, `${id}-`));
            const journal = path.join(attempt, "model-events.jsonl");
            const judgeTurns = [];
            let requests = 0;
            const audited = (role, driver) => async (request, callSignal) => {
              const sequence = ++requests;
              const emit = (event) =>
                fs.appendFileSync(journal, `${JSON.stringify({ role, sequence, ...event })}\n`, {
                  mode: 0o600,
                });
              emit({ phase: "request", request });
              try {
                const reply = await driver(request, callSignal);
                emit({ phase: "reply", reply });
                if (role === "fixture-judge")
                  judgeTurns.push({
                    request: structuredClone(request),
                    reply: structuredClone(reply),
                  });
                return reply;
              } catch (error) {
                emit({ phase: "error", error: error.stack ?? String(error) });
                throw error;
              }
            };
            writeJSON(path.join(attempt, "source.json"), { binding, case: testCase.id });
            const evaluate = (driver, judge = models.judge) =>
              natlang.evaluate(prepared, {
                caseIds: [testCase.id],
                driver,
                judge,
                executorIdentity: models.identity,
                capture: true,
                replicate: options.replicate,
                seed: 20261117,
                signal,
                timeoutMs: 2 ** 31 - 1,
              });
            const batch = await evaluate(
                audited("executor", models.driver),
                audited("fixture-judge", models.judge)
              ),
              result = batch.results[0];
            writeJSON(path.join(attempt, "evaluation.json"), result);
            let reason = eligibility(result),
              replay = { verified: false, request_hashes: [] },
              verification = null;
            if (!reason) {
              const recorded = replayDriver(result.modelTurns);
              const recordedJudge = replayDriver(judgeTurns);
              const repeated = (await evaluate(recorded.driver, recordedJudge.driver)).results[0];
              recorded.finish();
              recordedJudge.finish();
              if (
                eligibility(repeated) ||
                canonical(repeated.outcome) !== canonical(result.outcome) ||
                canonical(repeated.gates) !== canonical(result.gates) ||
                repeated.quality !== result.quality
              ) {
                throw new Error(`teacher replay changed the verified result of ${testCase.id}`);
              }
              replay = {
                verified: true,
                request_hashes: result.modelTurns.map((turn) => requestHash(turn.request)),
                judge_request_hashes: judgeTurns.map((turn) => requestHash(turn.request)),
              };
              verification = {
                ...(await verifySemantics(
                  audited("semantic-review", models.judge),
                  testCase,
                  result,
                  signal
                )),
                method: "independent-model-review",
                teacher,
              };
              if (verification.verdict !== "accepted") reason = `semantic-${verification.verdict}`;
            }
            const inventory = sourceCase(options.template, suite, testCase, templateCommit);
            const episode = {
              schema: "vibestudio.teacher-episode/1",
              id,
              suite,
              source,
              teacher,
              case: {
                id: testCase.id,
                group: testCase.group,
                split: testCase.split,
                input_sha256: sha256(testCase.input),
              },
              source_ids: inventory.source_ids,
              source_groups: inventory.source_groups,
              source_revisions: inventory.source_revisions,
              outcome: {
                ...result.outcome,
                quality: result.quality,
                gates: { ...result.gates, semantic: verification?.verdict === "accepted" },
                tool_error_count: toolErrorCount(result),
              },
              replay,
              verification,
              rejection: reason,
              turns: (result.modelTurns ?? []).map(trainingTurn),
              evaluation: result,
            };
            writeJSON(file, episode);
            persist();
            fs.rmSync(attempt, { recursive: true, force: true });
            console.log(
              JSON.stringify({
                event: "collected",
                suite: suite.id,
                case: testCase.id,
                admitted: !reason,
                reason,
                turns: episode.turns.length,
              })
            );
          }
          return { exitCode: 0, resultPath: manifestPath };
        },
      }
    );
  } finally {
    try {
      for (const session of sessions.splice(0)) await session.close();
    } finally {
      releaseLock();
    }
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
  await ownedEntry(
    async (context) => {
      for (const selection of selections) {
        const out = options.all
          ? path.join(
              options.out,
              selection.template,
              path.dirname(selection.path).replaceAll("/", "_")
            )
          : options.out;
        const result = await collectSuite(
          { ...options, template: selection.template, suite: selection.path, out },
          context
        );
        if (result?.exitCode) throw new Error(`teacher suite failed: ${selection.path}`);
      }
    },
    { appRoot: root, scratchPrefix: "natlang-teacher-" }
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
