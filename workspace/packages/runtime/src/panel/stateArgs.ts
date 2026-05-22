import { useState, useEffect } from "react";
import { applyStateArgsSnapshot } from "@natstack/shared/panel/applyStateArgsSnapshot";

// Global injected by preload via --natstack-state-args command line arg
declare global {
  interface Window {
    __natstackStateArgs?: Record<string, unknown>;
  }
}

let selfId: string | null = null;
let rpcCall:
  | (<T>(service: string, method: string, args: unknown[]) => Promise<T>)
  | null = null;
const shell = (globalThis as any).__natstackShell ?? (globalThis as any).__natstackElectron;

export function _initStateArgsRuntime(
  id: string,
  call: <T>(service: string, method: string, args: unknown[]) => Promise<T>
): void {
  selfId = id;
  rpcCall = call;
}

/**
 * Get current state args (synchronous, snapshot).
 * Returns the stateArgs that were passed when the panel was created.
 */
export function getStateArgs<T = Record<string, unknown>>(): T {
  return (window.__natstackStateArgs ?? {}) as T;
}

/**
 * React hook for reactive state args access.
 * Re-renders when state args change via setStateArgs().
 */
export function useStateArgs<T = Record<string, unknown>>(): T {
  const [args, setArgs] = useState<T>(() => getStateArgs<T>());

  useEffect(() => {
    const handler = (event: CustomEvent<Record<string, unknown>>) => {
      setArgs(event.detail as T);
    };
    window.addEventListener("natstack:stateArgsChanged", handler as EventListener);
    return () => window.removeEventListener("natstack:stateArgsChanged", handler as EventListener);
  }, []);

  return args;
}

/**
 * Update state args. Validates against manifest schema, persists, and triggers re-render.
 *
 * This sends the updates to the main process which:
 * 1. Merges with current stateArgs
 * 2. Validates against manifest schema
 * 3. Updates the current snapshot
 * 4. Persists to the shell-owned panel store
 * 5. Updates the local runtime snapshot and triggers useStateArgs re-render
 */
export async function setStateArgs(updates: Record<string, unknown>): Promise<void> {
  if (!selfId) {
    throw new Error("setStateArgs called before runtime initialization");
  }
  await setStateArgsForPanel(selfId, updates);
}

export async function setStateArgsForPanel(
  panelId: string,
  updates: Record<string, unknown>
): Promise<void> {
  await setStateArgsForPanelRaw(panelId, updates);
}

async function setStateArgsForPanelRaw(
  panelId: string,
  updates: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (shell?.panel?.setStateArgs) {
    return shell.panel.setStateArgs(panelId, updates) as Promise<Record<string, unknown>>;
  }
  throw new Error("setStateArgs requires a host shell bridge");
}

export async function getStateArgsForPanel<T = Record<string, unknown>>(panelId: string): Promise<T> {
  if (shell?.panel?.getStateArgs) return shell.panel.getStateArgs(panelId) as Promise<T>;
  throw new Error("getStateArgsForPanel requires a host shell bridge");
}

export function _applyStateArgsFromHost(nextStateArgs: Record<string, unknown>): void {
  applyStateArgsSnapshot(nextStateArgs);
}
