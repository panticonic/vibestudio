import { describe, expect, it } from "vitest";

import { readChannelSubscriptionRecords } from "./channel.js";

describe("channel subscription diagnostics", () => {
  it("preserves a bounded DO error body when subscription setup fails", async () => {
    const records = readChannelSubscriptionRecords(
      new Response(JSON.stringify({ error: "subscribe: missing-grant" }), { status: 500 })
    );

    await expect(records.next()).rejects.toThrow(
      'Channel subscription failed with HTTP 500: {"error":"subscribe: missing-grant"}'
    );
  });
});
