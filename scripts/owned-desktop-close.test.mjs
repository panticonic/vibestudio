import assert from "node:assert/strict";
import test from "node:test";
import { closeOwnedDesktop } from "./lib/owned-desktop-close.mjs";

function fixture(exitCode = 0) {
  const events = [];
  const app = {
    async close() {
      events.push("close");
    },
    process() {
      return { exitCode, signalCode: null };
    },
  };
  const owner = {
    async join() {
      events.push("joined");
    },
    async retire(signal) {
      events.push(signal);
    },
  };
  return { app, owner, events };
}

test("successful desktop acceptance joins a clean application exit", async () => {
  const { app, owner, events } = fixture();
  await closeOwnedDesktop(app, owner);
  assert.deepEqual(events, ["close", "joined"]);
});

test("a shutdown failure cannot pass acceptance because its close protocol succeeded", async () => {
  const { app, owner, events } = fixture(1);
  await assert.rejects(closeOwnedDesktop(app, owner), /Desktop exited with code 1/);
  assert.deepEqual(events, ["close", "joined"]);
});

test("a failed close protocol is contained and retains its original error", async () => {
  const { app, owner, events } = fixture();
  const failure = new Error("Original desktop close failure");
  app.close = async () => {
    throw failure;
  };
  await assert.rejects(closeOwnedDesktop(app, owner), (error) => error === failure);
  assert.deepEqual(events, ["SIGKILL"]);
});
