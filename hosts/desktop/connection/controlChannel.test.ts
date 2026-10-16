import { describe, expect, it } from "vitest";
import {
  ControlChannel,
  StreamReply,
  StreamedResponse,
  controlChannelClosed,
  createMessagePortPair,
} from "./controlChannel.js";

function pair() {
  const [a, b] = createMessagePortPair();
  return { main: new ControlChannel(a, "a"), utility: new ControlChannel(b, "b") };
}

const bytes = (...values: number[]) => new Uint8Array(values);
async function drain(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return out;
    out.push(...next.value);
  }
}
function source(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  });
}

describe("ControlChannel", () => {
  it("answers requests in both directions and carries structured failures", async () => {
    const { main, utility } = pair();
    utility.handle("add", ([a, b]: number[]) => a! + b!);
    main.handle("fail", () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(main.request("add", [2, 3])).resolves.toBe(5);
    await expect(utility.request("fail")).rejects.toMatchObject({
      message: "denied",
      code: "EACCES",
    });
    await expect(main.request("missing")).rejects.toThrow("Unknown control method");
  });

  it("delivers events to subscribers until they unsubscribe", async () => {
    const { main, utility } = pair();
    const seen: unknown[] = [];
    const stop = main.on("tick", (payload) => seen.push(payload));
    utility.emit("tick", 1);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
    utility.emit("tick", 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([1]);
  });

  it("streams a handler's reply and an upload body, in order", async () => {
    const { main, utility } = pair();
    utility.handle("echo", async (_payload, context) => {
      const received = await drain(context.body!);
      return new StreamReply({ count: received.length }, source([bytes(...received), bytes(9)]));
    });
    const reply = await main.requestStream<{ count: number }>("echo", null, {
      body: source([bytes(1, 2), bytes(3)]),
    });
    expect(reply.head).toEqual({ count: 3 });
    await expect(drain(reply.body)).resolves.toEqual([1, 2, 3, 9]);
  });

  it("lets a handler choose between a value and a stream per call", async () => {
    const { main, utility } = pair();
    utility.handle("either", (wantStream: boolean) =>
      wantStream ? new StreamReply("h", source([bytes(7)])) : "value"
    );
    await expect(main.requestEither("either", false)).resolves.toBe("value");
    const streamed = await main.requestEither("either", true);
    expect(streamed).toBeInstanceOf(StreamedResponse);
    await expect(drain((streamed as StreamedResponse).body)).resolves.toEqual([7]);
    await expect(main.request("either", true)).rejects.toThrow("expects a value");
  });

  it("bounds a stream by the reader: a sender does not run ahead of an idle consumer", async () => {
    const { main, utility } = pair();
    let produced = 0;
    utility.handle(
      "firehose",
      () =>
        new StreamReply(
          null,
          new ReadableStream<Uint8Array>({
            pull(controller) {
              produced += 1;
              controller.enqueue(bytes(produced));
            },
          })
        )
    );
    const reply = await main.requestStream("firehose");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The window is a handful of chunks, not an unbounded queue.
    expect(produced).toBeLessThan(20);
    await reply.body.cancel();
  });

  it("aborts the handler when the requester's signal aborts", async () => {
    const { main, utility } = pair();
    let aborted = false;
    utility.handle("hang", (_p, context) => {
      context.signal.addEventListener("abort", () => (aborted = true));
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const pending = main.request("hang", null, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
  });

  it("settles every pending request and open stream with the failure it is ended with", async () => {
    const { main, utility } = pair();
    utility.handle("hang", () => new Promise(() => undefined));
    utility.handle(
      "slow",
      () =>
        new StreamReply(
          null,
          new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) })
        )
    );
    const pending = main.request("hang");
    const stream = await main.requestStream("slow");
    const reading = stream.body.getReader().read();
    const closed: Error[] = [];
    main.onClose((reason) => closed.push(reason));
    const reason = controlChannelClosed("The connection process exited unexpectedly (code 9)");
    main.fail(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(reading).rejects.toBe(reason);
    await expect(main.request("hang")).rejects.toBe(reason);
    expect(closed).toEqual([reason]);
  });

  it("ends the peer when a port closes, unless its owner decides the reason itself", async () => {
    const [a, b] = createMessagePortPair();
    const eager = new ControlChannel(a, "a");
    const owner = new ControlChannel(b, "b", { endOnPortClose: false });
    a.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(eager.isClosed).toBe(true);
    expect(owner.isClosed).toBe(false);
  });
});
