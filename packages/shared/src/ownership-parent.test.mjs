import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Ownership, OWNERSHIP_PARENT_ENV } from "./ownership.mjs";
import { awaitRetirement, readLedger, requestOwnershipControl } from "./ownershipLedger.mjs";

const ownershipUrl = new URL("./ownership.mjs", import.meta.url).href;
async function observe(predicate, signal) {
  while (!predicate()) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const cleanups = new WeakMap();
function after(t, cleanup) {
  cleanups.get(t).push(cleanup);
}
function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ownership-parent-proof-"));
  cleanups.set(t, []);
  t.after(async () => {
    const errors = [];
    for (const close of cleanups.get(t).reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (!errors.length) fs.rmSync(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Ownership proof cleanup failed");
  });
  return root;
}

const resource = `import fs from 'node:fs';
  process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[1]+'/joined','joined');fs.writeFileSync(process.argv[2],'joined');process.exit(0)});
  process.send({ready:true});setInterval(()=>{},1000);`;
async function startResource(child, root, receipt) {
  const owned = child.spawn(
    process.execPath,
    ["--input-type=module", "-e", resource, root, receipt],
    { kill: "graceful", stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  const ready = new Promise((resolve, reject) => {
    owned.child.once("message", resolve);
    owned.child.once("error", reject);
    owned.child.once("exit", () => reject(new Error("Resource exited before readiness")));
  });
  await owned.registered;
  await ready;
  return owned;
}

test(
  "parent joins child resources before deleting their profile; unrelated custody survives",
  { timeout: 15000 },
  async (t) => {
    const directory = profile(t),
      parent = await Ownership.open({ profileDir: directory, lifetime: "leased", parent: null });
    after(t, () => parent.release());
    const root = await parent.scratch("run-");
    const child = await Ownership.open({
      profileDir: path.join(root, "profile"),
      lifetime: "leased",
      parent: parent.reference,
    });
    const sibling = await Ownership.open({
      profileDir: path.join(directory, "unrelated"),
      lifetime: "leased",
      parent: null,
    });
    after(t, () => sibling.release());
    const siblingBytes = await sibling.scratch("untouched-");
    const receipt = path.join(directory, "receipt");
    await startResource(child, root, receipt);
    await parent.release();
    assert.equal(fs.readFileSync(receipt, "utf8"), "joined");
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(siblingBytes), true);
    assert.equal(child.signal.aborted, true);
    await assert.rejects(child.scratch("late-"), /parent|release|reaper/);
  }
);

test(
  "inherited parent is exact and parent:null preserves an independent owner",
  { timeout: 15000 },
  async (t) => {
    const directory = profile(t),
      parent = await Ownership.open({ profileDir: directory, lifetime: "leased", parent: null });
    const previous = process.env[OWNERSHIP_PARENT_ENV];
    after(t, async () => {
      if (previous === undefined) delete process.env[OWNERSHIP_PARENT_ENV];
      else process.env[OWNERSHIP_PARENT_ENV] = previous;
      await parent.release();
    });
    process.env[OWNERSHIP_PARENT_ENV] = JSON.stringify(parent.reference);
    const child = await Ownership.open({
      profileDir: path.join(directory, "child"),
      lifetime: "leased",
    });
    const independent = await Ownership.open({
      profileDir: path.join(directory, "independent"),
      lifetime: "until-stop",
      parent: null,
    });
    after(t, () => independent.release());
    const childBytes = await child.scratch("child-"),
      kept = await independent.scratch("independent-");
    assert.deepEqual(readLedger(parent.ledgerDir, parent.id).children, [child.reference]);
    await parent.release();
    assert.equal(fs.existsSync(childBytes), false);
    assert.equal(fs.existsSync(kept), true);
  }
);

test("invalid parent tokens cannot attach or retire a sibling", { timeout: 15000 }, async (t) => {
  const directory = profile(t),
    parent = await Ownership.open({ profileDir: directory, lifetime: "leased", parent: null });
  after(t, () => parent.release());
  const bytes = await parent.scratch("kept-");
  const wrong = { ...parent.reference, token: "0".repeat(32) };
  await assert.rejects(requestOwnershipControl(wrong, { t: "release" }), /no longer active/);
  await assert.rejects(
    requestOwnershipControl(parent.reference, { t: "release", token: "wrong" }),
    /token does not match/
  );
  await assert.rejects(
    Ownership.open({
      profileDir: path.join(directory, "rejected"),
      lifetime: "leased",
      parent: wrong,
    }),
    /no longer active/
  );
  assert.equal(fs.existsSync(bytes), true);
  assert.equal(
    fs
      .readdirSync(path.join(directory, "rejected", "ownership"))
      .filter((file) => file.endsWith(".json")).length,
    0
  );
});

for (const killReaper of [false, true])
  test(
    `SIGKILL of coordinator${killReaper ? " and root reaper" : ""} still joins child before bytes`,
    { timeout: 15000 },
    async (t) => {
      const directory = profile(t),
        receipt = path.join(directory, "receipt");
      const code = `import {Ownership} from ${JSON.stringify(ownershipUrl)};
      const parent=await Ownership.open({profileDir:process.argv[1],lifetime:'leased',parent:null});
      const root=await parent.scratch('run-');
      const child=await Ownership.open({profileDir:root+'/profile',lifetime:'leased',parent:parent.reference});
      const worker=child.spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(resource)},root,process.argv[2]],{kill:'graceful',stdio:['ignore','ignore','ignore','ipc']});
      const ready=new Promise(resolve=>worker.child.once('message',resolve));await worker.registered;await ready;
      process.send({root,reference:parent.reference});setInterval(()=>{},1000);`;
      const coordinator = spawn(
        process.execPath,
        ["--input-type=module", "-e", code, directory, receipt],
        {
          stdio: ["ignore", "ignore", "inherit", "ipc"],
          env: { ...process.env, [OWNERSHIP_PARENT_ENV]: "" },
        }
      );
      let reference;
      after(t, async () => {
        if (coordinator.exitCode === null && coordinator.signalCode === null)
          coordinator.kill("SIGKILL");
        if (reference)
          await awaitRetirement(reference.dir, reference.id, { token: reference.token });
      });
      const ready = await new Promise((resolve, reject) => {
        coordinator.once("message", resolve);
        coordinator.once("error", reject);
        coordinator.once("exit", () => reject(new Error("Coordinator exited before readiness")));
      });
      reference = ready.reference;
      const ledger = readLedger(reference.dir, reference.id);
      coordinator.kill("SIGKILL");
      if (killReaper) process.kill(ledger.reaper.pid, "SIGKILL");
      await awaitRetirement(reference.dir, reference.id, { token: reference.token });
      await observe(() => fs.existsSync(receipt), t.signal);
      assert.equal(fs.readFileSync(receipt, "utf8"), "joined");
      assert.equal(fs.existsSync(ready.root), false);
    }
  );

test(
  "parent closure waits for actual in-process scoped work before removing bytes",
  { timeout: 15000 },
  async (t) => {
    const directory = profile(t),
      parent = await Ownership.open({ profileDir: directory, lifetime: "leased", parent: null });
    after(t, () => parent.release());
    const root = await parent.scratch("run-");
    const child = await Ownership.open({
      profileDir: path.join(directory, "child"),
      lifetime: "leased",
      parent: parent.reference,
    });
    let settle;
    const gate = new Promise((resolve) => {
      settle = resolve;
    });
    const receipt = path.join(directory, "in-process-receipt");
    child.scope.track(
      gate.then(() => {
        assert.equal(fs.existsSync(root), true);
        fs.writeFileSync(path.join(root, "final-write"), "joined");
        fs.writeFileSync(receipt, "joined");
      })
    );
    let finished = false;
    const closing = parent.release().then(() => {
      finished = true;
    });
    await observe(() => child.signal.aborted, t.signal);
    assert.equal(finished, false);
    assert.equal(fs.existsSync(root), true);
    await assert.rejects(
      Ownership.open({
        profileDir: path.join(directory, "late-child"),
        lifetime: "leased",
        parent: parent.reference,
      }),
      /being retired/
    );
    settle();
    await closing;
    assert.equal(fs.readFileSync(receipt, "utf8"), "joined");
    assert.equal(fs.existsSync(root), false);
  }
);

test(
  "explicit worker custody joins a still-active writer process before deleting its root",
  { timeout: 15000 },
  async (t) => {
    const directory = profile(t),
      parent = await Ownership.open({ profileDir: directory, lifetime: "leased", parent: null });
    after(t, () => parent.release());
    const root = await parent.scratch("run-");
    const code = `import fs from 'node:fs';import {Ownership} from ${JSON.stringify(ownershipUrl)};
    await Ownership.open({profileDir:process.argv[1]+'/worker-profile',lifetime:'leased'});
    fs.writeFileSync(process.argv[1]+'/live-write','actual');
    setInterval(()=>{fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+'/live-write','actual')},10);
    process.send({ready:true});`;
    const worker = spawn(process.execPath, ["--input-type=module", "-e", code, root], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: {
        ...process.env,
        [OWNERSHIP_PARENT_ENV]: JSON.stringify({ ...parent.reference, terminateOwner: true }),
      },
    });
    after(t, () => {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    });
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("Worker failed before admission")));
    });
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    const { captureProcessStart, observeProcessStart, signalProcessStart } =
      await import("./ownedProcessIdentity.mjs");
    const identity = captureProcessStart(worker.pid);
    if (process.platform !== "win32") {
      signalProcessStart({ ...identity, startCoordinate: "wrong-birth" }, "SIGKILL");
      assert.equal(observeProcessStart(identity), "live");
    }
    await parent.release();
    if (worker.exitCode === null && worker.signalCode === null) await exited;
    assert.equal(worker.signalCode, "SIGKILL");
    assert.equal(fs.existsSync(root), false);
  }
);

test(
  "scope cleanup can join an owned group while parent closure is in progress",
  { timeout: 15000 },
  async (t) => {
    const directory = profile(t),
      parent = await Ownership.open({ profileDir: directory, lifetime: "leased", parent: null });
    after(t, () => parent.release());
    const child = await Ownership.open({
      profileDir: path.join(directory, "child"),
      lifetime: "leased",
      parent: parent.reference,
    });
    const group = child.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      kill: "immediate",
      stdio: "ignore",
    });
    await group.registered;
    child.scope.defer(() => group.retire());
    await parent.release();
    assert.notEqual(group.child.signalCode, null);
  }
);

test(
  "a joined owner-scope failure is retained without retaining its entire run data",
  { timeout: 15000 },
  async (t) => {
    const directory = profile(t),
      parent = await Ownership.open({ profileDir: directory, lifetime: "leased", parent: null });
    after(t, () => awaitRetirement(parent.ledgerDir, parent.id, { token: parent.token }));
    const root = await parent.scratch("run-");
    const child = await Ownership.open({
      profileDir: path.join(directory, "child"),
      lifetime: "leased",
      parent: parent.reference,
    });
    child.scope.defer(() => {
      throw new Error("original in-process cleanup failure");
    });
    await assert.rejects(parent.release(), (error) => {
      const messages =
        JSON.stringify(error, Object.getOwnPropertyNames(error)) +
        String(error.errors?.map(String));
      assert.match(messages, /original in-process cleanup failure/);
      return true;
    });
    assert.equal(fs.existsSync(root), false);
  }
);

test(
  "coordinator SIGKILL retires an independently active fixture writer before its root",
  { timeout: 15000 },
  async (t) => {
    const directory = profile(t);
    const writerCode = `import fs from 'node:fs';import {Ownership} from ${JSON.stringify(ownershipUrl)};
    await Ownership.open({profileDir:process.argv[1]+'/worker-profile',lifetime:'leased'});
    fs.writeFileSync(process.argv[1]+'/live-write','actual');
    setInterval(()=>{fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+'/live-write','actual')},10);
    process.send({ready:true});`;
    const code = `import {spawn} from 'node:child_process';import {Ownership} from ${JSON.stringify(ownershipUrl)};
    const parent=await Ownership.open({profileDir:process.argv[1],lifetime:'leased',parent:null});const root=await parent.scratch('run-');
    const worker=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(writerCode)},root],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,VIBESTUDIO_OWNERSHIP_PARENT:JSON.stringify({...parent.reference,terminateOwner:true})}});
    await new Promise(resolve=>worker.once('message',resolve));process.send({reference:parent.reference,root,worker:worker.pid});setInterval(()=>{},1000);`;
    const coordinator = spawn(process.execPath, ["--input-type=module", "-e", code, directory], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { ...process.env, [OWNERSHIP_PARENT_ENV]: "" },
    });
    let reference;
    after(t, async () => {
      if (coordinator.exitCode === null && coordinator.signalCode === null)
        coordinator.kill("SIGKILL");
      if (reference) await awaitRetirement(reference.dir, reference.id, { token: reference.token });
    });
    const ready = await new Promise((resolve, reject) => {
      coordinator.once("message", resolve);
      coordinator.once("error", reject);
      coordinator.once("exit", () =>
        reject(new Error("Coordinator failed before worker readiness"))
      );
    });
    reference = ready.reference;
    const { captureProcessStart, observeProcessStart } = await import("./ownedProcessIdentity.mjs");
    const writer = captureProcessStart(ready.worker);
    coordinator.kill("SIGKILL");
    await awaitRetirement(reference.dir, reference.id, { token: reference.token });
    assert.notEqual(observeProcessStart(writer), "live");
    assert.equal(fs.existsSync(ready.root), false);
  }
);
