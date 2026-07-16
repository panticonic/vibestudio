import { describe, expect, it, vi } from "vitest";
import { sendToScribe } from "./scribeDispatch.js";

describe("sendToScribe", () => {
  it("seals and names the exact frontier before dispatch", async () => {
    const send = vi.fn(async () => undefined);
    const result = await sendToScribe(
      {
        commitPending: async () => ({ eventId: "event:exact", changed: true }),
        send,
      },
      { message: "Improve this", context: { path: "Note.mdx" } }
    );
    expect(result).toEqual({ eventId: "event:exact" });
    expect(send).toHaveBeenCalledWith(expect.stringContaining("@event event:exact"), {
      mentions: ["scribe"],
    });
  });
});
