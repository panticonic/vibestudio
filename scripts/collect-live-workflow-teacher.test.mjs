import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test(
  "a batch reuses each workspace instance and retains successes across failures",
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "live-teacher-batch-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    async function put(relative, contents, mode) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents, { mode });
    }
    await mkdir(path.join(root, "scripts"));
    await symlink(
      new URL("../node_modules", import.meta.url).pathname,
      path.join(root, "node_modules")
    );
    await copyFile(
      new URL("collect-live-workflow-teacher.mjs", import.meta.url),
      path.join(root, "scripts/collect-live-workflow-teacher.mjs")
    );
    await copyFile(
      new URL("review-live-workflow-teacher.mjs", import.meta.url),
      path.join(root, "scripts/review-live-workflow-teacher.mjs")
    );
    await mkdir(path.join(root, "scripts/lib"));
    await copyFile(new URL("lib/native-reference-tail.mjs",import.meta.url),path.join(root,"scripts/lib/native-reference-tail.mjs"));
    await copyFile(
      new URL("lib/live-teacher-groups.mjs", import.meta.url),
      path.join(root, "scripts/lib/live-teacher-groups.mjs")
    );
    await copyFile(
      new URL("lib/live-teacher-budget.mjs", import.meta.url),
      path.join(root, "scripts/lib/live-teacher-budget.mjs")
    );
    await copyFile(
      new URL("lib/live-teacher-retention.mjs", import.meta.url),
      path.join(root, "scripts/lib/live-teacher-retention.mjs")
    );
    await copyFile(
      new URL("lib/live-teacher-interruption.mjs", import.meta.url),
      path.join(root, "scripts/lib/live-teacher-interruption.mjs")
    );
    await put("scripts/natlang-vendor.mjs", "process.exit(0);");
    await put(
      "src/dev/instanceRegistry.js",
      'exports.persistentInstanceRoot = (host, instance) => host + "/state/" + instance;'
    );
    await put(
      "src/dev/cliWorkspaceSelection.js",
      'exports.isSystemTestWorkspace = value => ["system", "personal"].includes(value);'
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
    export const liveTeacherCases = new Map(['passing', 'failing', 'personal'].map(caseId =>
      [caseId, { family: 'fixture', group: 'group', workspace: caseId === 'personal' ? 'personal' : undefined, devices: caseId === 'personal' ? ['desktop'] : undefined, requiresReview: caseId === 'passing' && Boolean(process.env.VIBE_TEST_REVIEW_REQUIRED), validator: {template:'system-testing',path:'skills/system-testing/oracle.ts'} }]
    ));
    liveTeacherCases.set('open-café', {
      family: 'open', group: 'open', interaction: 'open-user-goal', split: 'train',
      namespace: 'vibestudio:fixture', assignment: { goal: 'Send a café update.\\n"Use the new time."' },
      entry: { program: 'skills/mail/sendUpdate.nl', callable: 'sendUpdate',
        resultType: 'DeliveryReceipt', arguments: { goal: 'Send a café update.\\n"Use the new time."' } },
    });
    if(process.env.VIBE_TEST_NATIVE_REFERENCE)liveTeacherCases.set('open-goal-native-reference',{
      ...liveTeacherCases.get('passing'),interaction:'open-user-goal',assignment:{goal:'TEST-only check the native note'}
    });
    export async function loadLiveTeacherCases() { return liveTeacherCases; }
    export function workflowSourceGroups(workflow) { return [workflow.group]; }
    export async function exportLiveTeacherWorkflow({ out, pins, trajectory, review, salvageFailedInvocations }) {
      const source = JSON.parse(await readFile(pins, 'utf8'));
      const run = JSON.parse(await readFile(trajectory, 'utf8'));
      if (run.scenario === 'failing' && (!process.env.VIBE_TEST_CERTIFIED_PARTIAL || !salvageFailedInvocations)) throw new Error('Fixture outcome failed');
      if (process.env.VIBE_TEST_REVIEW_CAPTURE) throw Object.assign(new Error('Checkpoint during settled review exchange'), {
        reviewCapture: {schema:'natlang.live-workflow-review-interrupted/1',complete:false,exchanges:[{request:{actual:'request'},reply:{actual:'reply'}}]}
      });
      if (process.env.VIBE_TEST_REVIEW_REQUIRED) await review({kind:'actual-retained-fixture'},source.teacher);
      await mkdir(out);
      await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ source, run, ...(run.scenario === 'failing' ? {status:'partial',task_completed:false} : {}) }));
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
      "src/dev/runSystemTest.ts",
      `import fs from 'node:fs';
    import {gzipSync} from 'node:zlib';
    import path from 'node:path';
    const words = process.argv.slice(2);
    if (words[0] === '--silent') words.shift();
    const [, instance, , workspace, ...remaining] = words;
    const devices = [];
    while (remaining[0] === '--device') {
      remaining.shift();
      devices.push(remaining.shift());
    }
    const [command, ...args] = remaining;
    fs.appendFileSync('commands.jsonl', JSON.stringify({ instance, workspace, devices, command, args, nativeRetention: process.env.VIBESTUDIO_RETAIN_NATIVE_STORAGE }) + '\\n');
    const retainedState = path.join('state', instance, 'retained', 'generation-one');
    if (command === 'doctor') {
      fs.mkdirSync(retainedState, {recursive:true});
      fs.writeFileSync(path.join(retainedState, 'native-records.sqlite'), 'durable original bytes');
    }
    if (command === 'stop' && fs.existsSync(retainedState)) fs.writeFileSync(path.join(retainedState, 'stopped'), 'joined');
    if (command === 'list') {
      const names = workspace === 'personal' ? ['personal'] : ['passing', 'failing'];
      if(process.env.VIBE_TEST_NATIVE_REFERENCE && workspace==='system')names.push('open-goal-oracle-native-reference');
      console.log(JSON.stringify(names.map(name => ({
        name, ...(name==='open-goal-oracle-native-reference'?{nativeReference:true}:{}), orchestrated: true, installed: name !== process.env.VIBE_TEST_ABSENT,
        requiresUnits: ['skills/fixture'],
      }))));
    }
    const out = args[args.indexOf('--out-dir') + 1];
    if(command==='run'&&args[0]==='open-goal-oracle-native-reference') {
      if(args.includes('--model'))throw new Error('Reference received paid model flag');
      fs.mkdirSync(path.join(out,'${runId}'));process.exit(0);
    }
    if(command==='trajectory'&&args[1]==='open-goal-oracle-native-reference') {
      const packet={test:{name:args[1]},result:{passed:true},execution:{provenance:{contextId:'TEST-native-context'},trajectoryReview:{modelCallCount:0},diagnostics:{natlangTeacher:null,openGoalVerification:{caseId:'native-reference',contextId:'TEST-native-context',goal:'TEST-only check the native note',passed:true,checks:{actualNativeNote:true}}}}};
      fs.writeFileSync(path.join(out,'${runId}','trajectory-'+args[1]+'-full.json.gz'),gzipSync(JSON.stringify(packet)));process.exit(0);
    }
    if (command === 'run') {
      fs.mkdirSync(path.join(out, '${runId}'));
      if (process.env.VIBE_TEST_WAIT) {
        process.on('SIGTERM', () => {
          const evidence = path.join(out, '${runId}', 'failure-evidence');
          fs.mkdirSync(evidence, {recursive:true});
          fs.writeFileSync(path.join(evidence, 'interrupted-status.json'), JSON.stringify(process.env.VIBE_TEST_OUTER_DONE ? {status:'done',result:{success:true,returnValue:{status:'cancelled',total:2,passed:1,errored:1,failedTests:['failing']}}} : {progress:{completed:[{name:'passing',outcome:'passed'}]}}));
          fs.appendFileSync('commands.jsonl', JSON.stringify({command:'canonical-cancel-retained'}) + '\\n');
          process.exit(130);
        });
        setInterval(()=>{},1000);
        console.log('VIBE_TEST_RUNNING');
      }
      if (process.env.VIBE_TEST_INTERRUPT && !process.env.VIBE_TEST_COMPLETED) process.exit(1);
      if (args.includes('--retain-trajectories')) {
        const run = path.join(out, '${runId}');
        const failure = path.join(run, 'failure-evidence');
        fs.mkdirSync(failure);
        for (const scenario of args.slice(0, args.indexOf('--model'))) {
          const directory = scenario === 'failing' ? failure : run;
          fs.writeFileSync(path.join(directory, 'trajectory-' + scenario + '-full.json.gz'), JSON.stringify({ scenario }));
        }
        if (process.env.VIBE_TEST_COMPLETED) process.exit(1);
        if (!process.env.VIBE_TEST_WAIT && args.includes('failing')) {
          fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({failedTests:['failing']}));
          process.exit(1);
        }
      }
      if (!process.env.VIBE_TEST_WAIT && args[0] === 'failing') process.exit(1);
    }
    if (command === 'trajectory' && process.env.VIBE_TEST_INTERRUPT && !process.env.VIBE_TEST_COMPLETED) process.exit(1);
    if (command === 'trajectory')
      fs.writeFileSync(
        path.join(out, '${runId}', 'trajectory-' + args[1] + '-full.json.gz'),
        JSON.stringify({ scenario: args[1] })
      );`,
      0o700
    );
    const list = (args) =>
      spawnSync(
        process.execPath,
        ["scripts/collect-live-workflow-teacher.mjs", "--list", ...args],
        {
          cwd: root,
          encoding: "utf8",
        }
      );
    const defaultCatalog = list([]);
    assert.equal(defaultCatalog.status, 0, defaultCatalog.stderr);
    const open = JSON.parse(defaultCatalog.stdout);
    assert.equal(open.scenario, "open-café");
    assert.equal(
      open.goalSha256,
      createHash("sha256")
        .update(JSON.stringify('Send a café update.\n"Use the new time."'))
        .digest("hex")
    );
    const assignments = list(["--assignments"]);
    assert.equal(assignments.status, 0, assignments.stderr);
    assert.deepEqual(
      assignments.stdout
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row).scenario),
      ["passing", "failing", "personal"]
    );

    const out = path.join(root, "capture");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/collect-live-workflow-teacher.mjs",
        "--assignments",
        "--no-partial-salvage",
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
        env: { ...process.env, VIBE_TEST_CERTIFIED_PARTIAL:"1", PATH: path.join(root, "bin") + path.delimiter + process.env.PATH },
        encoding: "utf8",
      }
    );
    assert.equal(result.status, 1, result.stderr);
    const retainedDirectories = (await import("node:fs/promises")).readdir;
    assert.ok((await retainedDirectories(out)).some((name) => name.startsWith("retained-state-")));
    for (const name of (await retainedDirectories(out)).filter((name) =>
      name.startsWith("retained-state-")
    )) {
      assert.equal(
        await readFile(path.join(out, name, "generation-one", "native-records.sqlite"), "utf8"),
        "durable original bytes"
      );
      assert.equal(
        await readFile(path.join(out, name, "generation-one", "stopped"), "utf8"),
        "joined"
      );
    }
    assert.match(result.stderr, /Teacher case failing failed/);
    assert.match(result.stderr, /Fixture outcome failed/u);
    const commands = (await readFile(path.join(root, "commands.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(commands.every((command) => command.nativeRetention === "1"));
    assert.deepEqual(
      commands.map(({ command }) => command),
      [
        "doctor",
        "list",
        "run",
        "trajectory",
        "run",
        "trajectory",
        "stop",
        "doctor",
        "list",
        "run",
        "trajectory",
        "stop",
      ]
    );
    assert.deepEqual(
      commands.map(({ workspace }) => workspace),
      [...Array(7).fill("system"), ...Array(5).fill("personal")]
    );
    assert.equal(new Set(commands.slice(0, 7).map(({ instance }) => instance)).size, 1);
    assert.equal(new Set(commands.slice(7).map(({ instance }) => instance)).size, 1);
    assert.notEqual(commands[0].instance, commands[7].instance);
    assert.ok(commands.slice(0, 7).every(({ devices }) => !devices.length));
    assert.ok(
      commands.slice(7).every(({ devices }) => devices.length === 1 && devices[0] === "desktop")
    );

    const pathFor = (kind, name) => path.join(out, "cases", kind, name);
    const admitted = JSON.parse(
      await readFile(pathFor("passing", "verified/manifest.json"), "utf8")
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(pathFor("failing", `${runId}/trajectory-failing-full.json.gz`), "utf8")
      ),
      { scenario: "failing" }
    );
    assert.equal(admitted.source.run_id, runId);
    assert.equal(admitted.run.scenario, "passing");
    const personal = JSON.parse(
      await readFile(pathFor("personal", "verified/manifest.json"), "utf8")
    );
    assert.equal(personal.source.workspace, "personal");
    assert.deepEqual(personal.source.devices, ["desktop"]);
    assert.equal(
      personal.source.instance,
      commands.find(({ workspace }) => workspace === "personal").instance
    );
    assert.equal(
      JSON.parse(await readFile(pathFor("failing", "source.json"), "utf8")).run_id,
      runId
    );
    await assert.rejects(readFile(pathFor("failing", "verified/manifest.json")), {
      code: "ENOENT",
    });

    const parallelOut = path.join(root, "parallel");
    const parallel = spawnSync(
      process.execPath,
      [
        "scripts/collect-live-workflow-teacher.mjs",
        "--assignments",
        "--concurrency",
        "2",
        "--case",
        "passing",
        "--case",
        "failing",
        "--out",
        parallelOut,
      ],
      {
        cwd: root,
        env: { ...process.env, VIBE_TEST_CERTIFIED_PARTIAL:"1", PATH: path.join(root, "bin") + path.delimiter + process.env.PATH },
        encoding: "utf8",
      }
    );
    assert.equal(parallel.status, 0,parallel.stderr);
    const parallelCommands = (await readFile(path.join(root, "commands.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse)
      .slice(commands.length);
    assert.deepEqual(
      parallelCommands.map(({ command }) => command),
      ["doctor", "list", "run", "stop"]
    );
    assert.deepEqual(parallelCommands[2].args.slice(0, 2), ["passing", "failing"]);
    assert.equal(
      parallelCommands[2].args[parallelCommands[2].args.indexOf("--concurrency") + 1],
      "2"
    );
    const parallelPassed = JSON.parse(
      await readFile(path.join(parallelOut, "cases/passing/verified/manifest.json"), "utf8")
    );
    assert.equal(parallelPassed.source.run_id, runId);
    const parallelFailed = path.join(parallelOut, "cases/failing");
    assert.equal(
      JSON.parse(
        await readFile(path.join(parallelFailed, runId, "trajectory-failing-full.json.gz"), "utf8")
      ).scenario,
      "failing"
    );
    const partialManifest=JSON.parse(await readFile(path.join(parallelFailed,"verified/manifest.json"),"utf8"));
    assert.equal(partialManifest.status,"partial");assert.equal(partialManifest.task_completed,false);

    // A supervisor interruption after individual completion leaves no summary.
    // The real exporter remains the authority; the fixture rejects its bad case.
    const completedOut = path.join(root, "completed-before-interruption");
    const completed = spawnSync(
      process.execPath,
      [
        "scripts/collect-live-workflow-teacher.mjs",
        "--assignments",
        "--concurrency",
        "2",
        "--case",
        "passing",
        "--case",
        "failing",
        "--out",
        completedOut,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
          VIBE_TEST_INTERRUPT: "1",
          VIBE_TEST_COMPLETED: "1",
        },
        encoding: "utf8",
      }
    );
    assert.equal(completed.status, 1);
    assert.equal(
      JSON.parse(
        await readFile(path.join(completedOut, "cases/passing/verified/manifest.json"), "utf8")
      ).run.scenario,
      "passing"
    );
    assert.match(completed.stderr, /Fixture outcome failed/);
    await assert.rejects(
      readFile(path.join(completedOut, "cases/failing/verified/manifest.json")),
      { code: "ENOENT" }
    );

    for (const mode of ["signal", "checkpoint", "checkpoint-plus-term", "review-checkpoint", "review-in-flight"]) {
      const interruptedOut = path.join(root, `actual-interruption-${mode}`);
      const request = path.join(root, `checkpoint-${mode}.json`);
      const child = spawn(
        process.execPath,
        [
          "scripts/collect-live-workflow-teacher.mjs",
          "--assignments",
          "--concurrency",
          "2",
          "--case",
          "passing",
          "--case",
          "failing",
          "--case",
          "personal",
          "--out",
          interruptedOut,
          "--checkpoint-request",
          request,
          ...(mode.startsWith("review-") ? ["--review-model", "fixture:reviewer"] : []),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
            VIBE_TEST_WAIT: "1",
            ...(mode === "checkpoint" ? {VIBE_TEST_OUTER_DONE:"1"} : {}),
            ...(mode.startsWith("review-") ? {VIBE_TEST_REVIEW_REQUIRED:"1"} : {}),
            ...(mode === "review-in-flight" ? {VIBE_TEST_REVIEW_CAPTURE:"1"} : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const exited = once(child, "close");
      await new Promise((resolve, reject) => {
        child.once("close", () => reject(new Error(`Fixture exited before running: ${stderr}`)));
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("VIBE_TEST_RUNNING")) resolve();
        });
      });
      if (mode === "signal") child.kill("SIGTERM");
      else {
        await writeFile(request, JSON.stringify({ reason: "test wave checkpoint" }));
        if (mode === "checkpoint-plus-term") child.kill("SIGTERM");
      }
      assert.deepEqual(await exited, [130, null], stderr);
      const state = JSON.parse(
        await readFile(path.join(interruptedOut, "collection-interruption.json"), "utf8")
      );
      assert.deepEqual(state.completedCases, mode.startsWith("review-") ? [] : ["passing"]);
      assert.deepEqual(state.interruptedCases, mode.startsWith("review-") ? ["passing","failing","personal"] : ["failing", "personal"]);
      if (mode.startsWith("review-")) {
        assert.equal(state.interruptedReasons.passing,"pending-review");
        await assert.rejects(readFile(path.join(interruptedOut,"cases/passing/verified/manifest.json")),{code:"ENOENT"});
      } else
      assert.equal(
        JSON.parse(
          await readFile(path.join(interruptedOut, "cases/passing/verified/manifest.json"), "utf8")
        ).run.scenario,
        "passing"
      );
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(interruptedOut, "cases/failing", runId, "trajectory-failing-full.json.gz"),
            "utf8"
          )
        ).scenario,
        "failing"
      );
      await assert.rejects(readFile(path.join(interruptedOut, "cases/personal/source.json")), {
        code: "ENOENT",
      });
      assert.doesNotMatch(stderr, /Teacher case failing failed|Teacher workspace.*failed/);
      const tail = (await readFile(path.join(root, "commands.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse)
        .slice(-5);
      assert.deepEqual(
        tail.map((row) => row.command),
        ["doctor", "list", "run", "canonical-cancel-retained", "stop"]
      );
    }

    const nativeOut=path.join(root,'native-tail-capture');
    const nativeBefore=(await readFile(path.join(root,'commands.jsonl'),'utf8')).trim().split('\n').length;
    const native=spawnSync(process.execPath,['scripts/collect-live-workflow-teacher.mjs','--assignments','--case','passing','--out',nativeOut],{cwd:root,env:{...process.env,VIBE_TEST_NATIVE_REFERENCE:'1',PATH:path.join(root,'bin')+path.delimiter+process.env.PATH},encoding:'utf8'});
    assert.equal(native.status,0,native.stderr);
    const nativeCommands=(await readFile(path.join(root,'commands.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).slice(nativeBefore);
    assert.deepEqual(nativeCommands.map(row=>row.command),['doctor','list','run','trajectory','list','run','trajectory','stop']);
    assert.equal(new Set(nativeCommands.map(row=>row.instance)).size,1,'Native tail must reuse the exact owned instance');
    const reference=nativeCommands[5];assert.equal(reference.args[0],'open-goal-oracle-native-reference');assert.ok(!reference.args.includes('--model'));
    const referencesRoot=path.join(nativeOut,'native-reference-only');
    const referenceDirs=(await retainedDirectories(referencesRoot)).filter(name=>name!=="coverage.json");assert.equal(referenceDirs.length,1);
    const nativeProof=JSON.parse(await readFile(path.join(referencesRoot,referenceDirs[0],'reference-results.json'),'utf8'));
    assert.equal(nativeProof.results[0].status,'passed');assert.equal(nativeProof.teacherRegistryWrites,false);
    await assert.rejects(readFile(path.join(nativeOut,'cases/open-goal-native-reference/verified/manifest.json')),{code:'ENOENT'});

    const preflight = spawnSync(
      process.execPath,
      ["scripts/collect-live-workflow-teacher.mjs", "--preflight", "--assignments"],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
          VIBE_TEST_ABSENT: "personal",
        },
        encoding: "utf8",
      }
    );
    assert.equal(preflight.status, 1, preflight.stderr);
    assert.deepEqual(preflight.stdout.trim().split("\n").map(JSON.parse), [
      { workspace: "system", checked: 2, unavailable: [] },
      {
        workspace: "personal",
        devices: ["desktop"],
        checked: 1,
        unavailable: [{ scenario: "personal", reason: "requires installed units: skills/fixture" }],
      },
    ]);
    const preflightCommands = (await readFile(path.join(root, "commands.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse)
      .slice(-6);
    assert.deepEqual(
      preflightCommands.map(({ command }) => command),
      ["doctor", "list", "stop", "doctor", "list", "stop"]
    );
    assert.ok(preflightCommands.slice(3).every(({ devices }) => devices[0] === "desktop"));
    const interruptedOut = path.join(root, "interrupted-capture");
    const interrupted = spawnSync(
      process.execPath,
      [
        "scripts/collect-live-workflow-teacher.mjs",
        "--assignments",
        "--case",
        "passing",
        "--case",
        "failing",
        "--concurrency",
        "2",
        "--out",
        interruptedOut,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
          VIBE_TEST_INTERRUPT: "1",
        },
        encoding: "utf8",
      }
    );
    assert.equal(interrupted.status, 1, interrupted.stderr);
    assert.match(interrupted.stderr, /Teacher case passing failed/);
    assert.match(interrupted.stderr, /Teacher case failing failed/);
    const interruptedFiles = (await retainedDirectories(interruptedOut)).filter((name) =>
      name.startsWith("retained-state-")
    );
    assert.equal(interruptedFiles.length, 1);
    assert.equal(
      await readFile(
        path.join(interruptedOut, interruptedFiles[0], "generation-one", "native-records.sqlite"),
        "utf8"
      ),
      "durable original bytes"
    );
  }
);

test("joined collector move includes native pre-run and paid exchange custody", async (t) => {
  const { moveRetainedState, liveTeacherEnvironment } =
    await import("./lib/live-teacher-retention.mjs");
  assert.equal(liveTeacherEnvironment({}).VIBESTUDIO_RETAIN_NATIVE_STORAGE, "1");
  assert.equal(
    liveTeacherEnvironment({ VIBESTUDIO_RETAIN_NATIVE_STORAGE: "0" })
      .VIBESTUDIO_RETAIN_NATIVE_STORAGE,
    "0"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "native-custody-move-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = path.join(root, "supervisor/retained");
  const destination = path.join(root, "capture/retained-state-test");
  for (const [leaf, content] of [
    ["native-storage/retired/before-start.sqlite", "original pre-run bytes"],
    ["natlang/exchanges.json", "paid original replies"],
  ]) {
    const file = path.join(retained, "generation/capture-evidence/workspaces/owned", leaf);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  assert.throws(
    () => moveRetainedState({ retained, destination, instance: "test", stopped: false }),
    /joined/
  );
  moveRetainedState({ retained, destination, instance: "test", stopped: true });
  assert.equal(
    await readFile(
      path.join(
        destination,
        "generation/capture-evidence/workspaces/owned/native-storage/retired/before-start.sqlite"
      ),
      "utf8"
    ),
    "original pre-run bytes"
  );
  assert.equal(
    await readFile(
      path.join(destination, "generation/capture-evidence/workspaces/owned/natlang/exchanges.json"),
      "utf8"
    ),
    "paid original replies"
  );
  assert.equal(
    JSON.parse(await readFile(path.join(destination, "retention.json"), "utf8")).archived,
    false
  );
  const duplicate = path.join(root, "duplicate");
  await mkdir(path.join(duplicate, "generation"), { recursive: true });
  assert.throws(
    () => moveRetainedState({ retained: duplicate, destination, instance: "test", stopped: true }),
    /already exists/
  );
  assert.ok((await import("node:fs")).existsSync(path.join(duplicate, "generation")));
});
