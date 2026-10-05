import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { createSpeechService } from "./speechService.js";

it("dispatches bundled offline speech as a host Response and joins its native owner", async () => {
  const wav = await readFile("native/phonon/fixtures/jfk.wav");
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 < wav.length; ) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString("ascii", offset, offset + 4) === "data") {
      pcm = wav.subarray(offset + 8, offset + 8 + size);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  expect(pcm).toBeDefined();
  const audio = Buffer.alloc(pcm!.length * 2);
  for (let i = 0; i < pcm!.length / 2; i++)
    audio.writeFloatLE(pcm!.readInt16LE(2 * i) / 32768, 4 * i);
  const service = createSpeechService({ appRoot: process.cwd() });
  const dispatcher = createTestServiceDispatcher();
  dispatcher.registerService(service);
  dispatcher.markInitialized();
  const connection = new AbortController();
  const ctx = {
    caller: createVerifiedCaller("panel:chat", "panel"),
    connectionSignal: connection.signal,
  };
  try {
    expect(await dispatcher.dispatch(ctx, "speech", "status", [])).toEqual({ ready: false });
    const preparing = (await dispatcher.dispatch(ctx, "speech", "prepare", [])) as Response;
    const preparation = (await preparing.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      preparation.some((event) => event.type === "progress" && event.completed !== undefined)
    ).toBe(true);
    expect(preparation.at(-1)).toEqual({ type: "ready" });
    expect(await dispatcher.dispatch(ctx, "speech", "status", [])).toEqual({ ready: true });
    const response = (await dispatcher.dispatch(ctx, "speech", "transcribe", [
      { format: "pcm_f32le", sampleRate: 16000, audio: audio.toString("base64") },
    ])) as Response;
    expect(response).toBeInstanceOf(Response);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "progress")).toBe(true);
    const result = events.at(-1);
    expect(result).toEqual({
      type: "result",
      text: expect.any(String),
      model: "phonon-2",
      language: "en",
    });
    // CPU kernels can differ in punctuation; the recognized words are the
    // inference contract, as in the standalone native speech smoke test.
    expect(result.text.replace(/[^a-z ]/gi, "").toLowerCase()).toBe(
      "and so my fellow americans ask not what your country can do for you ask what you can do for your country"
    );
    // A subsequent stream owns the resident model, then explicit transport
    // cancellation retires and joins that work through the same Response API.
    const second = (await dispatcher.dispatch(ctx, "speech", "transcribe", [
      { format: "pcm_f32le", sampleRate: 16000, audio: audio.toString("base64") },
    ])) as Response;
    await second.body!.cancel("user cancelled");
  } finally {
    await service.stop();
  }
}, 120_000);
