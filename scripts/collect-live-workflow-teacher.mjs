#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { persistentInstanceRoot } from "../src/dev/instanceRegistry.js";
import { isSystemTestWorkspace } from "../src/dev/cliWorkspaceSelection.js";
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
import { groupLiveTeacherCases, terminalStartupFailure } from "./lib/live-teacher-groups.mjs";

import { liveTeacherEnvironment, moveRetainedState } from "./lib/live-teacher-retention.mjs";

const args = process.argv.slice(2);
const { values } = parseArgs({
  args: args[0] === "--" ? args.slice(1) : args,
  options: {
    case: { type: "string", multiple: true },
    list: { type: "boolean" },
    preflight: { type: "boolean" },
    "review-model": { type: "string" },
    "test-timeout-ms": { type: "string" },
    concurrency: { type: "string", default: "1" },
    "cases-per-instance": { type: "string", default: "12" },
    "approve-codex-session": { type: "boolean" },
    out: { type: "string" },
    model: { type: "string", default: "openai-codex:gpt-6-luna" },
    "open-goals": { type: "boolean" },
    assignments: { type: "boolean" },
  },
});
const list = values.list && !values.preflight && values.case === undefined && values.out === undefined;
const preflight = values.preflight && !values.list && values.out === undefined &&
  values["review-model"] === undefined;
const batchSize = Number(values["cases-per-instance"]);
if (!/^\d+$/u.test(values["cases-per-instance"]) || !Number.isSafeInteger(batchSize))
  throw new Error("--cases-per-instance must be a nonnegative integer");
const concurrency = Number(values.concurrency);
if (!/^\d+$/u.test(values.concurrency) || !Number.isSafeInteger(concurrency) || concurrency < 1)
  throw new Error("--concurrency must be a positive integer");
const caseTimeout = values["test-timeout-ms"];
if (caseTimeout !== undefined && (!/^\d+$/u.test(caseTimeout) || !Number.isSafeInteger(Number(caseTimeout)) || Number(caseTimeout) <= 0)) {
  throw new Error("--test-timeout-ms must be a positive integer");
}
if (values["approve-codex-session"] &&
    (list || preflight || values.assignments || !values.model.startsWith("openai-codex:"))) {
  throw new Error("--approve-codex-session requires a live open-goal capture with an openai-codex model");
}
const requested = values.case ?? [];
if (
  (values.assignments && values["open-goals"]) ||
  new Set(requested).size !== requested.length ||
  (!list && !preflight && (values.list || values.preflight || !values.out || !requested.length))
) {
  throw new Error(
    "Usage: pnpm natlang:teacher --list | --preflight [--case CASE ...] | --case CASE [--case CASE ...] --out NEW_DIR [--model PROVIDER:MODEL] [--test-timeout-ms MS] [--cases-per-instance N] [--concurrency N] [--approve-codex-session] [--assignments]"
  );
}

const host = fileURLToPath(new URL("../", import.meta.url));
const { checkouts } = requireDevelopmentTemplateCheckouts(host);
const liveTeacherCases = await loadLiveTeacherCases(checkouts);
for (const [scenario, workflow] of liveTeacherCases) {
  if ((workflow.interaction === "open-user-goal") === Boolean(values.assignments)) {
    liveTeacherCases.delete(scenario);
  } else if (workflow.interaction === "open-user-goal" && !isSystemTestWorkspace(workflow.workspace ?? "system")) {
    throw new Error(`Open goal ${scenario} requires an instantiable System Test workspace, received ${workflow.workspace}`);
  } else if (workflow.interaction === "open-user-goal" && !workflow.entry) {
    throw new Error(`Collection requires an application entry for ${scenario}`);
  }
}
if (!liveTeacherCases.size) {
  throw new Error(values.assignments
    ? "No assigned workflows are installed in these checkouts"
    : "No open user goals are installed in these checkouts");
}
if (list) {
  for (const [scenario, workflow] of liveTeacherCases)
    console.log(
      JSON.stringify({
        scenario,
        family: workflow.family,
        sourceGroup: workflow.group,
        workspace: workflow.workspace ?? "system",
        sourceGroups: workflowSourceGroups(workflow),
        ...(workflow.interaction ? {
          interaction: workflow.interaction,
          split: workflow.split,
          taskId: `${workflow.namespace}:${scenario}`,
          goalSha256: createHash("sha256").update(JSON.stringify(workflow.assignment.goal)).digest("hex"),
          ...(workflow.entry ? { entry: workflow.entry } : {}),
        } : {}),
        requiresReview: Boolean(workflow.requiresReview),
        ...(workflow.workspaceBaseline ? { workspaceBaseline: workflow.workspaceBaseline } : {}),
        ...(workflow.devices ? { devices: workflow.devices } : {}),
        ...(workflow.requiresAndroidEmulator ? { requiresAndroidEmulator: true } : {}),
        ...(workflow.requiresDeploymentPackage ? { requiresDeploymentPackage: true } : {}),
      })
    );
  process.exit(0);
}
const scenarios = preflight && !requested.length ? [...liveTeacherCases.keys()] : requested;
const unknown = scenarios.filter((scenario) => !liveTeacherCases.has(scenario));
if (unknown.length) {
  throw new Error(
    `Unknown teacher case(s): ${unknown.join(", ")}. Run pnpm natlang:teacher --list${values.assignments ? " --assignments" : ""}.`
  );
}

const groups = groupLiveTeacherCases(scenarios, liveTeacherCases, preflight ? 0 : batchSize);

function command(args, stdout = "inherit") {
  const result = spawnSync("pnpm", args, { cwd: host, env: liveTeacherEnvironment(), stdio: ["inherit", stdout, "inherit"] });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function systemTestArgs({ instance, workspace, workspaceBaseline, devices }, args) {
  return [
    "system-test", "--instance", instance, "--workspace", workspace,
    ...(workspaceBaseline ? ["--workspace-baseline", workspaceBaseline] : []),
    ...devices.flatMap((device) => ["--device", device]),
    ...args,
  ];
}

function installedTests(group) {
  const { workspace } = group;
  const result = spawnSync("pnpm", [
    "--silent", ...systemTestArgs(group, ["list", "--json"]),
  ], { cwd: host, env: liveTeacherEnvironment(), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not list tests in managed workspace ${workspace}`);
  const tests = JSON.parse(result.stdout);
  const byName = new Map();
  if (!Array.isArray(tests)) throw new Error(`Invalid system-test catalog for ${workspace}`);
  for (const row of tests) {
    if (typeof row?.name !== "string" || byName.has(row.name) ||
        typeof row.installed !== "boolean" || typeof row.orchestrated !== "boolean" ||
        !Array.isArray(row.requiresUnits)) {
      throw new Error(`Invalid system-test descriptor in ${workspace}`);
    }
    byName.set(row.name, row);
  }
  return byName;
}

const deploymentPackageProblem = scenarios.some((scenario) => liveTeacherCases.get(scenario).requiresDeploymentPackage)
  ? await (async () => {
      const input = process.env.VIBESTUDIO_MANAGED_DEPLOYMENT_PACKAGE?.trim();
      if (!input) return "set VIBESTUDIO_MANAGED_DEPLOYMENT_PACKAGE to an installed server package";
      try {
        const { requireInstalledDeploymentPackage } = await import("./lib/owned-deployment-target.mjs");
        await requireInstalledDeploymentPackage(path.resolve(host, input));
        return null;
      } catch (error) {
        return error.message;
      }
    })()
  : null;

function unavailableCase(catalog, scenario) {
  const test = catalog.get(scenario);
  if (!test) return "missing system-test descriptor";
  if (!test.orchestrated) return "no managed workflow orchestrator";
  if (!test.installed) return `requires installed units: ${test.requiresUnits.join(", ")}`;
  return liveTeacherCases.get(scenario).requiresDeploymentPackage ? deploymentPackageProblem : null;
}

if (preflight) {
  let unavailableCount = 0;
  for (const group of groups) {
    const { workspace, workspaceBaseline, devices, cases } = group;
    const placement = { workspace, workspaceBaseline, ...(devices.length ? { devices } : {}) };
    let stopStatus;
    try {
      if (command(systemTestArgs(group, ["doctor", "--approve-startup", "--model", values.model]), "ignore") !== 0) {
        throw new Error("Managed workspace did not pass readiness checks");
      }
      const catalog = installedTests(group);
      const unavailable = cases.flatMap((scenario) => {
        const reason = unavailableCase(catalog, scenario);
        return reason ? [{ scenario, reason }] : [];
      });
      unavailableCount += unavailable.length;
      console.log(JSON.stringify({ ...placement, checked: cases.length, unavailable }));
    } catch (error) {
      unavailableCount += cases.length;
      console.log(JSON.stringify({ ...placement, checked: 0, error: String(error) }));
    } finally {
      stopStatus = command(systemTestArgs(group, ["stop"]), "ignore");
    }
    if (stopStatus !== 0) {
      throw new Error(`Could not retire the managed ${workspace} workspace ${group.instance}`);
    }
  }
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(unavailableCount ? 1 : 0);
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
const git = (...args) => execFileSync("git", args, { cwd: host, env: liveTeacherEnvironment(), encoding: "utf8" }).trim();

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
  const digests = new Map();
  return {
    repositories,
    validators: Object.fromEntries(
      [...validators].map(([scenario, validator]) => {
        if (!digests.has(validator)) digests.set(validator, createHash("sha256").update(readFileSync(validator)).digest("hex"));
        return [scenario, digests.get(validator)];
      })
    ),
  };
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
if (!single) {
  const instances = Object.fromEntries(
    groups.map(({ key, instance }) => [key, instance])
  );
  const legacy = groups.length === 1 ? { instance: groups[0].instance } : {};
  writePins(path.join(out, "source.json"), { ...source, ...legacy, instances, scenarios });
  mkdirSync(casesDir, { mode: 0o700 });
}
const failures = [];
const unavailableScopes = new Set();
for (const group of groups) {
  const { instance, workspace, workspaceBaseline, devices } = group;
  if (unavailableScopes.has(group.scope)) continue;
  const systemTest = (args, stdout) =>
    command(systemTestArgs(group, args), stdout);
  const cases = group.cases.map((scenario) => {
    const directory = single ? out : path.join(casesDir, scenario);
    if (!single) mkdirSync(directory, { mode: 0o700 });
    const pins = path.join(directory, "source.json");
    const caseSource = {
      ...source,
      instance,
      workspace,
      ...(workspaceBaseline ? { workspace_baseline_commit: workspaceBaseline } : {}),
      ...(devices.length ? { devices } : {}),
      validator_sha256: pinned.validators[scenario],
    };
    writePins(pins, caseSource);
    return { scenario, directory, pins, caseSource };
  });
  let stopStatus;
  try {
    const doctor = spawnSync("pnpm", systemTestArgs(group, ["doctor", "--approve-startup", "--model", source.teacher]), {
      cwd: host, env: liveTeacherEnvironment(), encoding: "utf8", stdio: ["inherit", "pipe", "inherit"],
    });
    if (doctor.error) throw doctor.error;
    process.stdout.write(doctor.stdout);
    if (doctor.status !== 0) {
      if (terminalStartupFailure(doctor.stdout)) unavailableScopes.add(group.scope);
      throw new Error(`The managed ${workspace} workspace did not pass readiness checks`);
    }
    const catalog = installedTests(group);
    const ready = cases.filter(({ scenario }) => {
      const reason = unavailableCase(catalog, scenario);
      if (!reason) return true;
      const error = new Error(reason);
      console.error(`Teacher case ${scenario} failed: ${String(error)}`);
      failures.push(error);
      return false;
    });
    const runSize = concurrency === 1 ? 1 : ready.length;
    for (let offset = 0; offset < ready.length; offset += runSize) {
      const batch = ready.slice(offset, offset + runSize);
      const concurrent = batch.length > 1;
      const runOut = concurrent ? mkdtempSync(path.join(out, "managed-")) : batch[0].directory;
      if (JSON.stringify(pinSources()) !== JSON.stringify(pinned))
        throw new Error("Source pins changed before starting the batch");
      const status = systemTest([
        "run", ...batch.map(({ scenario }) => scenario),
        "--model", source.teacher,
        ...(concurrent ? ["--concurrency", String(Math.min(concurrency, batch.length)), "--retain-trajectories"] : []),
        ...(caseTimeout === undefined ? [] : ["--test-timeout-ms", caseTimeout]),
        ...(values["approve-codex-session"] ? ["--approve-codex-session"] : []),
        "--out-dir", runOut,
      ]);
      const runs = readdirSync(runOut).filter((entry) => /^st_[a-f0-9]{32}$/u.test(entry));
      if (runs.length !== 1) throw new Error("Expected one managed system-test run");
      const [runId] = runs;
      const summaryPath = path.join(runOut, runId, "summary.json");
      const summary = concurrent && existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : {};
      const failed = new Set([...(summary.failedTests ?? []), ...(summary.testsWithUnexpectedToolFailures ?? [])]);
      for (const { scenario, directory, pins, caseSource } of batch) {
        try {
          writePins(pins, { ...caseSource, run_id: runId });
          const filename = `trajectory-${scenario}-full.json.gz`;
          const target = path.join(directory, runId, filename);
          const retained = [path.join(runOut, runId, filename), path.join(runOut, runId, "failure-evidence", filename)]
            .find(candidate => existsSync(candidate));
          if (retained) {
            if (retained !== target) {
              mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
              copyFileSync(retained, target);
            }
          } else if (systemTest(["trajectory", runId, scenario, "--full", "--json", "--out-dir", directory], "ignore") !== 0) {
            throw new Error(`Unable to retrieve the durable trajectory for ${runId}`);
          }
          if (failed.has(scenario) || (status !== 0 && (!concurrent || !existsSync(summaryPath)))) {
            throw new Error(`System test ${runId} failed. Its full trajectory was retained in ${directory}`);
          }
          if (JSON.stringify(pinSources()) !== JSON.stringify(pinned))
            throw new Error("Source pins changed during the live run");
          const destination = path.join(directory, "verified");
          await exportLiveTeacherWorkflow({
            trajectory: target, pins, validator: validators.get(scenario), out: destination,
            split: liveTeacherCases.get(scenario).split ?? "train", review, cases: liveTeacherCases,
          });
          console.log(path.join(destination, "manifest.json"));
        } catch (error) {
          console.error(`Teacher case ${scenario} failed: ${String(error)}`);
          failures.push(error);
        }
      }
    }
  } catch (error) {
    console.error(`Teacher workspace ${workspace} failed: ${String(error)}`);
    failures.push(error);
  } finally {
    stopStatus = systemTest(["stop"]);
    // The supervisor has joined all state owners. Move its retained state into
    // this capture tree; the campaign archives the whole tree before cleanup.
    // A failed move leaves the original durable state intact for recovery.
    const retained = path.join(persistentInstanceRoot(host, instance), "retained");
    if (stopStatus === 0 && existsSync(retained)) {
      const destination = path.join(out, `retained-state-${instance}`);
      try {
        moveRetainedState({ retained, destination, instance, stopped: stopStatus === 0 });
      } catch (error) {
        failures.push(
          new Error(`Native state remains recoverable at ${retained}: ${String(error)}`)
        );
      }
    }
  }
  if (stopStatus !== 0) {
    failures.push(new Error(`Could not retire the managed ${workspace} workspace ${instance}`));
    break;
  }
}
if (failures.length)
  throw new AggregateError(failures, `${failures.length} live teacher operation(s) failed`);
