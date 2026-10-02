import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { stagePhononRuntime, assertPhononRuntimeArtifacts } from "./phonon-runtime-artifacts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await stagePhononRuntime(root);
const runtime = await assertPhononRuntimeArtifacts(root);
const wav = await readFile(new URL("../native/phonon/fixtures/jfk.wav", import.meta.url));
let pcm;
for (let offset = 12; offset + 8 < wav.length; ) {
  const size = wav.readUInt32LE(offset + 4);
  if (wav.toString("ascii", offset, offset + 4) === "data") {
    pcm = wav.subarray(offset + 8, offset + 8 + size);
    break;
  }
  offset += 8 + size + (size % 2);
}
assert.ok(pcm);
const audio = Buffer.alloc(pcm.length * 2);
for (let i = 0; i < pcm.length / 2; i++) audio.writeFloatLE(pcm.readInt16LE(2 * i) / 32768, 4 * i);
const child = spawn(process.execPath, [`${runtime}/runner.mjs`], {
  stdio: ["pipe", "pipe", "inherit", "ipc"],
});
let failure;
child.on("error", (error) => {
  failure = error;
});
const closed = new Promise((resolve) =>
  child.once("close", (code, signal) => resolve({ code, signal }))
);
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
async function until(type) {
  for (;;) {
    const { value, done } = await iterator.next();
    if (done)
      throw failure ?? new Error(`Inference process exited: ${JSON.stringify(await closed)}`);
    const event = JSON.parse(value);
    if (event.type === "error" && type !== "error") throw new Error(event.message);
    if (event.type === type) return event;
  }
}
try {
  console.log("Loading the bundled model without Python…");
  const ready = await until("ready");
  console.log(JSON.stringify(ready));
  child.stdin.write(`${JSON.stringify({ format: "invalid" })}\n`);
  assert.match((await until("error")).message, /PCM/);
  for (let iteration = 0; iteration < 2; iteration++) {
    child.stdin.write(
      `${JSON.stringify({ format: "pcm_f32le", sampleRate: 16000, audio: audio.toString("base64") })}\n`
    );
    const result = await until("result");
    assert.equal(
      result.text.replace(/[^a-z ]/gi, "").toLowerCase(),
      "and so my fellow americans ask not what your country can do for you ask what you can do for your country"
    );
    console.log(result.text);
  }
  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
} finally {
  child.kill("SIGKILL");
  await closed;
  lines.close();
}
