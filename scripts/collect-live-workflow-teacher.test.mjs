import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("a batch reuses each workspace instance and retains successes across failures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-teacher-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(relative, contents, mode) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, { mode });
  }
  await mkdir(path.join(root, "scripts"));
  await copyFile(
    new URL("collect-live-workflow-teacher.mjs", import.meta.url),
    path.join(root, "scripts/collect-live-workflow-teacher.mjs")
  );
  await copyFile(
    new URL("review-live-workflow-teacher.mjs", import.meta.url),
    path.join(root, "scripts/review-live-workflow-teacher.mjs")
  );
  await mkdir(path.join(root, "scripts/lib"));
  await copyFile(
    new URL("lib/live-teacher-groups.mjs", import.meta.url),
    path.join(root, "scripts/lib/live-teacher-groups.mjs")
  );
  await put("src/dev/cliWorkspaceSelection.js",
    'exports.isSystemTestWorkspace = value => ["system", "personal"].includes(value);');
  const sourceCommit = "a".repeat(40);
  const runId = "st_" + "1".repeat(32);
  await put(
    "src/dev/developmentTemplateConfig.cjs",
    `exports.requireDevelopmentTemplateCheckouts = host => ({
      checkouts: { base: host + '/templates/base', 'system-testing': host + '/templates/system-testing' }
    });
    exports.developmentTemplateHead = () => ({ commit: '${sourceCommit}', dirty: false });`
  );
  await put(
    "templates/base/packages/natlang/vendor/natlang-pin.json",
    JSON.stringify({ commit: sourceCommit, dirty: false })
  );
  await put(
    "templates/system-testing/skills/system-testing/oracle.ts",
    "actual runner oracle source"
  );
  await put(
    "scripts/export-live-workflow-teacher.mjs",
    `import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export const liveTeacherCases = new Map(['passing', 'failing', 'personal'].map(caseId =>
      [caseId, { family: 'fixture', group: 'group', workspace: caseId === 'personal' ? 'personal' : undefined, devices: caseId === 'personal' ? ['desktop'] : undefined, validator: {template:'system-testing',path:'skills/system-testing/oracle.ts'} }]
    ));
    liveTeacherCases.set('open-café', {
      family: 'open', group: 'open', interaction: 'open-user-goal', split: 'train',
      namespace: 'vibestudio:fixture', assignment: { goal: 'Send a café update.\\n"Use the new time."' },
    });
    export async function loadLiveTeacherCases() { return liveTeacherCases; }
    export function workflowSourceGroups(workflow) { return [workflow.group]; }
    export async function exportLiveTeacherWorkflow({ out, pins, trajectory }) {
      const source = JSON.parse(await readFile(pins, 'utf8'));
      const run = JSON.parse(await readFile(trajectory, 'utf8'));
      if (run.scenario === 'failing') throw new Error('Fixture outcome failed');
      await mkdir(out);
      await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ source, run }));
    }`
  );
  await put(
    "bin/git",
    `#!/bin/sh
if test "$1" = rev-parse; then printf '%s\\n' '${sourceCommit}'; fi
exit 0
`,
    0o700
  );
  await put(
    "bin/pnpm",
    `#!/usr/bin/env node
    const fs = require('node:fs');
    const path = require('node:path');
    const words = process.argv.slice(2);
    if (words[0] === '--silent') words.shift();
    const [launcher, , instance, , workspace, ...remaining] = words;
    const devices = [];
    while (remaining[0] === '--device') {
      remaining.shift();
      devices.push(remaining.shift());
    }
    const [command, ...args] = remaining;
    if (launcher === 'natlang:vendor') process.exit(0);
    fs.appendFileSync('commands.jsonl', JSON.stringify({ instance, workspace, devices, command, args }) + '\\n');
    if (command === 'list') {
      const names = workspace === 'personal' ? ['personal'] : ['passing', 'failing'];
      console.log(JSON.stringify(names.map(name => ({
        name, orchestrated: true, installed: name !== process.env.VIBE_TEST_ABSENT,
        requiresUnits: ['skills/fixture'],
      }))));
    }
    const out = args[args.indexOf('--out-dir') + 1];
    if (command === 'run') {
      fs.mkdirSync(path.join(out, '${runId}'));
      if (args.includes('--retain-trajectories')) {
        const run = path.join(out, '${runId}');
        const failure = path.join(run, 'failure-evidence');
        fs.mkdirSync(failure);
        for (const scenario of args.slice(0, args.indexOf('--model'))) {
          const directory = scenario === 'failing' ? failure : run;
          fs.writeFileSync(path.join(directory, 'trajectory-' + scenario + '-full.json.gz'), JSON.stringify({ scenario }));
        }
        if (args.includes('failing')) {
          fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({failedTests:['failing']}));
          process.exit(1);
        }
      }
      if (args[0] === 'failing') process.exit(1);
    }
    if (command === 'trajectory')
      fs.writeFileSync(
        path.join(out, '${runId}', 'trajectory-' + args[1] + '-full.json.gz'),
        JSON.stringify({ scenario: args[1] })
      );`,
    0o700
  );
  const list = (args) => spawnSync(process.execPath, ["scripts/collect-live-workflow-teacher.mjs", "--list", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  const defaultCatalog = list([]);
  assert.equal(defaultCatalog.status, 0, defaultCatalog.stderr);
  const open = JSON.parse(defaultCatalog.stdout);
  assert.equal(open.scenario, "open-café");
  assert.equal(open.goalSha256, createHash("sha256").update(JSON.stringify('Send a café update.\n"Use the new time."')).digest("hex"));
  const assignments = list(["--assignments"]);
  assert.equal(assignments.status, 0, assignments.stderr);
  assert.deepEqual(assignments.stdout.trim().split("\n").map((row) => JSON.parse(row).scenario),
    ["passing", "failing", "personal"]);

  const out = path.join(root, "capture");
  const result = spawnSync(
    process.execPath,
    [
      "scripts/collect-live-workflow-teacher.mjs",
      "--assignments",
      "--case",
      "passing",
      "--case",
      "failing",
      "--case",
      "personal",
      "--out",
      out,
    ],
    {
      cwd: root,
      env: { ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH },
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Teacher case failing failed/);
  assert.match(result.stderr, /Its full trajectory was retained/u);
  const commands = (await readFile(path.join(root, "commands.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    commands.map(({ command }) => command),
    ["doctor", "list", "run", "trajectory", "run", "trajectory", "stop", "doctor", "list", "run", "trajectory", "stop"]
  );
  assert.deepEqual(commands.map(({ workspace }) => workspace), [
    ...Array(7).fill("system"), ...Array(5).fill("personal"),
  ]);
  assert.equal(new Set(commands.slice(0, 7).map(({ instance }) => instance)).size, 1);
  assert.equal(new Set(commands.slice(7).map(({ instance }) => instance)).size, 1);
  assert.notEqual(commands[0].instance, commands[7].instance);
  assert.ok(commands.slice(0, 7).every(({ devices }) => !devices.length));
  assert.ok(commands.slice(7).every(({ devices }) => devices.length === 1 && devices[0] === "desktop"));

  const pathFor = (kind, name) => path.join(out, "cases", kind, name);
  const admitted = JSON.parse(await readFile(pathFor("passing", "verified/manifest.json"), "utf8"));
  assert.deepEqual(JSON.parse(await readFile(
    pathFor("failing", `${runId}/trajectory-failing-full.json.gz`), "utf8"
  )), { scenario: "failing" });
  assert.equal(admitted.source.run_id, runId);
  assert.equal(admitted.run.scenario, "passing");
  const personal = JSON.parse(
    await readFile(pathFor("personal", "verified/manifest.json"), "utf8")
  );
  assert.equal(personal.source.workspace, "personal");
  assert.deepEqual(personal.source.devices, ["desktop"]);
  assert.equal(personal.source.instance, commands.find(({ workspace }) => workspace === "personal").instance);
  assert.equal(JSON.parse(await readFile(pathFor("failing", "source.json"), "utf8")).run_id, runId);
  await assert.rejects(readFile(pathFor("failing", "verified/manifest.json")), { code: "ENOENT" });

  const parallelOut = path.join(root, "parallel");
  const parallel = spawnSync(process.execPath, ["scripts/collect-live-workflow-teacher.mjs",
    "--assignments", "--concurrency", "2", "--case", "passing", "--case", "failing", "--out", parallelOut], {
    cwd: root, env: { ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH }, encoding: "utf8",
  });
  assert.equal(parallel.status, 1);
  assert.match(parallel.stderr, /Teacher case failing failed.*full trajectory was retained/);
  const parallelCommands = (await readFile(path.join(root, "commands.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse).slice(commands.length);
  assert.deepEqual(parallelCommands.map(({ command }) => command), ["doctor", "list", "run", "stop"]);
  assert.deepEqual(parallelCommands[2].args.slice(0, 2), ["passing", "failing"]);
  assert.equal(parallelCommands[2].args[parallelCommands[2].args.indexOf("--concurrency") + 1], "2");
  const parallelPassed = JSON.parse(await readFile(path.join(parallelOut, "cases/passing/verified/manifest.json"), "utf8"));
  assert.equal(parallelPassed.source.run_id, runId);
  const parallelFailed = path.join(parallelOut, "cases/failing");
  assert.equal(JSON.parse(await readFile(path.join(parallelFailed, runId, "trajectory-failing-full.json.gz"), "utf8")).scenario, "failing");
  await assert.rejects(readFile(path.join(parallelFailed, "verified/manifest.json")), { code: "ENOENT" });

  const preflight = spawnSync(process.execPath, ["scripts/collect-live-workflow-teacher.mjs", "--preflight", "--assignments"], {
    cwd: root,
    env: {
      ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
      VIBE_TEST_ABSENT: "personal",
    },
    encoding: "utf8",
  });
  assert.equal(preflight.status, 1, preflight.stderr);
  assert.deepEqual(preflight.stdout.trim().split("\n").map(JSON.parse), [
    { workspace: "system", checked: 2, unavailable: [] },
    { workspace: "personal", devices: ["desktop"], checked: 1, unavailable: [
      { scenario: "personal", reason: "requires installed units: skills/fixture" },
    ] },
  ]);
  const preflightCommands = (await readFile(path.join(root, "commands.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse).slice(commands.length + parallelCommands.length);
  assert.deepEqual(preflightCommands.map(({ command }) => command), [
    "doctor", "list", "stop", "doctor", "list", "stop",
  ]);
  assert.ok(preflightCommands.slice(3).every(({ devices }) => devices[0] === "desktop"));
});
