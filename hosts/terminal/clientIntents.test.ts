import { describe, expect, it, vi } from "vitest";
import type { ClientIntentDecl } from "@vibestudio/workspace-contracts/clients";
import {
  buildIntentParams,
  parseParamFlags,
  resolveIntent,
  runBackgroundIntent,
} from "./clientIntents.js";

const ask: ClientIntentDecl = {
  name: "ask",
  kind: "background",
  params: { prompt: "text" },
  handler: "vibestudio.channel.v1#ask",
  result: "text-stream",
};
const echo: ClientIntentDecl = {
  name: "echo",
  kind: "background",
  params: { a: "text", b: "text" },
};
const open: ClientIntentDecl = { name: "open", kind: "foreground" };
const listing = { id: "chat", intents: [open, ask, echo] };

describe("intent selection", () => {
  it("defaults to the implicit open and names what a client declares otherwise", () => {
    expect(resolveIntent(listing, undefined).name).toBe("open");
    expect(resolveIntent(listing, "ask")).toBe(ask);
    expect(() => resolveIntent(listing, "nope")).toThrow(/no intent "nope".*open, ask, echo/);
  });

  it("parses --param pairs and refuses repeats and malformed pairs", () => {
    expect(parseParamFlags(["a=1", "b=x=y"])).toEqual({ a: "1", b: "x=y" });
    expect(() => parseParamFlags(["a=1", "a=2"])).toThrow("more than once");
    expect(() => parseParamFlags(["novalue"])).toThrow("key=value");
  });
});

describe("intent parameters", () => {
  it("makes piped input the text parameter, after the words", () => {
    expect(
      buildIntentParams(ask, { flagParams: {}, words: ["review", "this"], stdin: "diff body\n" })
    ).toEqual({ prompt: "review this\n\ndiff body" });
    expect(buildIntentParams(ask, { flagParams: {}, words: [], stdin: "hi\n" })).toEqual({
      prompt: "hi",
    });
  });

  it("passes explicit parameters through and rejects ones the intent does not declare", () => {
    expect(
      buildIntentParams(ask, { flagParams: { prompt: "hello" }, words: [], stdin: null })
    ).toEqual({
      prompt: "hello",
    });
    expect(() =>
      buildIntentParams(ask, { flagParams: { nope: "x" }, words: [], stdin: null })
    ).toThrow(/no parameter "nope".*prompt/);
  });

  it("errors clearly when the text has no single text parameter to go to", () => {
    expect(() => buildIntentParams(echo, { flagParams: {}, words: [], stdin: "hi" })).toThrow(
      /several text parameters \(a, b\)/
    );
    expect(() => buildIntentParams(open, { flagParams: {}, words: ["x"], stdin: null })).toThrow(
      /takes no text/
    );
  });

  it("refuses text given both as a parameter and as words", () => {
    expect(() =>
      buildIntentParams(ask, { flagParams: { prompt: "a" }, words: ["b"], stdin: null })
    ).toThrow(/use one/);
  });
});

describe("background intents", () => {
  const descriptor = {
    host: "terminal",
    hostVersion: "1",
    runtimes: {},
    capabilities: [],
  } as never;

  it("runs server-side and prints the text result, loading no client", async () => {
    const call = vi.fn(async () => ({ text: "pong" }));
    const out: string[] = [];
    await runBackgroundIntent({
      call,
      descriptor,
      clientId: "chat",
      decl: { name: "echo", kind: "background", result: "text" },
      params: { a: "x" },
      stdout: { write: (text: string) => (out.push(text), true) },
      followStream: vi.fn(),
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("clients", "invokeIntent", [
      descriptor,
      { id: "chat", intent: "echo", params: { a: "x" } },
    ]);
    expect(out).toEqual(["pong\n"]);
  });

  it("hands a text-stream result's channel to the channel reader", async () => {
    const call = vi.fn(async () => ({ stream: { channelId: "ch-1" } }));
    const followStream = vi.fn(async () => undefined);
    const out: string[] = [];
    await runBackgroundIntent({
      call,
      descriptor,
      clientId: "chat",
      decl: ask,
      params: { prompt: "hi" },
      stdout: { write: (text: string) => (out.push(text), true) },
      followStream,
    });
    expect(followStream).toHaveBeenCalledWith("ch-1");
    expect(out).toEqual([]);
  });
});
