import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("selected cases share one managed instance and keep earlier success when a later case fails", async (t) => {
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
    export const liveTeacherCases = new Map(['passing', 'failing'].map(caseId =>
      [caseId, { family: 'fixture', group: 'group', validator: 'oracle.ts' }]
    ));
    export async function exportLiveTeacherWorkflow({ out, pins, trajectory }) {
      const source = JSON.parse(await readFile(pins, 'utf8'));
      const run = JSON.parse(await readFile(trajectory, 'utf8'));
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
    const [launcher, , instance, command, ...args] = process.argv.slice(2);
    if (launcher === 'natlang:vendor') process.exit(0);
    fs.appendFileSync('commands.jsonl', JSON.stringify({ instance, command, args }) + '\\n');
    const out = args[args.indexOf('--out-dir') + 1];
    if (command === 'run') {
      fs.mkdirSync(path.join(out, '${runId}'));
      if (args[0] === 'failing') process.exit(1);
    }
    if (command === 'trajectory')
      fs.writeFileSync(
        path.join(out, '${runId}', 'trajectory-' + args[1] + '-full.json.gz'),
        JSON.stringify({ scenario: args[1] })
      );`,
    0o700
  );
  const out = path.join(root, "capture");
  const result = spawnSync(
    process.execPath,
    [
      "scripts/collect-live-workflow-teacher.mjs",
      "--case",
      "passing",
      "--case",
      "failing",
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
  const commands = (await readFile(path.join(root, "commands.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    commands.map(({ command }) => command),
    ["doctor", "run", "trajectory", "run", "stop"]
  );
  assert.equal(new Set(commands.map(({ instance }) => instance)).size, 1);
  const pathFor = (kind, name) => path.join(out, "cases", kind, name);
  const admitted = JSON.parse(await readFile(pathFor("passing", "verified/manifest.json"), "utf8"));
  assert.equal(admitted.source.run_id, runId);
  assert.equal(admitted.run.scenario, "passing");
  assert.equal(JSON.parse(await readFile(pathFor("failing", "source.json"), "utf8")).run_id, runId);
  await assert.rejects(readFile(pathFor("failing", "verified/manifest.json")), { code: "ENOENT" });
});
