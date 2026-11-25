#!/usr/bin/env node
import { runNativeReferenceTail } from "./lib/native-reference-tail.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
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

import { teacherEpisodeTimeout } from "./lib/live-teacher-budget.mjs";

import { collectionInterruption, runTeacherCommand } from "./lib/live-teacher-interruption.mjs";

import { liveTeacherEnvironment, moveRetainedState } from "./lib/live-teacher-retention.mjs";

const args = process.argv.slice(2);
const { values } = parseArgs({
  args: args[0] === "--" ? args.slice(1) : args,
  options: {
    case: { type: "string", multiple: true },
    list: { type: "boolean" },
    preflight: { type: "boolean" },
    "review-model": { type: "string" },
    "no-partial-salvage": { type: "boolean" },
    "native-reference-tail": { type: "string", default: "1" },
    "native-reference-state": { type: "string" },
    "test-timeout-ms": { type: "string" },
    concurrency: { type: "string", default: "1" },
    "cases-per-instance": { type: "string", default: "12" },
    "approve-codex-session": { type: "boolean" },
    out: { type: "string" },
    model: { type: "string", default: "openai-codex:gpt-6-luna" },
    "open-goals": { type: "boolean" },
    assignments: { type: "boolean" },
    "checkpoint-request": { type: "string" },
  },
});
const list =
  values.list && !values.preflight && values.case === undefined && values.out === undefined;
const preflight =
  values.preflight &&
  !values.list &&
  values.out === undefined &&
  values["review-model"] === undefined;
const batchSize = Number(values["cases-per-instance"]);
if (!/^\d+$/u.test(values["cases-per-instance"]) || !Number.isSafeInteger(batchSize))
  throw new Error("--cases-per-instance must be a nonnegative integer");
const concurrency = Number(values.concurrency);
if (!/^\d+$/u.test(values.concurrency) || !Number.isSafeInteger(concurrency) || concurrency < 1)
  throw new Error("--concurrency must be a positive integer");
const nativeReferenceLimit=Number(values["native-reference-tail"]);
if(!/^\d+$/u.test(values["native-reference-tail"])||!Number.isSafeInteger(nativeReferenceLimit))
  throw new Error("--native-reference-tail must be a nonnegative integer (0 disables)");
const caseTimeout = teacherEpisodeTimeout(values["test-timeout-ms"]);
if (
  values["approve-codex-session"] &&
  (list || preflight || values.assignments || !values.model.startsWith("openai-codex:"))
) {
  throw new Error(
    "--approve-codex-session requires a live open-goal capture with an openai-codex model"
  );
}
const requested = values.case ?? [];
if (
  (values.assignments && values["open-goals"]) ||
  new Set(requested).size !== requested.length ||
  (!list && !preflight && (values.list || values.preflight || !values.out || !requested.length))
) {
  throw new Error(
    "Usage: pnpm natlang:teacher --list | --preflight [--case CASE ...] | --case CASE [--case CASE ...] --out NEW_DIR [--model PROVIDER:MODEL] [--test-timeout-ms MS] [--cases-per-instance N] [--concurrency N] [--native-reference-tail N] [--native-reference-state DIR] [--approve-codex-session] [--assignments]"
  );
}

const host = fileURLToPath(new URL("../", import.meta.url));
const { checkouts } = requireDevelopmentTemplateCheckouts(host);
const liveTeacherCases = await loadLiveTeacherCases(checkouts);
// Reference coverage is independent of the selected teacher/assignment cohort.
const nativeReferenceWorkflows = new Map(liveTeacherCases);
for (const [scenario, workflow] of liveTeacherCases) {
  if ((workflow.interaction === "open-user-goal") === Boolean(values.assignments)) {
    liveTeacherCases.delete(scenario);
  } else if (
    workflow.interaction === "open-user-goal" &&
    !isSystemTestWorkspace(workflow.workspace ?? "system")
  ) {
    throw new Error(
      `Open goal ${scenario} requires an instantiable System Test workspace, received ${workflow.workspace}`
    );
  } else if (workflow.interaction === "open-user-goal" && !workflow.entry) {
    throw new Error(`Collection requires an application entry for ${scenario}`);
  }
}
if (!liveTeacherCases.size) {
  throw new Error(
    values.assignments
      ? "No assigned workflows are installed in these checkouts"
      : "No open user goals are installed in these checkouts"
  );
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
        ...(workflow.interaction
          ? {
              interaction: workflow.interaction,
              split: workflow.split,
              taskId: `${workflow.namespace}:${scenario}`,
              goalSha256: createHash("sha256")
                .update(JSON.stringify(workflow.assignment.goal))
                .digest("hex"),
              ...(workflow.entry ? { entry: workflow.entry } : {}),
            }
          : {}),
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

// These are the documented package commands, invoked directly so the parent
// owns the actual launcher rather than a package-manager signal intermediary.
function commandInvocation(args) {
  if (args[0] === "--silent") args = args.slice(1);
  const [name, ...rest] = args;
  if (name === "system-test")
    return [
      "--import",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      path.join(host, "src/dev/runSystemTest.ts"),
      ...rest,
    ];
  if (name === "natlang:vendor") return [path.join(host, "scripts/natlang-vendor.mjs"), ...rest];
  throw new Error(`Unsupported collection command: ${name}`);
}
async function captureCommand(args, stdout = "inherit", signal) {
  return runTeacherCommand(
    process.execPath,
    commandInvocation(args),
    {
      cwd: host,
      env: liveTeacherEnvironment(),
      stdio: ["inherit", stdout, "inherit"],
    },
    signal
  );
}
async function command(args, stdout = "inherit", signal) {
  return (await captureCommand(args, stdout, signal)).status;
}

function systemTestArgs({ instance, workspace, workspaceBaseline, devices }, args) {
  return [
    "system-test",
    "--instance",
    instance,
    "--workspace",
    workspace,
    ...(workspaceBaseline ? ["--workspace-baseline", workspaceBaseline] : []),
    ...devices.flatMap((device) => ["--device", device]),
    ...args,
  ];
}

async function installedTests(group, signal) {
  const { workspace } = group;
  const result = await captureCommand(
    ["--silent", ...systemTestArgs(group, ["list", "--json"])],
    "pipe",
    signal
  );
  if (result.status !== 0)
    throw new Error(`Could not list tests in managed workspace ${workspace}`);
  const tests = JSON.parse(result.stdout);
  const byName = new Map();
  if (!Array.isArray(tests)) throw new Error(`Invalid system-test catalog for ${workspace}`);
  for (const row of tests) {
    if (
      typeof row?.name !== "string" ||
      byName.has(row.name) ||
      typeof row.installed !== "boolean" ||
      typeof row.orchestrated !== "boolean" ||
      !Array.isArray(row.requiresUnits)
    ) {
      throw new Error(`Invalid system-test descriptor in ${workspace}`);
    }
    byName.set(row.name, row);
  }
  return byName;
}

const deploymentPackageProblem = (scenarios.some(
  (scenario) => liveTeacherCases.get(scenario).requiresDeploymentPackage
) || (nativeReferenceLimit > 0 && Boolean(process.env.VIBESTUDIO_MANAGED_DEPLOYMENT_PACKAGE?.trim())))
  ? await (async () => {
      const input = process.env.VIBESTUDIO_MANAGED_DEPLOYMENT_PACKAGE?.trim();
      if (!input) return "set VIBESTUDIO_MANAGED_DEPLOYMENT_PACKAGE to an installed server package";
      try {
        const { requireInstalledDeploymentPackage } =
          await import("./lib/owned-deployment-target.mjs");
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
      if (
        (await command(
          systemTestArgs(group, ["doctor", "--approve-startup", "--model", values.model]),
          "ignore"
        )) !== 0
      ) {
        throw new Error("Managed workspace did not pass readiness checks");
      }
      const catalog = await installedTests(group);
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
      stopStatus = await command(systemTestArgs(group, ["stop"]), "ignore");
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
  const digests = new Map();
  return {
    repositories,
    validators: Object.fromEntries(
      [...validators].map(([scenario, validator]) => {
        if (!digests.has(validator))
          digests.set(
            validator,
            createHash("sha256").update(readFileSync(validator)).digest("hex")
          );
        return [scenario, digests.get(validator)];
      })
    ),
  };
}

const pinned = pinSources();
if ((await command(["natlang:vendor", "--check"])) !== 0)
  throw new Error("Vendored Natlang pin check failed");
const out = path.resolve(values.out);
mkdirSync(out, { mode: 0o700 });
const source = {
  repositories: pinned.repositories,
  teacher: values.model,
  teacherTimeoutMs: Number(caseTimeout),
};
const writePins = (destination, value) =>
  writeFileSync(destination, JSON.stringify(value, null, 2), { mode: 0o600 });

const single = scenarios.length === 1;
const casesDir = path.join(out, "cases");
if (!single) {
  const instances = Object.fromEntries(groups.map(({ key, instance }) => [key, instance]));
  const legacy = groups.length === 1 ? { instance: groups[0].instance } : {};
  writePins(path.join(out, "source.json"), { ...source, ...legacy, instances, scenarios });
  mkdirSync(casesDir, { mode: 0o700 });
}
const interruption = collectionInterruption({
  requestPath: values["checkpoint-request"]
    ? path.resolve(values["checkpoint-request"])
    : undefined,
  out,
  cases: scenarios,
});
const admittedReview = review ? Object.assign((input, teacher) => {
  interruption.signal.throwIfAborted();
  return review(input, teacher, interruption.signal);
}, { model: review.model }) : undefined;
try {
  const failures = [];
  const unavailableScopes = new Set();
  for (const group of groups) {
    const { instance, workspace, workspaceBaseline, devices } = group;
    if (interruption.signal.aborted) break;
    if (unavailableScopes.has(group.scope)) continue;
    const systemTest = (args, stdout, signal) =>
      command(systemTestArgs(group, args), stdout, signal);
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
      const doctor = await captureCommand(
        systemTestArgs(group, ["doctor", "--approve-startup", "--model", source.teacher]),
        "pipe",
        interruption.signal
      );
      process.stdout.write(doctor.stdout);
      interruption.signal.throwIfAborted();
      if (doctor.status !== 0) {
        if (terminalStartupFailure(doctor.stdout)) unavailableScopes.add(group.scope);
        throw new Error(`The managed ${workspace} workspace did not pass readiness checks`);
      }
      const catalog = await installedTests(group, interruption.signal);
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
        if (interruption.signal.aborted) break;
        const batch = ready.slice(offset, offset + runSize);
        const concurrent = batch.length > 1;
        const runOut = concurrent ? mkdtempSync(path.join(out, "managed-")) : batch[0].directory;
        if (JSON.stringify(pinSources()) !== JSON.stringify(pinned))
          throw new Error("Source pins changed before starting the batch");
        await systemTest(
          [
            "run",
            ...batch.map(({ scenario }) => scenario),
            "--model",
            source.teacher,
            ...(concurrent
              ? [
                  "--concurrency",
                  String(Math.min(concurrency, batch.length)),
                  "--retain-trajectories",
                ]
              : []),
            "--test-timeout-ms",
            caseTimeout,
            ...(values["approve-codex-session"] ? ["--approve-codex-session"] : []),
            "--out-dir",
            runOut,
          ],
          undefined,
          interruption.signal
        );
        const runs = readdirSync(runOut).filter((entry) => /^st_[a-f0-9]{32}$/u.test(entry));
        if (runs.length !== 1) {
          if (interruption.signal.aborted && runs.length === 0) break;
          throw new Error("Expected one managed system-test run");
        }
        const [runId] = runs;
        const summaryPath = path.join(runOut, runId, "summary.json");
        const summary = existsSync(summaryPath)
          ? JSON.parse(readFileSync(summaryPath, "utf8"))
          : {};
        const interruptedStatusPath = path.join(
          runOut,
          runId,
          "failure-evidence",
          "interrupted-status.json"
        );
        const interruptedStatus = existsSync(interruptedStatusPath)
          ? readJson(interruptedStatusPath)
          : null;
        const terminalCases = new Set(
          interruptedStatus?.progress?.completed?.map((row) => row.name) ?? []
        );
        if (summary.status === "completed")
          for (const row of batch) terminalCases.add(row.scenario);
        interruption.complete([...terminalCases]);
        for (const { scenario, directory, pins, caseSource } of batch) {
          try {
            writePins(pins, { ...caseSource, run_id: runId });
            const filename = `trajectory-${scenario}-full.json.gz`;
            const target = path.join(directory, runId, filename);
            const retained = [
              path.join(runOut, runId, filename),
              path.join(runOut, runId, "failure-evidence", filename),
            ].find((candidate) => existsSync(candidate));
            if (retained) {
              if (retained !== target) {
                mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
                copyFileSync(retained, target);
              }
            } else if (
              (await systemTest(
                ["trajectory", runId, scenario, "--full", "--json", "--out-dir", directory],
                "ignore"
              )) !== 0
            ) {
              throw new Error(`Unable to retrieve the durable trajectory for ${runId}`);
            }
            // A durable raw packet is the authority even when the outer run is
            // cancelled and its terminal wrapper has no progress/completed list.
            // The exporter verifies exact source, roots, native outcome and any
            // partial scope; neither aggregate shape nor elapsed time grants it.
            if (JSON.stringify(pinSources()) !== JSON.stringify(pinned))
              throw new Error("Source pins changed during the live run");
            const destination = path.join(directory, "verified");
            await exportLiveTeacherWorkflow({
              salvageFailedInvocations: !values["no-partial-salvage"] && process.env.VIBESTUDIO_NATIVE_PARTIAL_SALVAGE !== "0",
              trajectory: target,
              pins,
              validator: validators.get(scenario),
              out: destination,
              split: liveTeacherCases.get(scenario).split ?? "train",
              review: admittedReview,
              cases: liveTeacherCases,
            });
            interruption.complete([scenario]);
            console.log(path.join(destination, "manifest.json"));
          } catch (error) {
            if (interruption.signal.aborted &&
                (error === interruption.signal.reason ||
                  error?.reviewCapture?.schema === "natlang.live-workflow-review-interrupted/1") &&
                liveTeacherCases.get(scenario).requiresReview) {
              interruption.defer(scenario, "pending-review");
              console.error(`Teacher case ${scenario} pending review after interruption; actual packet retained`);
              continue;
            }
            if (interruption.signal.aborted) {
              // Attempting every retained packet must not turn a graceful
              // checkpoint into an aggregate test failure. Keep its actual
              // exporter rejection visible and withhold admission for recovery.
              interruption.defer(scenario, "unverified-capture");
              writeFileSync(path.join(directory, "export-rejection.json"), JSON.stringify({
                scenario, runId, interrupted: true, error: String(error),
              }, null, 2) + "\n", {mode:0o600,flag:"wx"});
              console.error(`Teacher evidence ${scenario} unverified after interruption: ${String(error)}`);
              continue;
            }
            const label = "Teacher case";
            console.error(`${label} ${scenario} failed: ${String(error)}`);
            failures.push(error);
          }
        }
      }
      if (nativeReferenceLimit > 0 && !interruption.signal.aborted && [...nativeReferenceWorkflows].some(([name,world]) =>
        name.startsWith("open-goal-") && world.interaction === "open-user-goal" &&
        (world.workspace ?? "system") === workspace)) {
        try {
          if(JSON.stringify(pinSources())!==JSON.stringify(pinned))throw new Error("Source pins changed before native reference tail");
          const referenceCatalog=await installedTests(group,interruption.signal);
          const references=await runNativeReferenceTail({group,workflows:nativeReferenceWorkflows,catalog:referenceCatalog,pinned,out,
            stateRoot:path.resolve(values["native-reference-state"]??path.join(path.dirname(out),"native-reference-qualification")),
            limit:nativeReferenceLimit,systemTest,signal:interruption.signal,
            assertPins:()=>{if(JSON.stringify(pinSources())!==JSON.stringify(pinned))throw new Error("Source pins changed during native reference tail");},
            deploymentPackageAvailable:Boolean(process.env.VIBESTUDIO_MANAGED_DEPLOYMENT_PACKAGE?.trim()) && deploymentPackageProblem === null});
          console.log(JSON.stringify({nativeReferenceOnly:true,instance,references:references.length,passed:references.filter(row=>row.status==="passed").length}));
        } catch(error) {
          // Qualification failures retain their own evidence and never change
          // teacher admission or make a second paid attempt.
          console.error(`Native reference tail retained an incomplete attempt: ${String(error)}`);
        }
      }
    } catch (error) {
      if (error !== interruption.signal.reason) {
        console.error(`Teacher workspace ${workspace} failed: ${String(error)}`);
        failures.push(error);
      }
    } finally {
      stopStatus = await systemTest(["stop"]);
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
  if (interruption.signal.aborted) process.exitCode = 130;
} finally {
  interruption.dispose();
}
