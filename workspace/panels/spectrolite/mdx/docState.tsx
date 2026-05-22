/**
 * `useDocState(key, initial)` — the component-facing entry point for
 * persisting state into the active doc's frontmatter `state:` block.
 *
 * API mirrors `useState`:
 *
 *     const [count, setCount] = useDocState("count", 0);
 *
 * Reads come from the active doc's parsed `state.<key>` value (or
 * `initial` if absent). Writes update the in-memory map immediately (so
 * other consumers re-render via React context) and are merged back into
 * the doc's frontmatter after a short debounce by `DocumentEditor`.
 *
 * Fallback behavior: outside a `DocStateContext.Provider` (e.g. when this
 * MDX is rendered by the chat panel's `inline_ui`, or in a non-Spectrolite
 * preview environment), the hook degrades to plain `React.useState` —
 * ephemeral, but the component still works.
 */

import { createContext, useCallback, useContext, useState } from "react";

export interface DocStateContextValue {
  /** Current state map. */
  state: Record<string, unknown>;
  /** Schedule an update. The actual frontmatter rewrite is debounced. */
  setState: (key: string, value: unknown) => void;
}

export const DocStateContext = createContext<DocStateContextValue | null>(null);

export type Setter<T> = (next: T | ((prev: T) => T)) => void;

export function useDocState<T>(key: string, initial: T): [T, Setter<T>] {
  const ctx = useContext(DocStateContext);
  // Always invoke useState so the hook call order is stable across
  // renders regardless of whether a Provider is mounted.
  const [local, setLocal] = useState<T>(initial);

  const ctxSetState = ctx?.setState;
  const stored = ctx ? ctx.state[key] : undefined;
  const value = (stored === undefined ? (ctx ? initial : local) : (stored as T));

  const setValue = useCallback<Setter<T>>(
    (next) => {
      if (!ctxSetState) {
        setLocal(next as never);
        return;
      }
      const resolved = typeof next === "function"
        ? (next as (prev: T) => T)(value)
        : next;
      ctxSetState(key, resolved);
    },
    [ctxSetState, key, value],
  );

  return [value, setValue];
}
