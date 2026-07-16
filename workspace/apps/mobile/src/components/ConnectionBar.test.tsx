import React from "react";
import { Alert } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import { ConnectionBar } from "./ConnectionBar";
import { connectionStatusAtom, networkReachableAtom } from "../state/connectionAtoms";
import { shellClientAtom } from "../state/shellClientAtom";

type AlertButton = { text?: string; onPress?: () => void };

describe("ConnectionBar", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runAllTimers();
    });
    jest.useRealTimers();
  });

  it("offers reconnect and re-pair when disconnected", () => {
    const reconnect = jest.fn();
    const onRepair = jest.fn();
    const store = createStore();
    store.set(connectionStatusAtom, "disconnected");
    store.set(shellClientAtom, {
      transport: { reconnect, onReconnectProgress: () => jest.fn() },
    } as never);

    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);

    const { getByRole } = render(
      <Provider store={store}>
        <ConnectionBar onRepair={onRepair} />
      </Provider>
    );

    act(() => {
      jest.runAllTimers();
    });

    fireEvent.press(getByRole("button"));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as AlertButton[];
    expect(buttons.map((button) => button.text)).toEqual(["Reconnect", "Re-pair device", "Cancel"]);

    buttons.find((button) => button.text === "Reconnect")?.onPress?.();
    expect(reconnect).toHaveBeenCalledTimes(1);

    buttons.find((button) => button.text === "Re-pair device")?.onPress?.();
    expect(onRepair).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
  });

  it("omits re-pair and offers only reconnect when disconnected and offline", () => {
    const store = createStore();
    store.set(connectionStatusAtom, "disconnected");
    store.set(networkReachableAtom, false);

    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);

    const { getByRole } = render(
      <Provider store={store}>
        <ConnectionBar />
      </Provider>
    );

    act(() => {
      jest.runAllTimers();
    });

    // Offline forces the actionable state even if the transport reports connected.
    fireEvent.press(getByRole("button"));
    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as AlertButton[];
    expect(buttons.map((button) => button.text)).toEqual(["Reconnect", "Cancel"]);

    alertSpy.mockRestore();
  });

  it("stays actionable and shows reconnect attempt progress while connecting", () => {
    const store = createStore();
    let progress: ((value: { attempt: number }) => void) | undefined;
    store.set(connectionStatusAtom, "connected");
    store.set(shellClientAtom, {
      transport: {
        reconnect: jest.fn(),
        onReconnectProgress: (listener: (value: { attempt: number }) => void) => {
          progress = listener;
          return jest.fn();
        },
      },
    } as never);

    const view = render(
      <Provider store={store}>
        <ConnectionBar onRepair={jest.fn()} />
      </Provider>
    );
    act(() => {
      store.set(connectionStatusAtom, "connecting");
      progress?.({ attempt: 3 });
    });

    expect(view.getByRole("button")).toBeTruthy();
    expect(view.getByText(/attempt 3/i)).toBeTruthy();
  });

  it("treats a live pipe as connected even when NetInfo reports no internet (LAN-only)", () => {
    // A home server on Wi-Fi without internet is reachable over the WebRTC pipe:
    // a connected status must NOT be overridden with a red "No network" bar.
    const store = createStore();
    store.set(connectionStatusAtom, "connected");
    store.set(networkReachableAtom, false);

    const { queryByRole } = render(
      <Provider store={store}>
        <ConnectionBar />
      </Provider>
    );

    // Connected ⇒ not a problem ⇒ not actionable, regardless of NetInfo.
    expect(queryByRole("button")).toBeNull();
  });

  it("is not interactive when connected and online", () => {
    const store = createStore();
    store.set(connectionStatusAtom, "connected");
    store.set(networkReachableAtom, true);

    const { queryByRole } = render(
      <Provider store={store}>
        <ConnectionBar />
      </Provider>
    );

    act(() => {
      jest.runAllTimers();
    });

    expect(queryByRole("button")).toBeNull();
  });
});
