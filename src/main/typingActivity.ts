import type { Input, WebContents } from "electron";

/**
 * How long after the last typed key the user still counts as typing.
 *
 * A surface that appears on its own (an approval) must not capture keys from
 * someone mid-sentence in another view: their next Enter would accept it. This
 * window is that interaction rule, not a lifecycle bound — nothing expires or
 * fails when it elapses; the surface simply stays unfocused until asked.
 */
const TYPING_WINDOW_MS = 1_500;

/** Keys that are text entry rather than navigation or a chord. */
function isTypingInput(input: Input): boolean {
  if (input.type !== "keyDown") return false;
  if (input.control || input.meta || input.alt) return false;
  return (
    input.key.length === 1 ||
    input.key === "Enter" ||
    input.key === "Backspace" ||
    input.key === "Delete"
  );
}

/** Window-wide record of when the user last typed, across every web contents. */
export class TypingActivity {
  private lastTypedAt = Number.NEGATIVE_INFINITY;
  private readonly watched = new WeakSet<WebContents>();

  watch(contents: WebContents): void {
    if (this.watched.has(contents)) return;
    this.watched.add(contents);
    contents.on("before-input-event", (_event, input) => {
      if (isTypingInput(input)) this.lastTypedAt = performance.now();
    });
  }

  isTyping(): boolean {
    return performance.now() - this.lastTypedAt < TYPING_WINDOW_MS;
  }
}
