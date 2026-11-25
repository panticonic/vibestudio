import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { Ownership } from "@vibestudio/shared/ownership";
import { buildSelfContainedExtensionHost } from "./build-server-npm-package.mjs";
import { computeHostBuildFingerprint } from "./host-build-fingerprint.mjs";
import { computeRootDependencyFingerprint } from "../src/server/buildV2/effectiveVersion.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function fixture(t, script) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "extension-publish-"));
  const app = path.join(directory, "host"),
    packageRoot = path.join(app, "packages/extension-host");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(app, ".gitignore"), "packages/*/dist-publish/\n");
  fs.writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify({ private: true, dependencies: { "@vibestudio/extension-host": "workspace:*" } })
  );
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@vibestudio/extension-host",
      private: true,
      type: "module",
      main: "dist/index.js",
    })
  );
  fs.writeFileSync(path.join(packageRoot, "build.mjs"), script);
  fs.mkdirSync(path.join(app, "node_modules/@vibestudio"), { recursive: true });
  fs.symlinkSync(
    packageRoot,
    path.join(app, "node_modules/@vibestudio/extension-host"),
    "junction"
  );
  let owner;
  t.after(async () => {
    try {
      await owner?.release();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  owner = await Ownership.open({
    profileDir: path.join(directory, "profile"),
    parent: null,
    lifetime: "leased",
  });
  return { directory, app, packageRoot, owner, output: await owner.scratch("publish") };
}
const writeOutput = `import fs from 'node:fs';import path from 'node:path';const out=process.env.VIBESTUDIO_EXTHOST_PUBLISH_DIR;fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'index.js'),'export const published=true;');`;
function observeFile(file) {
  let watcher;
  const promise = new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(file)) {
        watcher?.close();
        resolve();
      }
    };
    watcher = fs.watch(path.dirname(file), check);
    watcher.on("error", reject);
    check();
  });
  return { promise, close: () => watcher?.close() };
}

test("real owned publish child leaves the live editable dependency fingerprint unchanged", async (t) => {
  const f = await fixture(t, writeOutput),
    before = computeHostBuildFingerprint({ cwd: f.app, mode: "development" });
  const dependencyBefore = (await computeRootDependencyFingerprint(f.app)).value;
  await buildSelfContainedExtensionHost({
    ownership: f.owner,
    signal: new AbortController().signal,
    output: f.output,
    packageRoot: f.packageRoot,
  });
  assert.equal(
    fs.readFileSync(path.join(f.output, "index.js"), "utf8"),
    "export const published=true;"
  );
  assert.deepEqual(computeHostBuildFingerprint({ cwd: f.app, mode: "development" }), before);
  assert.equal((await computeRootDependencyFingerprint(f.app)).value, dependencyBefore);
  assert.equal(fs.existsSync(path.join(f.packageRoot, "dist-publish")), false);
  await f.owner.release();
  assert.equal(fs.existsSync(f.output), false);
});

test("publication failure retains its cause and retires partial owned output", async (t) => {
  const f = await fixture(t, writeOutput + "process.exitCode=17;");
  await assert.rejects(
    buildSelfContainedExtensionHost({
      ownership: f.owner,
      signal: new AbortController().signal,
      output: f.output,
      packageRoot: f.packageRoot,
    }),
    /failed \(17\)/
  );
  await f.owner.release();
  assert.equal(fs.existsSync(f.output), false);
});

test("cancellation joins an active publish child before scratch retirement", async (t) => {
  const f = await fixture(
    t,
    writeOutput +
      `fs.writeFileSync(path.join(out,'ready'),String(process.pid));setInterval(()=>fs.appendFileSync(path.join(out,'index.js'),'x'),20);`
  );
  const controller = new AbortController(),
    reason = new Error("cancel actual publish");
  const ready = observeFile(path.join(f.output, "ready"));
  t.after(ready.close);
  const building = buildSelfContainedExtensionHost({
    ownership: f.owner,
    signal: controller.signal,
    output: f.output,
    packageRoot: f.packageRoot,
  });
  const rejection = assert.rejects(building, (error) => error === reason);
  await ready.promise;
  const pid = Number(fs.readFileSync(path.join(f.output, "ready"), "utf8"));
  controller.abort(reason);
  await rejection;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await f.owner.release();
  assert.equal(fs.existsSync(f.output), false);
});

test("the actual extension compiler emits its self-contained closure only in external owned output", async (t) => {
  const f = await fixture(t, writeOutput);
  await buildSelfContainedExtensionHost({
    ownership: f.owner,
    signal: new AbortController().signal,
    output: f.output,
    packageRoot: path.join(root, "packages/extension-host"),
  });
  for (const name of ["index.js", "childRuntime.js"])
    assert.ok(fs.statSync(path.join(f.output, name)).size > 1000);
  assert.equal(fs.existsSync(path.join(root, "packages/extension-host/dist-publish")), false);
  await f.owner.release();
  assert.equal(fs.existsSync(f.output), false);
});

test("SIGKILL of the publisher automatically joins its compiler before removing external output", async (t) => {
  const f = await fixture(
    t,
    writeOutput +
      `console.log(JSON.stringify({publishReady:true,pid:process.pid,out}));setInterval(()=>fs.appendFileSync(path.join(out,'index.js'),'x'),20);`
  );
  const script = path.join(f.directory, "publisher.mjs");
  fs.writeFileSync(
    script,
    `
 import path from 'node:path';
 import {ownedEntry} from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/owned-entry.mjs")).href)};
 import {buildSelfContainedExtensionHost} from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/build-server-npm-package.mjs")).href)};
 await ownedEntry(async({ownership,signal,scratchRoot})=>buildSelfContainedExtensionHost({ownership,signal,output:path.join(scratchRoot,'extension-host'),packageRoot:${JSON.stringify(f.packageRoot)}}),{appRoot:${JSON.stringify(root)},profileDir:${JSON.stringify(path.join(f.directory, "publisher-profile"))},scratchPrefix:'server-publish'});
 `
  );
  const producer = f.owner.spawn(process.execPath, ["--import", "tsx", script], {
    cwd: root,
    kill: "immediate",
    env: { ...process.env, VIBESTUDIO_OWNERSHIP_PARENT: JSON.stringify(f.owner.reference) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  producer.child.stderr.on("data", (b) => (errors += b));
  const ready = new Promise((resolve, reject) => {
    producer.child.stdout.on("data", (b) => {
      output += b;
      for (const line of output.split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.publishReady) resolve(value);
        } catch {
          // Compiler output also contains ordinary non-JSON build logs.
        }
      }
    });
    producer.child.once("exit", (code) => reject(new Error(`Publisher exited ${code}: ${errors}`)));
  });
  const state = await ready;
  const removed = new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(state.out), () => {
      if (!fs.existsSync(state.out)) {
        watcher.close();
        resolve();
      }
    });
    watcher.on("error", reject);
    t.after(() => watcher.close());
  });
  const exited = once(producer.child, "exit");
  producer.child.kill("SIGKILL");
  await exited;
  // Observers only: no release/retirement request may manufacture this proof.
  await removed;
  let running = false;
  try {
    running = fs.readFileSync(`/proc/${state.pid}/stat`, "utf8").split(" ")[2] !== "Z";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.equal(running, false);
  assert.equal(fs.existsSync(state.out), false);
  await producer.join();
});
