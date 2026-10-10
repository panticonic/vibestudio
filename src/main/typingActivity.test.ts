import { afterEach, describe, expect, it, vi } from "vitest";
import type { Input, WebContents } from "electron";
import { TypingActivity } from "./typingActivity.js";

function contents() {
  const listeners: Array<(event: unknown, input: Input) => void> = [];
  const wc = {
    on: (_name: string, listener: (event: unknown, input: Input) => void) =>
      listeners.push(listener),
  } as unknown as WebContents;
  return { wc, press: (input: Partial<Input>) => listeners.forEach((l) => l({}, input as Input)) };
}

describe("TypingActivity", () => {
  afterEach(() => vi.useRealTimers());

  it("counts text entry as typing until the window passes", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const typing = new TypingActivity();
    const { wc, press } = contents();
    typing.watch(wc);
    expect(typing.isTyping()).toBe(false);

    press({ type: "keyDown", key: "a" });
    expect(typing.isTyping()).toBe(true);
    vi.advanceTimersByTime(1_500);
    expect(typing.isTyping()).toBe(false);

    press({ type: "keyDown", key: "Enter" });
    expect(typing.isTyping()).toBe(true);
  });

  it("does not count chords, navigation, or key releases as typing", () => {
    const typing = new TypingActivity();
    const { wc, press } = contents();
    typing.watch(wc);
    press({ type: "keyDown", key: "A", control: true, shift: true });
    press({ type: "keyDown", key: "k", meta: true });
    press({ type: "keyDown", key: "ArrowDown" });
    press({ type: "keyUp", key: "a" });
    expect(typing.isTyping()).toBe(false);
  });
});
