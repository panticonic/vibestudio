import { describe, expect, it } from "vitest";
import { ConsoleStreamer } from "./consoleStreamer.js";

/** A controllable forward sink: each call resolves only when the test releases it. */
function gatedSink() {
  const chunks: string[] = [];
  let release!: () => void;
  let gate = new Promise<void>((r) => (release = r));
  const forward = async (chunk: string): Promise<void> => {
    chunks.push(chunk);
    await gate;
    gate = new Promise<void>((r) => (release = r));
  };
  return { chunks, forward, release: () => release() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ConsoleStreamer", () => {
  it("forwards the first line immediately and coalesces lines pushed while a forward is in flight", async () => {
    const sink = gatedSink();
    const s = new ConsoleStreamer(sink.forward);

    s.push("a"); // kicks an immediate forward ("a"), now in flight (gated)
    await tick();
    expect(sink.chunks).toEqual(["a"]);

    // While "a" is in flight, more lines accumulate into ONE coalesced chunk.
    s.push("b");
    s.push("c");
    await tick();
    expect(sink.chunks).toEqual(["a"]); // still only "a" — "b"/"c" buffered

    sink.release(); // "a" completes → the buffered "b\nc" forwards as one chunk
    await tick();
    expect(sink.chunks).toEqual(["a", "b\nc"]);
  });

  it("close aborts a stuck forward and never waits for progress delivery", async () => {
    let signal: AbortSignal | undefined;
    const s = new ConsoleStreamer(async (_chunk, nextSignal) => {
      signal = nextSignal;
      await new Promise<void>(() => {});
    });

    s.push("one");
    await tick();
    expect(signal?.aborted).toBe(false);

    s.push("two");
    s.close();
    expect(signal?.aborted).toBe(true);

    s.push("ignored after close");
  });

  it("close is immediate when nothing was pushed", () => {
    const sink = gatedSink();
    const s = new ConsoleStreamer(sink.forward);
    s.close();
    expect(sink.chunks).toEqual([]);
  });

  it("a failing forward remains best-effort and keeps draining while open", async () => {
    const seen: string[] = [];
    let first = true;
    const s = new ConsoleStreamer(async (chunk) => {
      seen.push(chunk);
      if (first) {
        first = false;
        throw new Error("forward boom");
      }
    });
    s.push("x");
    await tick();
    s.push("y");
    await tick();
    expect(seen).toEqual(["x", "y"]); // second chunk still forwarded after the first threw
    s.close();
  });
});
