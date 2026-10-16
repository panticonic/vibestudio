import { describe, expect, it } from "vitest";
import { parseClientIntentLink } from "@vibestudio/client-host-core";
import type { ClientIntentDecl } from "@vibestudio/workspace-contracts/clients";
import {
  clientIntentLink,
  isForegroundIntent,
  mimeAccepted,
  pickBackgroundIntent,
  pickShareTarget,
  pinnableShortcuts,
  textParamOf,
  type ListedClient,
} from "./integration";

const share: ClientIntentDecl = {
  name: "share",
  kind: "foreground",
  params: { text: "text" },
  accepts: ["text/*"],
};
const ask: ClientIntentDecl = {
  name: "ask",
  kind: "background",
  params: { text: "text" },
  handler: "vibestudio.quickfire.v1#ask",
};
const openConversation: ClientIntentDecl = {
  name: "open-conversation",
  kind: "foreground",
  params: { conversation: "string" },
};

const chat: ListedClient = {
  id: "chat",
  runtime: "react-native",
  isDefault: false,
  intents: [openConversation, share, ask],
};
const browser: ListedClient = {
  id: "browser",
  runtime: "react-native",
  isDefault: true,
  intents: [{ name: "open-panel", kind: "foreground", params: { panel: "string" } }],
};

describe("clientIntentLink", () => {
  it("round-trips through the host's own link parser, whatever the params hold", () => {
    const params = { conversation: "a b&c=d/é", empty: "" };
    const link = clientIntentLink("chat", "open-conversation", params);
    expect(link.startsWith("vibestudio://c/chat/open-conversation?")).toBe(true);
    expect(parseClientIntentLink(link)).toEqual({ id: "chat", intent: "open-conversation", params });
  });

  it("omits the query when there are no params", () => {
    expect(clientIntentLink("chat", "open")).toBe("vibestudio://c/chat/open");
  });
});

describe("mimeAccepted", () => {
  it("matches exact types, type wildcards and anything, ignoring case and parameters", () => {
    expect(mimeAccepted(["text/*"], "text/plain")).toBe(true);
    expect(mimeAccepted(["text/*"], "TEXT/Plain; charset=utf-8")).toBe(true);
    expect(mimeAccepted(["text/plain"], "text/html")).toBe(false);
    expect(mimeAccepted(["application/pdf"], "application/pdf")).toBe(true);
    expect(mimeAccepted(["*/*"], "image/png")).toBe(true);
    expect(mimeAccepted(["text/*"], "image/png")).toBe(false);
    expect(mimeAccepted(["text/*"], "textual/plain")).toBe(false);
  });

  it("accepts nothing for a malformed type", () => {
    expect(mimeAccepted(["*/*"], "plain")).toBe(false);
    expect(mimeAccepted([], "text/plain")).toBe(false);
  });
});

describe("pickShareTarget", () => {
  it("picks the client whose foreground intent accepts the type and names the text param", () => {
    expect(pickShareTarget([browser, chat], "text/plain")).toEqual({
      id: "chat",
      intent: "share",
      textParam: "text",
    });
  });

  it("finds nothing for a type no intent accepts, a background intent, or a missing text param", () => {
    expect(pickShareTarget([browser, chat], "image/png")).toBeNull();
    const background: ListedClient = {
      ...chat,
      intents: [{ ...share, kind: "background", handler: "p#m" }],
    };
    expect(pickShareTarget([background], "text/plain")).toBeNull();
    const noText: ListedClient = {
      ...chat,
      intents: [{ name: "share", kind: "foreground", accepts: ["text/*"] }],
    };
    expect(pickShareTarget([noText], "text/plain")).toBeNull();
  });

  it("prefers the default client among several, and skips clients this host cannot run", () => {
    const other: ListedClient = { ...chat, id: "notes", isDefault: true };
    expect(pickShareTarget([chat, other], "text/plain")?.id).toBe("notes");
    expect(
      pickShareTarget([{ ...other, unavailableReason: "needs a capability" }, chat], "text/plain")?.id
    ).toBe("chat");
    expect(pickShareTarget([{ ...chat, runtime: "terminal" }], "text/plain")).toBeNull();
  });
});

describe("pickBackgroundIntent", () => {
  it("finds the client declaring the background intent, never a foreground one of that name", () => {
    expect(pickBackgroundIntent([browser, chat], "ask")).toEqual({ id: "chat", intent: ask });
    expect(pickBackgroundIntent([browser, chat], "share")).toBeNull();
    expect(pickBackgroundIntent([browser], "ask")).toBeNull();
  });
});

describe("textParamOf", () => {
  it("names the first free-text parameter", () => {
    expect(textParamOf(ask)).toBe("text");
    expect(textParamOf(openConversation)).toBeNull();
    expect(textParamOf({})).toBeNull();
  });
});

describe("isForegroundIntent", () => {
  it("allows the implicit open and declared foreground intents, not background or unknown ones", () => {
    expect(isForegroundIntent(chat, "open")).toBe(true);
    expect(isForegroundIntent(chat, "open-conversation")).toBe(true);
    expect(isForegroundIntent(chat, "ask")).toBe(false);
    expect(isForegroundIntent(chat, "nope")).toBe(false);
  });
});

describe("pinnableShortcuts", () => {
  const snapshot = [
    {
      id: "chat",
      title: "Chat",
      intents: [openConversation, share, ask],
      entries: {},
    },
    {
      id: "notes",
      title: "Notes",
      intents: [
        { name: "new-note", kind: "foreground", title: "New note" },
        { name: "open-note", kind: "foreground", params: { note: "string" }, dynamic: "p#recent" },
      ] satisfies ClientIntentDecl[],
      entries: {
        "open-note": [
          { title: "Groceries", params: { note: "n1" } },
          { title: "Ideas", params: { note: "n 2" } },
        ],
      },
    },
  ];

  it("offers each client's open, its parameterless intents and its dynamic entries", () => {
    const pinnable = pinnableShortcuts(snapshot);
    expect(pinnable.map(({ clientId, label, link }) => ({ clientId, label, link }))).toEqual([
      { clientId: "chat", label: "Chat", link: "vibestudio://c/chat/open" },
      { clientId: "notes", label: "Notes", link: "vibestudio://c/notes/open" },
      { clientId: "notes", label: "Notes: New note", link: "vibestudio://c/notes/new-note" },
      { clientId: "notes", label: "Groceries", link: "vibestudio://c/notes/open-note?note=n1" },
      { clientId: "notes", label: "Ideas", link: "vibestudio://c/notes/open-note?note=n%202" },
    ]);
  });

  it("never offers share-in, background or parameterized-without-entries intents", () => {
    const links = pinnableShortcuts(snapshot).map((entry) => entry.link);
    expect(links.some((link) => link.includes("/share"))).toBe(false);
    expect(links.some((link) => link.includes("/ask"))).toBe(false);
    expect(links.some((link) => link.includes("/open-conversation"))).toBe(false);
  });

  it("gives each shortcut a distinct stable id, so pinning twice updates rather than duplicates", () => {
    const ids = pinnableShortcuts(snapshot).map((entry) => entry.shortcutId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pinnableShortcuts(snapshot).map((entry) => entry.shortcutId)).toEqual(ids);
  });
});
