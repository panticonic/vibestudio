import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import fsSync from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { SharedBuildCoordinator } from "./sharedBuildCoordinator.js";
import { BuildPriorityOwner } from "./builderLifetime.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deserializeRpcFailure } from "@vibestudio/rpc";

interface Message {
  type: string;
  id?: string;
  failure?: unknown;
  result?: unknown;
}
const roots: string[] = [];
const children: Array<{ process: ChildProcess; closed: Promise<unknown> }> = [];
async function child(root: string, capacity = 3) {
  const process = spawn(
    globalThis.process.execPath,
    ["--import", "tsx", "tests/fixtures/sharedBuildCoordinatorChild.ts", root, String(capacity)],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  const closed = once(process, "close");
  children.push({ process, closed });
  const messages: Message[] = [];
  const readers = new Set<() => void>();
  let errorTail = "";
  process.stderr!.on("data", (chunk) => {
    errorTail = (errorTail + chunk).slice(-4096);
  });
  process.on("message", (message: Message) => {
    messages.push(message);
    for (const read of [...readers]) read();
  });
  const read = (type: string, id?: string) =>
    new Promise<Message>((resolve, reject) => {
      const check = () => {
        const index = messages.findIndex((message) => message.type === type && message.id === id);
        if (index >= 0) {
          readers.delete(check);
          process.off("close", exited);
          resolve(messages.splice(index, 1)[0]!);
        }
      };
      const exited = () => {
        readers.delete(check);
        reject(new Error(`Test compiler owner exited: ${errorTail}`));
      };
      process.once("close", exited);
      readers.add(check);
      check();
    });
  await read("ready");
  return {
    read,
    messages,
    send: (command: string, id: string, fields = {}) =>
      process.send!({ command, id, key: "same-build", priority: "speculative", ...fields }),
    process,
  };
}
function root() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shared-build-coordinator-"));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  for (const child of children) {
    if (child.process.exitCode === null && child.process.signalCode === null)
      child.process.kill("SIGTERM");
  }
  await Promise.all(children.map((child) => child.closed));
  children.length = 0;
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
describe("cross-process build ownership", () => {
  it("promotes a producer queued in another process when interactive demand joins its key", async () => {
    const directory = root();
    const a = await child(directory, 2);
    const b = await child(directory, 2);
    a.send("slot", "occupied");
    await a.read("entered", "occupied");
    a.send("run", "producer", { slot: true });
    await a.read("admitted", "producer");
    b.send("run", "desktop", { priority: "interactive", slot: true });
    await b.read("admitted", "desktop");
    await a.read("entered", "producer");
    a.send("release", "producer");
    await a.read("complete", "producer");
    await b.read("complete", "desktop");
    expect(
      b.messages.some((message) => message.type === "entered" && message.id === "desktop")
    ).toBe(false);
    a.send("release", "occupied");
    await a.read("complete", "occupied");
  });
  it("compiles a key once while concurrent consumers wait without running another compiler", async () => {
    const directory = root();
    const a = await child(directory);
    const b = await child(directory);
    a.send("run", "producer");
    await a.read("entered", "producer");
    b.send("run", "borrower");
    await b.read("admitted", "borrower");
    a.send("release", "producer");
    expect((await a.read("complete", "producer")).result).toEqual({
      produced: true,
      value: "artifact",
    });
    expect((await b.read("complete", "borrower")).result).toEqual({ produced: false });
    expect(b.messages.some((message) => message.type === "entered")).toBe(false);
  });
  it("propagates the original compiler failure to other processes", async () => {
    const directory = root();
    const a = await child(directory);
    const b = await child(directory);
    a.send("run", "producer");
    await a.read("entered", "producer");
    b.send("run", "borrower");
    await b.read("admitted", "borrower");
    a.send("release", "producer", { failure: "compiler rejected exact source" });
    const failure = deserializeRpcFailure((await b.read("failed", "borrower")).failure);
    expect(failure).toMatchObject({ message: "compiler rejected exact source", code: "ECOMPILER" });
    await a.read("failed", "producer");
  });
  it("settles a borrower on confirmed producer death without starting another build", async () => {
    const directory = root();
    const a = await child(directory);
    const b = await child(directory);
    a.send("run", "producer");
    await a.read("entered", "producer");
    b.send("run", "borrower");
    await b.read("admitted", "borrower");
    a.process.kill("SIGKILL");
    expect(deserializeRpcFailure((await b.read("failed", "borrower")).failure)).toMatchObject({
      code: "EBUILD_OWNER_EXIT",
    });
    expect(b.messages.some((message) => message.type === "entered")).toBe(false);
  });
  it("cancels a waiting borrower without cancelling the producer", async () => {
    const directory = root();
    const a = await child(directory);
    const b = await child(directory);
    a.send("run", "producer");
    await a.read("entered", "producer");
    b.send("run", "borrower");
    await b.read("admitted", "borrower");
    b.send("cancel", "borrower");
    await b.read("failed", "borrower");
    a.send("release", "producer");
    await a.read("complete", "producer");
  });
  it("hands a cancelled producer's key to a waiting borrower instead of its cancellation", async () => {
    const directory = root();
    const a = await child(directory);
    const b = await child(directory);
    a.send("run", "producer");
    await a.read("entered", "producer");
    b.send("run", "borrower");
    await b.read("admitted", "borrower");
    a.send("cancel", "producer");
    expect(deserializeRpcFailure((await a.read("failed", "producer")).failure)).toMatchObject({
      message: "request explicitly cancelled",
    });
    await b.read("entered", "borrower");
    b.send("release", "borrower");
    expect((await b.read("complete", "borrower")).result).toEqual({
      produced: true,
      value: "artifact",
    });
  });
  it("reserves compiler capacity for interactive work across processes", async () => {
    const directory = root();
    const a = await child(directory, 2);
    const b = await child(directory, 2);
    a.send("slot", "background");
    await a.read("entered", "background");
    b.send("slot", "queued");
    await b.read("admitted", "queued");
    b.send("slot", "desktop", { priority: "interactive" });
    await b.read("entered", "desktop");
    expect(
      b.messages.some((message) => message.type === "entered" && message.id === "queued")
    ).toBe(false);
    b.send("release", "desktop");
    await b.read("complete", "desktop");
    a.send("release", "background");
    await a.read("complete", "background");
    await b.read("entered", "queued");
    b.send("release", "queued");
    await b.read("complete", "queued");
  });
});

it("runs uncontended cold builds at every priority without allocating a watcher", async () => {
  const failure = Object.assign(new Error("watch admission exhausted"), { code: "EMFILE" });
  const watch = vi.spyOn(fsSync, "watch").mockImplementation(() => {
    throw failure;
  });
  syncBuiltinESMExports();
  const coordinator = new SharedBuildCoordinator(root(), 3);
  try {
    const signal = new AbortController().signal;
    for (const demand of ["interactive", "background", "speculative"] as const) {
      const result = await coordinator.run(
        "cold-" + demand,
        new BuildPriorityOwner(demand),
        signal,
        (priority) => coordinator.withSlot(priority, signal, async () => "actual artifact")
      );
      expect(result).toEqual({ produced: true, value: "actual artifact" });
    }
    expect(watch).not.toHaveBeenCalled();
  } finally {
    coordinator.close();
    watch.mockRestore();
    syncBuiltinESMExports();
  }
});

it("preserves an actual borrower observation failure without corrupting its producer", async () => {
  const failure = Object.assign(new Error("watch admission exhausted"), { code: "EMFILE" });
  const watch = vi.spyOn(fsSync, "watch").mockImplementation(() => {
    throw failure;
  });
  syncBuiltinESMExports();
  const directory = root();
  const producer = new SharedBuildCoordinator(directory, 3);
  const borrower = new SharedBuildCoordinator(directory, 3);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const permitted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = producer.run(
    "cold",
    new BuildPriorityOwner("speculative"),
    new AbortController().signal,
    async () => {
      entered();
      await permitted;
      return "actual artifact";
    }
  );
  try {
    await started;
    await expect(
      borrower.run(
        "cold",
        new BuildPriorityOwner("interactive"),
        new AbortController().signal,
        async () => "must not run"
      )
    ).rejects.toBe(failure);
    expect(watch).toHaveBeenCalledTimes(1);
    borrower.close();
    release();
    await expect(work).resolves.toEqual({ produced: true, value: "actual artifact" });
  } finally {
    release();
    await work;
    producer.close();
    borrower.close();
    watch.mockRestore();
    syncBuiltinESMExports();
  }
});

it("closes SQLite if its initialization itself fails before observation exists", () => {
  const failure = new Error("coordinator database initialization failed");
  const close = vi.spyOn(DatabaseSync.prototype, "close");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(() => {
    throw failure;
  });
  try {
    expect(() => new SharedBuildCoordinator(root(), 3)).toThrow(failure);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    exec.mockRestore();
    close.mockRestore();
  }
});

it("adopts joined interactive demand before later requesting an otherwise free compiler slot", async () => {
  const directory = root();
  const producer = new SharedBuildCoordinator(directory, 3);
  const borrower = new SharedBuildCoordinator(directory, 3);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const dependency = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signal = new AbortController().signal;
  const work = producer.run(
    "late-permit",
    new BuildPriorityOwner("speculative"),
    signal,
    async (priority) => {
      entered();
      await dependency;
      return producer.withSlot(priority, signal, async () => priority.priority);
    }
  );
  try {
    await started;
    const joined = borrower.run(
      "late-permit",
      new BuildPriorityOwner("interactive"),
      signal,
      async () => "must not run"
    );
    release();
    await expect(work).resolves.toEqual({ produced: true, value: "interactive" });
    await expect(joined).resolves.toEqual({ produced: false });
  } finally {
    release();
    await work;
    producer.close();
    borrower.close();
  }
});
