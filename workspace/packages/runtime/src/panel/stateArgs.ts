import { applyStateArgsSnapshot } from "@vibez1/shared/panel/applyStateArgsSnapshot";
import type { PanelSlotId } from "@vibez1/shared/panel/ids";

// Global injected by preload via --vibez1-state-args command line arg
declare global {
  interface Window {
    __vibez1StateArgs?: Record<string, unknown>;
  }
}

let selfSlotId: PanelSlotId | null = null;
let rpcCall: (<T>(service: string, method: string, args: unknown[]) => Promise<T>) | null = null;

export function _initStateArgsRuntime(
  slotId: PanelSlotId,
  call: <T>(service: string, method: string, args: unknown[]) => Promise<T>
): void {
  selfSlotId = slotId;
  rpcCall = call;
}

/**
 * Get current state args (synchronous, snapshot).
 * Returns the stateArgs that were passed when the panel was created.
 */
export function getStateArgs<T = Record<string, unknown>>(): T {
  return (window.__vibez1StateArgs ?? {}) as T;
}

/**
 * Update state args. Validates against manifest schema, persists, and triggers re-render.
 *
 * This sends the updates to the main process which:
 * 1. Merges with current stateArgs
 * 2. Validates against manifest schema
 * 3. Updates the current snapshot
 * 4. Persists to the shell-owned panel store
 * 5. Returns the authoritative snapshot, which this caller applies locally.
 *
 * Host-published runtime:stateArgsChanged events still update panels for
 * mutations made elsewhere, but the mutating panel must not depend on receiving
 * its own broadcast echo.
 */
export async function setStateArgs(updates: Record<string, unknown>): Promise<void> {
  if (!selfSlotId) {
    throw new Error("setStateArgs called before runtime initialization");
  }
  await setStateArgsForPanel(selfSlotId, updates);
}

export async function setStateArgsForPanel(
  panelId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const nextStateArgs = await setStateArgsForPanelRaw(panelId, updates);
  if (panelId === selfSlotId) {
    applyStateArgsSnapshot(nextStateArgs);
  }
}

async function setStateArgsForPanelRaw(
  panelId: string,
  updates: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!rpcCall) throw new Error("setStateArgs requires runtime initialization");
  return rpcCall<Record<string, unknown>>("main", "panelTree.setStateArgs", [panelId, updates]);
}

export async function getStateArgsForPanel<T = Record<string, unknown>>(
  panelId: string
): Promise<T> {
  if (!rpcCall) throw new Error("getStateArgsForPanel requires runtime initialization");
  return rpcCall<T>("main", "panelTree.getStateArgs", [panelId]);
}

export function _applyStateArgsFromHost(nextStateArgs: Record<string, unknown>): void {
  applyStateArgsSnapshot(nextStateArgs);
}
