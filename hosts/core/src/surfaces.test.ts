import { describe, expect, it } from "vitest";
import { clientIntentLink, launchEntries, textParamOf } from "./surfaces.js";

describe("launch surfaces", () => {
  it("encodes links in the intent grammar", () => {
    expect(clientIntentLink("chat", "open")).toBe("vibestudio://c/chat/open");
    expect(clientIntentLink("chat", "open-conversation", { channel: "a b" })).toBe(
      "vibestudio://c/chat/open-conversation?channel=a%20b"
    );
  });

  it("projects plain foreground intents and dynamic entries only", () => {
    const [chat] = launchEntries([
      {
        id: "chat",
        title: "Chat",
        intents: [
          { name: "open-conversation", kind: "foreground", params: { channel: "string" } },
          { name: "ask", kind: "background", params: { text: "text" }, handler: "p#ask" },
          { name: "share-in", kind: "foreground", accepts: ["text/*"] },
          { name: "new", kind: "foreground", title: "New chat" },
        ],
        entries: { "open-conversation": [{ title: "Standup", params: { channel: "c1" } }] },
      },
    ]);
    expect(chat!.entries.map((entry) => [entry.label, entry.link])).toEqual([
      ["Chat", "vibestudio://c/chat/open"],
      ["Standup", "vibestudio://c/chat/open-conversation?channel=c1"],
      ["New chat", "vibestudio://c/chat/new"],
    ]);
  });

  it("finds the free-text parameter", () => {
    expect(textParamOf({ params: { a: "string", prompt: "text" } })).toBe("prompt");
    expect(textParamOf({})).toBeNull();
  });
});
