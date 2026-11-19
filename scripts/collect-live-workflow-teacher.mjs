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
import {
  exportLiveTeacherWorkflow,
  loadLiveTeacherCases,
  workflowSourceGroups,
} from "./export-live-workflow-teacher.mjs";
import { workflowReviewer } from "./review-live-workflow-teacher.mjs";

const args = process.argv.slice(2);
const { values } = parseArgs({
  args: args[0] === "--" ? args.slice(1) : args,
  options: {
    case: { type: "string", multiple: true },
    list: { type: "boolean" },
    "review-model": { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: "openai-codex:gpt-6-luna" },
  },
});
const list = values.list && values.case === undefined && values.out === undefined;
const scenarios = values.case ?? [];
if (
  !list &&
  (values.list || !values.out || !scenarios.length || new Set(scenarios).size !== scenarios.length)
) {
  throw new Error(
    "Usage: pnpm natlang:teacher --list | --case WORKFLOW_CASE [--case WORKFLOW_CASE ...] --out NEW_DIR [--model PROVIDER:MODEL]"
  );
}

const host = fileURLToPath(new URL("../", import.meta.url));
const { checkouts } = requireDevelopmentTemplateCheckouts(host);
const liveTeacherCases = await loadLiveTeacherCases(checkouts);
if (list) {
  for (const [scenario, workflow] of liveTeacherCases)
    console.log(
      JSON.stringify({
        scenario,
        family: workflow.family,
        sourceGroup: workflow.group,
        workspace: workflow.workspace ?? "system",
        sourceGroups: workflowSourceGroups(workflow),
        requiresReview: Boolean(workflow.requiresReview),
        ...(workflow.devices ? { devices: workflow.devices } : {}),
      })
    );
  process.exit(0);
}
const unknown = scenarios.filter((scenario) => !liveTeacherCases.has(scenario));
if (unknown.length) {
  throw new Error(
    `Unknown teacher case(s): ${unknown.join(", ")}. Run pnpm natlang:teacher --list.`
  );
}

const review = workflowReviewer(values["review-model"]);
if (
  scenarios.some((scenario) => liveTeacherCases.get(scenario).requiresReview) &&
  (!review || values["review-model"] === values.model)
) {
  throw new Error("Choose --review-model PROVIDER:MODEL distinct from the content teacher");
}

const validators = new Map(
  scenarios.map((scenario) => {
    const { template, path: validator } = liveTeacherCases.get(scenario).validator;
    return [scenario, path.join(checkouts[template], validator)];
  })
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
const source = { repositories: pinned.repositories, teacher: values.model };
const writePins = (destination, value) =>
  writeFileSync(destination, JSON.stringify(value, null, 2), { mode: 0o600 });

const single = scenarios.length === 1;
const casesDir = path.join(out, "cases");
const groups = new Map();
for (const scenario of scenarios) {
  const workspace = liveTeacherCases.get(scenario).workspace ?? "system";
  if (!groups.has(workspace))
    groups.set(workspace, { instance: `natlang-live-${randomUUID().slice(0, 12)}`, cases: [] });
  groups.get(workspace).cases.push(scenario);
}
if (!single) {
  const instances = Object.fromEntries(
    [...groups].map(([workspace, group]) => [workspace, group.instance])
  );
  const legacy = groups.size === 1 ? { instance: groups.values().next().value.instance } : {};
  writePins(path.join(out, "source.json"), { ...source, ...legacy, instances, scenarios });
  mkdirSync(casesDir, { mode: 0o700 });
}
const failures = [];
for (const [workspace, group] of groups) {
  const { instance } = group;
  const systemTest = (args, stdout) =>
    command(["system-test", "--instance", instance, "--workspace", workspace, ...args], stdout);
  const cases = group.cases.map((scenario) => {
    const directory = single ? out : path.join(casesDir, scenario);
    if (!single) mkdirSync(directory, { mode: 0o700 });
    const pins = path.join(directory, "source.json");
    const caseSource = {
      ...source,
      instance,
      workspace,
      validator_sha256: pinned.validators[scenario],
    };
    writePins(pins, caseSource);
    return { scenario, directory, pins, caseSource };
  });
  let stopStatus;
  try {
    if (systemTest(["doctor", "--approve-startup", "--model", source.teacher]) !== 0) {
      throw new Error(`The managed ${workspace} workspace did not pass readiness checks`);
    }
    for (const { scenario, directory, pins, caseSource } of cases) {
      try {
        if (JSON.stringify(pinSources()) !== JSON.stringify(pinned))
          throw new Error("Source pins changed before starting the case");
        const devices = liveTeacherCases.get(scenario).devices ?? [];
        const status = systemTest([
          ...devices.flatMap((device) => ["--device", device]),
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
          review,
          cases: liveTeacherCases,
        });
        console.log(path.join(destination, "manifest.json"));
      } catch (error) {
        console.error(`Teacher case ${scenario} failed: ${String(error)}`);
        failures.push(error);
      }
    }
  } catch (error) {
    console.error(`Teacher workspace ${workspace} failed: ${String(error)}`);
    failures.push(error);
  } finally {
    stopStatus = systemTest(["stop"]);
  }
  if (stopStatus !== 0) {
    failures.push(new Error(`Could not retire the managed ${workspace} workspace ${instance}`));
    break;
  }
}
if (failures.length)
  throw new AggregateError(failures, `${failures.length} live teacher operation(s) failed`);
