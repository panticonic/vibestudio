#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  requireDevelopmentTemplateCheckouts,
  developmentTemplateHead,
} from "../src/dev/developmentTemplateConfig.cjs";
import { exportLiveTeacherWorkflow, liveTeacherCases } from "./export-live-workflow-teacher.mjs";

const args = process.argv.slice(2);
const { values } = parseArgs({
  args: args[0] === "--" ? args.slice(1) : args,
  options: {
    case: { type: "string", multiple: true },
    list: { type: "boolean" },
    out: { type: "string" },
    model: { type: "string", default: "openai-codex:gpt-6-luna" },
  },
});
if (values.list && values.case === undefined && values.out === undefined) {
  for (const [scenario, workflow] of liveTeacherCases)
    console.log(JSON.stringify({ scenario, family: workflow.family, sourceGroup: workflow.group }));
  process.exit(0);
}
const scenarios = values.case ?? [];
if (
  values.list ||
  !values.out ||
  !scenarios.length ||
  new Set(scenarios).size !== scenarios.length ||
  scenarios.some((scenario) => !liveTeacherCases.has(scenario))
) {
  throw new Error(
    "Usage: pnpm natlang:teacher --list | --case WORKFLOW_CASE [--case WORKFLOW_CASE ...] --out NEW_DIR [--model PROVIDER:MODEL]"
  );
}

const host = fileURLToPath(new URL("../", import.meta.url));
const { checkouts } = requireDevelopmentTemplateCheckouts(host);
const validators = new Map(
  scenarios.map((scenario) => [
    scenario,
    path.join(
      checkouts["system-testing"],
      "skills/system-testing",
      liveTeacherCases.get(scenario).validator
    ),
  ])
);
const runtimePin = path.join(checkouts.base, "packages/natlang/vendor/natlang-pin.json");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: host, encoding: "utf8" }).trim();

function pinSources() {
  const entries = Object.entries(checkouts).map(([name, dir]) => {
    const source = developmentTemplateHead(dir);
    return [name, { git_commit: source.commit, dirty: source.dirty }];
  });
  const runtime = readJson(runtimePin);
  const repositories = {
    vibestudio: {
      git_commit: git("rev-parse", "HEAD"),
      dirty: Boolean(git("status", "--porcelain", "-uno")),
    },
    natlang: { git_commit: runtime.commit, dirty: runtime.dirty },
    ...Object.fromEntries(entries),
  };
  for (const [name, revision] of Object.entries(repositories)) {
    if (revision.dirty !== false || !/^[a-f0-9]{40}$/u.test(revision.git_commit)) {
      throw new Error(`The live run requires a clean source pin for ${name}`);
    }
  }
  return {
    repositories,
    validators: Object.fromEntries(
      [...validators].map(([scenario, validator]) => [
        scenario,
        createHash("sha256").update(readFileSync(validator)).digest("hex"),
      ])
    ),
  };
}

function command(args, stdout = "inherit") {
  const result = spawnSync("pnpm", args, { cwd: host, stdio: ["inherit", stdout, "inherit"] });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const pinned = pinSources();
if (command(["natlang:vendor", "--check"]) !== 0)
  throw new Error("Vendored Natlang pin check failed");
const out = path.resolve(values.out);
mkdirSync(out, { mode: 0o700 });
const instance = `natlang-live-${randomUUID().slice(0, 12)}`;
const systemTest = (args, stdout) =>
  command(["system-test", "--instance", instance, ...args], stdout);
const source = { repositories: pinned.repositories, instance, teacher: values.model };
const writePins = (destination, value) =>
  writeFileSync(destination, JSON.stringify(value, null, 2), { mode: 0o600 });

const single = scenarios.length === 1;
const casesDir = path.join(out, "cases");
if (!single) {
  writePins(path.join(out, "source.json"), { ...source, scenarios });
  mkdirSync(casesDir, { mode: 0o700 });
}
const cases = scenarios.map((scenario) => {
  const directory = single ? out : path.join(casesDir, scenario);
  if (!single) mkdirSync(directory, { mode: 0o700 });
  const pins = path.join(directory, "source.json");
  const caseSource = { ...source, validator_sha256: pinned.validators[scenario] };
  writePins(pins, caseSource);
  return { scenario, directory, pins, caseSource };
});
try {
  if (systemTest(["doctor", "--approve-startup", "--model", source.teacher]) !== 0) {
    throw new Error("The managed Vibestudio instance did not pass readiness checks");
  }
  const failures = [];
  for (const { scenario, directory, pins, caseSource } of cases) {
    try {
      if (JSON.stringify(pinSources()) !== JSON.stringify(pinned))
        throw new Error("Source pins changed before starting the case");
      const status = systemTest([
        "run",
        scenario,
        "--model",
        source.teacher,
        "--out-dir",
        directory,
      ]);
      const runs = readdirSync(directory).filter((entry) => /^st_[a-f0-9]{32}$/u.test(entry));
      if (runs.length !== 1) throw new Error("Expected one managed system-test run");
      const [runId] = runs;
      writePins(pins, { ...caseSource, run_id: runId });
      if (status !== 0)
        throw new Error(`System test ${runId} failed. Its evidence is in ${directory}`);
      if (
        systemTest(
          ["trajectory", runId, scenario, "--full", "--json", "--out-dir", directory],
          "ignore"
        ) !== 0
      )
        throw new Error(`Unable to retrieve the durable trajectory for ${runId}`);
      if (JSON.stringify(pinSources()) !== JSON.stringify(pinned))
        throw new Error("Source pins changed during the live run");
      const destination = path.join(directory, "verified");
      await exportLiveTeacherWorkflow({
        trajectory: path.join(directory, runId, `trajectory-${scenario}-full.json.gz`),
        pins,
        validator: validators.get(scenario),
        out: destination,
        split: "train",
      });
      console.log(path.join(destination, "manifest.json"));
    } catch (error) {
      console.error(`Teacher case ${scenario} failed: ${String(error)}`);
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} live teacher case(s) failed`);
} finally {
  if (systemTest(["stop"]) !== 0) process.exitCode = 1;
}
