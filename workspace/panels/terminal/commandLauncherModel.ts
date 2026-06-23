export type CommandRunTarget = "here" | "splitRight" | "splitDown";

export function commandTargetForEnter(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">): CommandRunTarget {
  // Shift (with or without Ctrl/Cmd) splits down; any other modifier combo
  // splits right.
  if (event.shiftKey) return "splitDown";
  return "splitRight";
}

export function hasCommandTargetModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey;
}
