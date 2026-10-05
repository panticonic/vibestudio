import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpeechRuntime } from "./speechRuntime.js";
import type { SpeechRecording } from "@vibestudio/service-schemas/speech";

const owned: Array<{ runtime: SpeechRuntime; root: string }> = [];
afterEach(async () => {
  for (const { runtime, root } of owned.splice(0)) {
    await runtime.stop();
    await rm(root, { recursive: true });
  }
  vi.unstubAllEnvs();
});
async function fixture(ready = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "speech-owner-"));
  await writeFile(
    path.join(root, "runner.mjs"),
    `
    import {createInterface} from 'node:readline';
    process.on('disconnect',()=>process.exit(0));
    const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
    send({type:'progress',message:'Loading weights',completed:1,total:2});
    if (${ready}) send({type:'ready'});
    for await(const line of createInterface({input:process.stdin})) {
      const request=JSON.parse(line);
      send({type:'progress',message:'started'});
      if(request.audio==='wait') continue;
      if(request.audio==='crash') { process.stderr.write('original native failure'); process.exit(7); }
      send({type:'result',text:request.audio,model:'phonon-2',language:'en'});
    }
    if(process.connected) process.disconnect();
  `
  );
  const runtime = new SpeechRuntime({ executable: process.execPath, entryRoot: root });
  owned.push({ runtime, root });
  return runtime;
}
const recording = (audio: string): SpeechRecording => ({
  format: "pcm_f32le",
  sampleRate: 16000,
  audio,
});
it("keeps the model resident and serializes callers", async () => {
  const runtime = await fixture();
  const events: string[] = [];
  const emit = (event: { type: string; text?: string }) => {
    if (event.text) events.push(event.text);
  };
  await Promise.all([
    runtime.transcribe(recording("first"), new AbortController().signal, emit),
    runtime.transcribe(recording("second"), new AbortController().signal, emit),
  ]);
  expect(events).toEqual(["first", "second"]);
});
it("cancels and joins the active process before the queued caller acquires a new model", async () => {
  const runtime = await fixture();
  const cancellation = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const active = runtime.transcribe(recording("wait"), cancellation.signal, () => started());
  const rejected = expect(active).rejects.toMatchObject({ name: "AbortError" });
  const events: string[] = [];
  const next = runtime.transcribe(recording("next"), new AbortController().signal, (event) => {
    if (event.type === "result") events.push(event.text);
  });
  await ready;
  cancellation.abort();
  await rejected;
  await next;
  expect(events).toEqual(["next"]);
});
it("propagates native exit diagnostics and retires owned work on service shutdown", async () => {
  const runtime = await fixture();
  await expect(
    runtime.transcribe(recording("crash"), new AbortController().signal, () => {})
  ).rejects.toThrow(/original native failure/);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const active = runtime.transcribe(recording("wait"), new AbortController().signal, () =>
    started()
  );
  const rejected = expect(active).rejects.toThrow(/Speech runtime exited/);
  await ready;
  await runtime.stop();
  await rejected;
  await expect(
    runtime.transcribe(recording("later"), new AbortController().signal, () => {})
  ).rejects.toThrow(/stopped/);
});

it("prepares without a recording and exposes readiness for reuse", async () => {
  const runtime = await fixture();
  expect(runtime.status()).toEqual({ ready: false });
  const preparation: unknown[] = [];
  await runtime.prepare(new AbortController().signal, (event) => preparation.push(event));
  expect(preparation).toEqual([
    { type: "progress", message: "Loading weights", completed: 1, total: 2 },
    { type: "ready" },
  ]);
  expect(runtime.status()).toEqual({ ready: true });
  const reuse: unknown[] = [];
  await runtime.prepare(new AbortController().signal, (event) => reuse.push(event));
  expect(reuse).toEqual([{ type: "ready" }]);
  await runtime.stop();
  expect(runtime.status()).toEqual({ ready: false });
});

it("cancels model loading before readiness and joins its process", async () => {
  const runtime = await fixture(false);
  const signal = new AbortController();
  let began!: () => void;
  const loading = new Promise<void>((resolve) => {
    began = resolve;
  });
  const operation = runtime.prepare(signal.signal, () => began());
  const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
  await loading;
  expect(runtime.status()).toEqual({ ready: false });
  signal.abort();
  await rejected;
  expect(runtime.status()).toEqual({ ready: false });
});

it("rejects invalid audio asynchronously without loading the model", async () => {
  const runtime = await fixture();
  await expect(
    runtime.transcribe(
      { ...recording("audio"), sampleRate: 8000 } as unknown as SpeechRecording,
      new AbortController().signal,
      () => {}
    )
  ).rejects.toThrow();
  expect(runtime.status()).toEqual({ ready: false });
});
