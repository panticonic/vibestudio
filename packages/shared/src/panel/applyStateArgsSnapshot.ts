export function applyStateArgsSnapshot(next: Record<string, unknown>): void {
  (window as { __vibez1StateArgs?: Record<string, unknown> }).__vibez1StateArgs = next;
  window.dispatchEvent(new CustomEvent("vibez1:stateArgsChanged", { detail: next }));
}
