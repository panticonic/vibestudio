// @vitest-environment jsdom

import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelSurface } from "./PanelSurface";

const shellClient = vi.hoisted(() => ({
  bindNativePanelSlot: vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve()),
  updateNativePanelSlot: vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve()),
  clearNativePanelSlot: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("../shell/client", () => ({
  nativeSlotRendererInstanceId: "renderer-test",
  nextNativeSlotBindingSequence: (() => {
    let sequence = 0;
    return () => ++sequence;
  })(),
  view: {
    bindNativePanelSlot: shellClient.bindNativePanelSlot,
    updateNativePanelSlot: shellClient.updateNativePanelSlot,
    clearNativePanelSlot: shellClient.clearNativePanelSlot,
  },
}));

describe("PanelSurface", () => {
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    shellClient.bindNativePanelSlot.mockReset();
    shellClient.bindNativePanelSlot.mockResolvedValue({ status: "bound" });
    shellClient.updateNativePanelSlot.mockReset();
    shellClient.updateNativePanelSlot.mockResolvedValue({ status: "updated" });
    shellClient.clearNativePanelSlot.mockReset();
    shellClient.clearNativePanelSlot.mockResolvedValue(undefined);
    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      right: 420,
      bottom: 330,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    })) as typeof HTMLElement.prototype.getBoundingClientRect;
    window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(Date.now()), 0);
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn((id: number) => {
      window.clearTimeout(id);
    }) as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    vi.useRealTimers();
  });

  it("claims its initial slot without waiting for an animation frame", () => {
    window.requestAnimationFrame = vi.fn(() => 1);

    render(<PanelSurface nativeSlotId="slot-1" panelId="panel-1" focused />);

    expect(shellClient.bindNativePanelSlot).toHaveBeenCalledWith({
      nativeSlotId: "slot-1",
      rendererInstanceId: "renderer-test",
      bindingId: expect.any(String),
      bindingSequence: expect.any(Number),
      operationSequence: expect.any(Number),
      panelId: "panel-1",
      focused: true,
      bounds: { x: 20, y: 30, width: 400, height: 300 },
    });
  });

  it("updates focus without rebinding the declaration", async () => {
    const { rerender } = render(
      <PanelSurface nativeSlotId="slot-1" panelId="panel-1" focused={false} />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(shellClient.bindNativePanelSlot).toHaveBeenCalledTimes(1);

    rerender(<PanelSurface nativeSlotId="slot-1" panelId="panel-1" focused />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(shellClient.updateNativePanelSlot).toHaveBeenCalledWith({
      nativeSlotId: "slot-1",
      rendererInstanceId: "renderer-test",
      bindingId: expect.any(String),
      bindingSequence: expect.any(Number),
      operationSequence: expect.any(Number),
      focused: true,
    });

    expect(shellClient.bindNativePanelSlot).toHaveBeenCalledTimes(1);
  });

  it("resyncs geometry when the layout epoch changes", async () => {
    const { rerender } = render(
      <PanelSurface nativeSlotId="slot-1" panelId="panel-1" layoutEpoch={1} focused />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(shellClient.bindNativePanelSlot).toHaveBeenCalledTimes(1);

    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 40,
      y: 50,
      left: 40,
      top: 50,
      right: 440,
      bottom: 350,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    })) as typeof HTMLElement.prototype.getBoundingClientRect;
    rerender(<PanelSurface nativeSlotId="slot-1" panelId="panel-1" layoutEpoch={2} focused />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(shellClient.bindNativePanelSlot).toHaveBeenCalledTimes(1);
    expect(shellClient.updateNativePanelSlot).toHaveBeenCalledWith(
      expect.objectContaining({ bounds: { x: 40, y: 50, width: 400, height: 300 } })
    );
  });

  it("releases a pending bind and ignores its late completion after unmount", async () => {
    let resolveBind: ((result: { status: "bound" }) => void) | undefined;
    shellClient.bindNativePanelSlot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBind = resolve as (result: { status: "bound" }) => void;
        })
    );

    const { unmount } = render(<PanelSurface nativeSlotId="slot-1" panelId="panel-1" focused />);
    const bindRequest = shellClient.bindNativePanelSlot.mock.calls[0]?.[0] as {
      bindingSequence: number;
      operationSequence: number;
    };

    unmount();

    const clearRequest = shellClient.clearNativePanelSlot.mock.calls[0]?.[0] as {
      nativeSlotId: string;
      bindingSequence: number;
      operationSequence: number;
    };
    expect(clearRequest.nativeSlotId).toBe("slot-1");
    expect(clearRequest.bindingSequence).toBe(bindRequest.bindingSequence);
    expect(clearRequest.operationSequence).toBeGreaterThan(bindRequest.operationSequence);

    await act(async () => {
      resolveBind?.({ status: "bound" });
      await vi.runAllTimersAsync();
    });
    expect(shellClient.bindNativePanelSlot).toHaveBeenCalledTimes(1);
  });

  it("publishes focus changes even while the declaration response is pending", async () => {
    let resolveBind: ((result: { status: "bound" }) => void) | undefined;
    shellClient.bindNativePanelSlot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBind = resolve as (result: { status: "bound" }) => void;
        })
    );
    const { rerender } = render(
      <PanelSurface nativeSlotId="slot-1" panelId="panel-1" focused={false} />
    );

    rerender(<PanelSurface nativeSlotId="slot-1" panelId="panel-1" focused />);
    expect(shellClient.updateNativePanelSlot).toHaveBeenCalledWith(
      expect.objectContaining({ focused: true })
    );

    await act(async () => {
      resolveBind?.({ status: "bound" });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(shellClient.bindNativePanelSlot).toHaveBeenCalledTimes(1);
  });

  it("orders StrictMode release and replay as one binding incarnation", async () => {
    render(
      <React.StrictMode>
        <PanelSurface nativeSlotId="slot-1" panelId="panel-1" focused />
      </React.StrictMode>
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const clearRequest = shellClient.clearNativePanelSlot.mock.calls[0]?.[0] as {
      bindingSequence: number;
      operationSequence: number;
    };
    const lastBindRequest = shellClient.bindNativePanelSlot.mock.calls.at(-1)?.[0] as {
      bindingSequence: number;
      operationSequence: number;
    };
    expect(lastBindRequest.bindingSequence).toBe(clearRequest.bindingSequence);
    expect(lastBindRequest.operationSequence).toBeGreaterThan(clearRequest.operationSequence);
  });
});
