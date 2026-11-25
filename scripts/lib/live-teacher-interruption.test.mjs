import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  collectionInterruption,
  forwardCommandInterruption,
  runTeacherCommand,
} from "./live-teacher-interruption.mjs";

test(
  "forwards interruption to an actual child and joins its evidence before returning",
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "teacher-cancel-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "evidence");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    const fs=require('node:fs');
    process.on('SIGTERM',()=>{ fs.writeFileSync(${JSON.stringify(file)},'canonical cancel and retained evidence'); process.exit(130); });
    console.log('ready'); setInterval(()=>{},1000);
  `,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    await once(child.stdout, "data");
    const controller = new AbortController();
    const remove = forwardCommandInterruption(controller.signal, child);
    const closed = once(child, "close");
    controller.abort({ signal: "SIGTERM" });
    assert.deepEqual(await closed, [130, null]);
    remove();
    assert.equal(await readFile(file, "utf8"), "canonical cancel and retained evidence");
  }
);

test(
  "an atomic checkpoint cancels an active command once and records only unfinished cases",
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "teacher-checkpoint-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const requestPath = path.join(root, "request.json");
    const signals = new EventEmitter();
    const owner = collectionInterruption({
      requestPath,
      out: root,
      cases: ["passed", "failed", "active", "queued"],
      processSignals: signals,
    });
    t.after(() => owner.dispose());
    owner.complete(["passed", "failed"]);
    const completion = runTeacherCommand(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>process.exit(130)); console.log('ready');setInterval(()=>{},1000)",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
      owner.signal
    );
    const request = path.join(root, "request.tmp");
    await writeFile(request, JSON.stringify({ reason: "graceful campaign checkpoint" }));
    await rename(request, requestPath);
    await completion;
    const first = JSON.parse(
      await readFile(path.join(root, "collection-interruption.json"), "utf8")
    );
    assert.equal(first.reason, "graceful campaign checkpoint");
    assert.deepEqual(first.completedCases, ["passed", "failed"]);
    assert.deepEqual(first.interruptedCases, ["active", "queued"]);
    signals.emit("SIGTERM", "SIGTERM");
    owner.complete(["active"]);
    const final = JSON.parse(
      await readFile(path.join(root, "collection-interruption.json"), "utf8")
    );
    assert.equal(final.requestedAt, first.requestedAt);
    assert.deepEqual(final.completedCases, ["passed", "failed", "active"]);
    assert.deepEqual(final.interruptedCases, ["queued"]);
    await assert.rejects(
      runTeacherCommand(process.execPath, ["-e", "throw Error('must not admit')"], {}, owner.signal)
    );
  }
);
