export type CommandRunTarget = "here" | "splitRight" | "splitDown";

export function commandTargetForEnter(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">): CommandRunTarget {
  const modified = event.ctrlKey || event.metaKey;
  if (modified && event.shiftKey) return "splitDown";
  if (event.shiftKey) return "splitDown";
  return "splitRight";
}

export function hasCommandTargetModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey;
}
