import { describe, expect, it } from "vitest";
import { IntentLinkError, invokeBackgroundIntent, isClientLink, parseClientIntentLink } from "./intents.js";
import { buildHostDescriptor } from "./hostDescriptor.js";

describe("parseClientIntentLink", () => {
  it("parses the custom-scheme grammar", () => {
    expect(parseClientIntentLink("vibestudio://c/chat/open-conversation?channel=a%20b&x=1")).toEqual({
      id: "chat",
      intent: "open-conversation",
      params: { channel: "a b", x: "1" },
    });
  });

  it("parses the https grammar with a fragment", () => {
    expect(parseClientIntentLink("https://vibestudio.app/c/chat/ask#prompt=hi+there")).toEqual({
      id: "chat",
      intent: "ask",
      params: { prompt: "hi there" },
    });
  });

  it("accepts no params", () => {
    expect(parseClientIntentLink("vibestudio://c/chat/open").params).toEqual({});
  });

  it.each([
    ["vibestudio://panel/foo", "not-client-link"],
    ["https://example.com/c/chat/open", "not-client-link"],
    ["vibestudio://c/chat", "malformed-link"],
    ["vibestudio://c/chat/open/extra", "malformed-link"],
    ["vibestudio://c/Chat/open", "invalid-client-id"],
    ["vibestudio://c//open", "invalid-client-id"],
    ["vibestudio://c/chat/Open", "invalid-intent"],
    ["vibestudio://c/chat/open?a=1&a=2", "invalid-params"],
    ["vibestudio://c/chat/open?a=%E0%A4%A", "invalid-params"],
  ])("rejects %s", (link, code) => {
    try {
      parseClientIntentLink(link);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(IntentLinkError);
      expect((error as IntentLinkError).code).toBe(code);
    }
  });

  it("recognises client links that are malformed", () => {
    expect(isClientLink("vibestudio://c/chat")).toBe(true);
    expect(isClientLink("vibestudio://pair?x=1")).toBe(false);
  });
});

describe("invokeBackgroundIntent", () => {
  it("calls clients.invokeIntent with the host descriptor", async () => {
    const descriptor = buildHostDescriptor({ host: "terminal", hostVersion: "1", implemented: ["notifications"] });
    const calls: unknown[][] = [];
    const result = await invokeBackgroundIntent(
      async (service, method, args) => {
        calls.push([service, method, ...args]);
        return { text: "pong" };
      },
      descriptor,
      { id: "chat", intent: "ask", params: { prompt: "ping" } }
    );
    expect(result).toEqual({ text: "pong" });
    expect(calls[0]).toEqual([
      "clients",
      "invokeIntent",
      descriptor,
      { id: "chat", intent: "ask", params: { prompt: "ping" } },
    ]);
  });
});
