import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PhononEngine } from "./engine.mjs";

// Owned by the extension with an IPC channel. Losing that owner is a terminal
// event, even if the engine is currently inside a synchronous native call.
process.on("disconnect", () => process.exit(0));
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let engine;
try {
  engine = new PhononEngine(fileURLToPath(new URL("../../", import.meta.url)), (message) =>
    send({ type: "progress", message })
  );
  send({ type: "ready", ...engine.description });
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const request = JSON.parse(line);
      if (
        request.format !== "pcm_f32le" ||
        request.sampleRate !== 16000 ||
        typeof request.audio !== "string" ||
        request.audio.length > Math.ceil((4 * 1024 * 1024) / 3) * 4
      )
        throw new Error("Expected mono 16 kHz float32 PCM, up to 4 MiB");
      const bytes = Buffer.from(request.audio, "base64");
      if (bytes.length % 4 || bytes.length < 640 || bytes.length > 4 * 1024 * 1024)
        throw new Error("Invalid PCM recording length");
      const audio = new Float32Array(bytes.length / 4);
      for (let i = 0; i < audio.length; i++) {
        const value = bytes.readFloatLE(4 * i);
        if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error("Invalid PCM sample");
        audio[i] = value;
      }
      send({ type: "progress", message: "Transcribing…" });
      send({ type: "result", ...engine.transcribe(audio) });
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
} catch (error) {
  send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  engine?.close();
  if (process.connected) process.disconnect();
}
