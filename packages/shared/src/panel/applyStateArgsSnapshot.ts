export function applyStateArgsSnapshot(next: Record<string, unknown>): void {
  (window as { __vibestudioStateArgs?: Record<string, unknown> }).__vibestudioStateArgs = next;
  window.dispatchEvent(new CustomEvent("vibestudio:stateArgsChanged", { detail: next }));
}
