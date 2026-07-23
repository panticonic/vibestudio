/**
 * Schedule auxiliary panel work after primary rendering and lifecycle effects.
 *
 * Chromium provides requestIdleCallback in every Vibestudio panel host. The
 * timer fallback preserves the same "next task" boundary in tests and other
 * DOM-compatible hosts. The timeout guarantees eventual progress on a busy
 * panel after its startup work has still had ample time to dispatch.
 */
export function scheduleBackgroundWork(work: () => void): () => void {
  const requestIdle = globalThis.requestIdleCallback;
  const cancelIdle = globalThis.cancelIdleCallback;
  if (typeof requestIdle === "function" && typeof cancelIdle === "function") {
    const handle = requestIdle(() => work(), { timeout: 1_000 });
    return () => cancelIdle(handle);
  }

  const handle = globalThis.setTimeout(work, 0);
  return () => globalThis.clearTimeout(handle);
}
