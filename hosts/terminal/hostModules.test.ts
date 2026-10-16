import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientStatePath,
  createClientState,
  createClipboard,
  createNotifier,
  detectNotificationProtocol,
} from "./hostModules.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("clipboard", () => {
  it("writes OSC 52 so clients need not hand-roll the escape", () => {
    const write = vi.fn();
    createClipboard({ write }).write("héllo");
    expect(write).toHaveBeenCalledWith(`\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`);
  });

  it("refuses text a terminal would silently truncate", () => {
    expect(() => createClipboard({ write: vi.fn() }).write("x".repeat(100_001))).toThrow(
      "too much"
    );
  });
});

describe("notifications", () => {
  it("chooses the escape the terminal understands, and the bell otherwise", () => {
    expect(detectNotificationProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
    expect(detectNotificationProtocol({ KITTY_WINDOW_ID: "1" })).toBe("osc99");
    expect(detectNotificationProtocol({ TERM: "xterm-kitty" })).toBe("osc99");
    expect(detectNotificationProtocol({ TERM_PROGRAM: "WezTerm" })).toBe("osc777");
    expect(detectNotificationProtocol({ TERM_PROGRAM: "ghostty" })).toBe("osc777");
    expect(detectNotificationProtocol({ TERM: "foot" })).toBe("osc777");
    expect(detectNotificationProtocol({ TERM: "xterm-256color" })).toBe("bell");
    // A multiplexer swallows the escapes.
    expect(detectNotificationProtocol({ TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux" })).toBe(
      "bell"
    );
  });

  it("writes each protocol's form and strips what could break out of it", () => {
    const write = vi.fn();
    createNotifier({ write }, "osc9").notify({ title: "Chat", body: "a;b\x1b]0;x" });
    expect(write).toHaveBeenLastCalledWith("\x1b]9;Chat: a b ]0 x\x07");
    createNotifier({ write }, "osc777").notify({ title: "Chat", body: "done" });
    expect(write).toHaveBeenLastCalledWith("\x1b]777;notify;Chat;done\x07");
    createNotifier({ write }, "osc99").notify({ title: "Chat", body: "done" });
    expect(write).toHaveBeenLastCalledWith(
      "\x1b]99;i=1:d=0:p=title;Chat\x1b\\\x1b]99;i=1:d=1:p=body;done\x1b\\"
    );
    createNotifier({ write }, "bell").notify({ title: "Chat" });
    expect(write).toHaveBeenLastCalledWith("\x07");
  });
});

describe("client state", () => {
  function root(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-state-test-"));
    roots.push(dir);
    return dir;
  }

  it("persists settings per client, privately", async () => {
    const dir = root();
    const state = createClientState("browser", dir);
    expect(await state.get()).toEqual({});
    await state.set({ prefixKey: "C-b", bell: true });
    expect(await createClientState("browser", dir).get()).toEqual({ prefixKey: "C-b", bell: true });
    expect(await createClientState("chat", dir).get()).toEqual({});
    expect(fs.statSync(clientStatePath("browser", dir)).mode & 0o777).toBe(0o600);
  });

  it("replaces the whole object and refuses what is not one", async () => {
    const dir = root();
    const state = createClientState("browser", dir);
    await state.set({ a: 1 });
    await state.set({ b: 2 });
    expect(await state.get()).toEqual({ b: 2 });
    await expect(state.set([] as never)).rejects.toThrow("JSON object");
    await expect(state.set({ big: "x".repeat(70_000) })).rejects.toThrow("limited");
  });
});
