import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import { Toast } from "./Toast";
import { toastQueueAtom } from "../state/toastAtoms";

describe("Toast", () => {
  beforeEach(() => jest.useFakeTimers());

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
  });

  it("runs a visible action and dismisses the result", () => {
    const onAction = jest.fn();
    const store = createStore();
    store.set(toastQueueAtom, [
      {
        id: "installed",
        createdAt: 1,
        title: "Task Board updated",
        message: "Task Board",
        tone: "success",
        durationMs: 8_000,
        actionLabel: "Open Task Board",
        onAction,
      },
    ]);
    const view = render(
      <Provider store={store}>
        <Toast />
      </Provider>
    );

    fireEvent.press(view.getByRole("button", { name: /Open Task Board/u }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(store.get(toastQueueAtom)).toEqual([]);
  });

  it("auto-dismisses transient results but keeps duration-zero failures", () => {
    const store = createStore();
    store.set(toastQueueAtom, [
      {
        id: "success",
        createdAt: 1,
        title: "Task Board updated",
        message: "Task Board",
        durationMs: 8_000,
      },
      {
        id: "failure",
        createdAt: 2,
        title: "Task Board could not be updated",
        message: "Build failed",
        tone: "danger",
        durationMs: 0,
      },
    ]);
    render(
      <Provider store={store}>
        <Toast />
      </Provider>
    );

    act(() => jest.advanceTimersByTime(8_000));

    expect(store.get(toastQueueAtom).map((toast) => toast.id)).toEqual(["failure"]);
  });
});
