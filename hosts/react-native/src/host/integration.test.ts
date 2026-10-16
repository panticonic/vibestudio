import { describe, expect, it } from "vitest";
import { textParamOf } from "@vibestudio/client-host-core";
import type { ClientIntentDecl } from "@vibestudio/workspace-contracts/clients";
import {
  isForegroundIntent,
  mimeAccepted,
  pickBackgroundIntent,
  pickShareTarget,
  launchSurfaces,
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

describe("isForegroundIntent", () => {
  it("allows the implicit open and declared foreground intents, not background or unknown ones", () => {
    expect(isForegroundIntent(chat, "open")).toBe(true);
    expect(isForegroundIntent(chat, "open-conversation")).toBe(true);
    expect(isForegroundIntent(chat, "ask")).toBe(false);
    expect(isForegroundIntent(chat, "nope")).toBe(false);
  });
});

describe("launchSurfaces", () => {
  const snapshot = [
    { id: "chat", title: "Chat", intents: [openConversation, share, ask], entries: {} },
    {
      id: "notes",
      title: "Notes",
      intents: [
        { name: "new-note", kind: "foreground", title: "New note" },
        { name: "open-note", kind: "foreground", params: { note: "string" }, dynamic: "p#recent" },
        { name: "find", kind: "background", title: "Find", params: { query: "text" }, handler: "p#find" },
      ] satisfies ClientIntentDecl[],
      entries: { "open-note": [{ title: "Groceries", params: { note: "n1" } }] },
    },
  ];

  it("separates plain shortcuts from dynamic entries, per client", () => {
    const { clients } = launchSurfaces(snapshot);
    expect(clients.map((client) => client.clientId)).toEqual(["chat", "notes"]);
    const notes = clients[1]!;
    expect(notes.shortcuts.map((item) => item.link)).toEqual([
      "vibestudio://c/notes/open",
      "vibestudio://c/notes/new-note",
    ]);
    expect(notes.recent).toEqual([
      { intent: "open-note", label: "Groceries", link: "vibestudio://c/notes/open-note?note=n1" },
    ]);
    expect(clients[0]!.recent).toEqual([]);
  });

  it("lists the free-text background intents and the intents that accept shared items", () => {
    const { background, shareIn } = launchSurfaces(snapshot);
    expect(background).toEqual([
      { clientId: "chat", clientTitle: "Chat", intent: "ask", title: "ask", textParam: "text" },
      { clientId: "notes", clientTitle: "Notes", intent: "find", title: "Find", textParam: "query" },
    ]);
    expect(shareIn).toEqual([
      { clientId: "chat", clientTitle: "Chat", intent: "share", textParam: "text", accepts: ["text/*"] },
    ]);
  });
});
