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
    const response = (await dispatcher.dispatch(ctx, "speech", "transcribe", [
      { format: "pcm_f32le", sampleRate: 16000, audio: audio.toString("base64") },
    ])) as Response;
    expect(response).toBeInstanceOf(Response);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "progress")).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "result",
      text: "And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.",
      model: "phonon-2",
      language: "en",
    });
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
