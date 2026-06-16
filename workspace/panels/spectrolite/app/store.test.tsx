// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createStore, useStoreState } from "./store";

describe("useStoreState", () => {
  it("caches derived object snapshots while state and selector are unchanged", () => {
    const store = createStore({ count: 1 });
    const selectDebugState = (state: { count: number }) => ({ count: state.count });

    const { result, rerender } = renderHook(() => useStoreState(store, selectDebugState));
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });

  it("tolerates inline selectors that derive objects", () => {
    const store = createStore({ count: 1 });

    const { result } = renderHook(() => useStoreState(store, (state) => ({ count: state.count })));

    expect(result.current).toEqual({ count: 1 });
  });

  it("does not rerender when a selected primitive is unchanged", () => {
    const store = createStore({ count: 1, other: 1 });
    let renders = 0;

    const { result } = renderHook(() => {
      renders += 1;
      return useStoreState(store, (state) => state.count);
    });

    expect(result.current).toBe(1);
    expect(renders).toBe(1);

    act(() => store.setState({ other: 2 }));

    expect(result.current).toBe(1);
    expect(renders).toBe(1);

    act(() => store.setState({ count: 2 }));

    expect(result.current).toBe(2);
    expect(renders).toBe(2);
  });
});
