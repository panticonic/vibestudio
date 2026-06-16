/**
 * `useDocState(key, initial)` — per-viewer component state for inline JSX
 * (slider positions, toggles, counters), backed by the {@link ViewStateStore}.
 *
 * API mirrors `useState`:
 *
 *     const [count, setCount] = useDocState("count", 0);
 *
 * Under the GAD-native rewrite this state is PRIVATE per viewer and lives
 * OUTSIDE the co-edited document — it is keyed by the active doc's vcs path in
 * a panel-local store (see `coedit/viewState.ts`), never written into the
 * worktree, so nudging a slider never produces a commit or notifies the scribe.
 * The old `state:` frontmatter round-trip is gone.
 *
 * `DocumentEditor` mounts a {@link DocStateContext.Provider} carrying the store
 * + the active doc path. Outside a provider (e.g. the chat panel's `inline_ui`)
 * the hook degrades to plain `React.useState` — ephemeral, but still works.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ViewStateStore } from "../coedit/viewState";

export type DocStateUpdate = unknown | ((prev: unknown) => unknown);

export interface DocStateContextValue {
  /** The panel-local view-state store (scoped to the vault by partition). */
  store: ViewStateStore;
  /** The active document's vcs path (the store key). */
  path: string;
}

export const DocStateContext = createContext<DocStateContextValue | null>(null);

export type Setter<T> = (next: T | ((prev: T) => T)) => void;

export function useDocState<T>(key: string, initial: T): [T, Setter<T>] {
  const ctx = useContext(DocStateContext);
  // Always invoke useState so hook call order is stable regardless of whether
  // a Provider is mounted (fallback path for non-Spectrolite hosts).
  const [local, setLocal] = useState<T>(initial);
  // Re-render when the store entry for this path changes (another consumer
  // updated the same key, or a migration seeded it).
  const [, bump] = useState(0);

  const store = ctx?.store ?? null;
  const path = ctx?.path ?? null;

  useEffect(() => {
    if (!store || path === null) return;
    return store.subscribe(path, () => bump((n) => n + 1));
  }, [store, path]);

  const value = store && path !== null ? store.get(path, key, initial) : local;

  const setValue = useCallback<Setter<T>>(
    (next) => {
      if (!store || path === null) {
        setLocal(next as never);
        return;
      }
      const resolved = typeof next === "function"
        ? (next as (prev: T) => T)(store.get(path, key, initial))
        : next;
      store.set(path, key, resolved);
    },
    [store, path, key, initial],
  );

  return [value, setValue];
}
