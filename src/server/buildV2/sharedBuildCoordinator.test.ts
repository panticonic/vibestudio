import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
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
