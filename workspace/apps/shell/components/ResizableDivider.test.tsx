// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableDivider } from "./ResizableDivider";

describe("ResizableDivider", () => {
  const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;

  beforeEach(() => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
  });

  afterEach(() => {
    HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
    vi.restoreAllMocks();
  });

  it("keeps one pointer listener while live resize callbacks change identity", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const firstDrag = vi.fn();
    const secondDrag = vi.fn();
    const onDragStart = vi.fn();
    const view = render(
      <ResizableDivider
        orientation="vertical"
        label="Resize columns"
        valueNow={50}
        onDragStart={onDragStart}
        onDrag={firstDrag}
      />
    );

    fireEvent.pointerDown(view.getByRole("separator"), {
      pointerId: 7,
      clientX: 100,
      clientY: 0,
    });
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(
      addListener.mock.calls.filter(([eventName]) => eventName === "pointermove")
    ).toHaveLength(1);

    view.rerender(
      <ResizableDivider
        orientation="vertical"
        label="Resize columns"
        valueNow={51}
        onDragStart={onDragStart}
        onDrag={secondDrag}
      />
    );
    expect(
      addListener.mock.calls.filter(([eventName]) => eventName === "pointermove")
    ).toHaveLength(1);

    fireEvent.pointerMove(window, { pointerId: 7, clientX: 112, clientY: 0 });
    expect(firstDrag).not.toHaveBeenCalled();
    expect(secondDrag).toHaveBeenCalledWith(12);
  });
});
