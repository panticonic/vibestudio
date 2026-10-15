import { describe, expect, it } from "vitest";

import {
  readChannelSubscriptionRecords,
  channelSubscriptionQueuingStrategy,
  CHANNEL_SUBSCRIPTION_BUFFER_BYTES,
} from "./channel.js";

describe("channel subscription diagnostics", () => {
  it("propagates an errored transport once by identity after joining reader cleanup", async () => {
    const original = new Error("transport disconnected");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(original);
      },
    });
    await expect(readChannelSubscriptionRecords({ status: 200, body }).next()).rejects.toBe(
      original
    );
    expect(body.locked).toBe(false);
  });
  it("consumes raw native head/body without a Response wrapper", async () => {
    const bytes = new TextEncoder().encode(
      '{"kind":"subscribed","result":{"ok":true}}\n{"kind":"message","payload":"hello"}\n'
    );
    const records = readChannelSubscriptionRecords({
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
    const values = [];
    for await (const record of records) values.push(record);
    expect(values).toEqual([
      { kind: "subscribed", result: { ok: true } },
      { kind: "message", payload: "hello" },
    ]);
  });

  it("bounds failure diagnostics and cancels the same owned reader", async () => {
    let cancelled = false;
    const response = {
      status: 503,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(10000)));
        },
        cancel() {
          cancelled = true;
        },
      }),
    };
    await expect(readChannelSubscriptionRecords(response).next()).rejects.toThrow(
      "Channel subscription failed with HTTP 503: " + "x".repeat(4096)
    );
    expect(cancelled).toBe(true);
    expect(response.body.locked).toBe(false);
  });

  it("retains parse failure and independent cancellation failure", async () => {
    const cleanup = new Error("owned cancellation failed");
    const response = {
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("not-json\n"));
        },
        cancel() {
          throw cleanup;
        },
      }),
    };
    await expect(readChannelSubscriptionRecords(response).next()).rejects.toMatchObject({
      errors: [expect.any(SyntaxError), cleanup],
    });
    expect(response.body.locked).toBe(false);
  });

  it("uses actual byte capacity without a platform queuing-strategy constructor", () => {
    const strategy = channelSubscriptionQueuingStrategy();
    expect(strategy.highWaterMark).toBe(CHANNEL_SUBSCRIPTION_BUFFER_BYTES);
    expect(strategy.size(new Uint8Array(12))).toBe(12);
  });
  it("preserves a bounded DO error body when subscription setup fails", async () => {
    const records = readChannelSubscriptionRecords(
      new Response(JSON.stringify({ error: "subscribe: missing-grant" }), { status: 500 })
    );

    await expect(records.next()).rejects.toThrow(
      'Channel subscription failed with HTTP 500: {"error":"subscribe: missing-grant"}'
    );
  });
});
