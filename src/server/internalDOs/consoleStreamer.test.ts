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

  it("finalFlush drains everything buffered, including lines pushed during the last in-flight forward", async () => {
    const sink = gatedSink();
    const s = new ConsoleStreamer(sink.forward);

    s.push("one");
    await tick();
    s.push("two"); // buffered behind the in-flight "one"
    sink.release(); // let "one" finish; its completion kicks "two"

    const done = s.finalFlush();
    await tick();
    s.push("three"); // arrives while "two" is in flight → must still be drained
    sink.release(); // "two" done → kicks "three"
    await tick();
    sink.release(); // "three" done
    await done;

    expect(sink.chunks).toEqual(["one", "two", "three"]);
  });

  it("finalFlush resolves immediately when nothing was pushed", async () => {
    const sink = gatedSink();
    const s = new ConsoleStreamer(sink.forward);
    await s.finalFlush();
    expect(sink.chunks).toEqual([]);
  });

  it("a failing forward never rejects push/finalFlush (best-effort) and keeps draining", async () => {
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
    await expect(s.finalFlush()).resolves.toBeUndefined();
    expect(seen).toEqual(["x", "y"]); // second chunk still forwarded after the first threw
  });
});
