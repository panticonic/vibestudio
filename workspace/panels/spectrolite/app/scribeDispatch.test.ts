import { describe, it, expect, vi } from "vitest";
import { sendToScribe, buildScribeMessage } from "./scribeDispatch.js";

describe("sendToScribe", () => {
  it("flushes (commits) BEFORE dispatching — never sends stale content", async () => {
    const order: string[] = [];
    const commitPending = vi.fn(async () => {
      order.push("commit");
      return { stateHash: "state:fresh", changed: true };
    });
    const send = vi.fn(async () => {
      order.push("send");
    });
    const result = await sendToScribe({ commitPending, send }, { message: "fix the intro" });
    expect(order).toEqual(["commit", "send"]); // the invariant the original bug violated
    expect(result.stateHash).toBe("state:fresh");
    expect(send).toHaveBeenCalledWith(expect.stringContaining("fix the intro"), {
      mentions: ["scribe"],
    });
  });

  it("references the committed stateHash so the scribe edits what the user saw", async () => {
    const send = vi.fn(async (_content: string, _opts: { mentions: string[] }) => {});
    await sendToScribe(
      { commitPending: async () => ({ stateHash: "state:abc", changed: false }), send },
      { message: "tighten this", context: { path: "projects/default/Doc.mdx", selection: "wordy text" } }
    );
    const body = send.mock.calls[0]![0] as string;
    expect(body).toContain("tighten this");
    expect(body).toContain("wordy text");
    expect(body).toContain("state:abc");
  });

  it("targets a custom handle", async () => {
    const send = vi.fn(async () => {});
    await sendToScribe(
      { commitPending: async () => null, send },
      { message: "hi", handle: "editor-bot" }
    );
    expect(send).toHaveBeenCalledWith(expect.any(String), { mentions: ["editor-bot"] });
  });
});

describe("buildScribeMessage", () => {
  it("keeps the instruction first and appends a selection block + state marker", () => {
    const body = buildScribeMessage(
      { message: "rewrite", context: { path: "A.mdx", selection: "old text" } },
      "state:x"
    );
    expect(body.indexOf("rewrite")).toBeLessThan(body.indexOf("old text"));
    expect(body).toContain("state:x");
  });

  it("omits the state marker when there is no committed state", () => {
    expect(buildScribeMessage({ message: "hi" }, null)).toBe("hi");
  });
});
