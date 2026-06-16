/**
 * Minimal external store for the Spectrolite panel.
 *
 * Why not plain React state: the panel mixes long-lived imperative
 * machinery (PubSub client, flush controller, agent bootstrap) with UI.
 * Effect-chain orchestration of that machinery is what made the old
 * Workspace component fragile — controllers now own the lifecycle and
 * write results into this store; components subscribe to exactly the
 * slice they render via `useStoreState`, so a keystroke that updates one
 * buffer no longer re-renders the whole shell.
 *
 * Updates must be immutable (replace objects/arrays, never mutate) —
 * selector results are compared with Object.is to decide re-renders.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";

export interface Store<T> {
  getState(): T;
  /** Shallow-merge a partial update (or updater returning one). No-op merges still notify only when a key actually changed. */
  setState(update: Partial<T> | ((prev: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState(update) {
      const partial = typeof update === "function" ? update(state) : update;
      let changed = false;
      for (const key of Object.keys(partial) as Array<keyof T>) {
        if (!Object.is(state[key], partial[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...partial };
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Subscribe to a derived slice of the store. The component re-renders
 * only when `selector(state)` changes by Object.is — select primitives
 * or state-owned references when possible. The selected snapshot is cached
 * per store state so React never sees a new value for an unchanged state.
 */
export function useStoreState<T extends object, U>(store: Store<T>, selector: (state: T) => U): U {
  const selectorRef = useRef(selector);
  const snapshotRef = useRef<{ state: T; selector: (state: T) => U; selected: U } | null>(null);
  selectorRef.current = selector;

  const getSelectedSnapshot = useCallback(() => {
    const state = store.getState();
    const currentSelector = selectorRef.current;
    const cached = snapshotRef.current;
    if (cached && Object.is(cached.state, state) && cached.selector === currentSelector) {
      return cached.selected;
    }
    const selected = currentSelector(state);
    snapshotRef.current = { state, selector: currentSelector, selected };
    return selected;
  }, [store]);

  return useSyncExternalStore(
    store.subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot,
  );
}
