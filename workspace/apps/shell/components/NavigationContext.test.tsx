// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NavigationProvider,
  useNavigation,
  useNavigationActions,
  useNavigationLazy,
  useNavigationLayout,
} from "./NavigationContext";

function ModeProbe() {
  const { mode } = useNavigation();
  return <div data-testid="mode">{mode}</div>;
}

function NavigationProbe({ handler }: { handler: ReturnType<typeof vi.fn> }) {
  const { navigateToId, registerNavigateToId } = useNavigation();
  useEffect(() => registerNavigateToId(handler), [handler, registerNavigateToId]);
  return (
    <button
      onClick={() =>
        navigateToId("panel-child", {
          parentId: "panel-parent",
          hint: { disposition: "side", minWidth: 700 },
          intentId: "create:panel-child",
          target: "focused-pane",
        })
      }
    >
      Navigate
    </button>
  );
}

function LayoutRenderProbe({ rendered }: { rendered: ReturnType<typeof vi.fn> }) {
  rendered();
  const { mode } = useNavigationLayout();
  return <span>{mode}</span>;
}

function ActionsRenderProbe({ rendered }: { rendered: ReturnType<typeof vi.fn> }) {
  rendered();
  useNavigationActions();
  return null;
}

function LazyRenderProbe({ rendered }: { rendered: ReturnType<typeof vi.fn> }) {
  rendered();
  useNavigationLazy();
  return null;
}

function LazyNavigationWriter() {
  const { setLazyTitleNavigation } = useNavigationActions();
  return (
    <button
      onClick={() =>
        setLazyTitleNavigation({
          ancestors: [],
          currentSiblings: [],
          currentId: "panel-1",
          currentTitle: "Panel 1",
        })
      }
    >
      Publish lazy navigation
    </button>
  );
}

function renderMode() {
  render(
    <NavigationProvider>
      <ModeProbe />
    </NavigationProvider>
  );

  return screen.getByTestId("mode").textContent;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 767px)" ? false : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NavigationProvider", () => {
  it("defaults to tree navigation on wider windows", () => {
    expect(renderMode()).toBe("tree");
  });

  it("defaults to stack navigation on very small windows", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }));

    expect(renderMode()).toBe("stack");
  });

  it("carries a child placement intent through the registered navigation boundary", () => {
    const handler = vi.fn();
    render(
      <NavigationProvider>
        <NavigationProbe handler={handler} />
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));

    expect(handler).toHaveBeenCalledWith("panel-child", {
      parentId: "panel-parent",
      hint: { disposition: "side", minWidth: 700 },
      intentId: "create:panel-child",
      target: "focused-pane",
    });
  });

  it("does not rerender layout consumers when only lazy breadcrumb data changes", () => {
    const layoutRendered = vi.fn();
    const actionsRendered = vi.fn();
    const lazyRendered = vi.fn();
    render(
      <NavigationProvider>
        <LayoutRenderProbe rendered={layoutRendered} />
        <ActionsRenderProbe rendered={actionsRendered} />
        <LazyRenderProbe rendered={lazyRendered} />
        <LazyNavigationWriter />
      </NavigationProvider>
    );
    expect(layoutRendered).toHaveBeenCalledTimes(1);
    expect(actionsRendered).toHaveBeenCalledTimes(1);
    expect(lazyRendered).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Publish lazy navigation" }));

    expect(layoutRendered).toHaveBeenCalledTimes(1);
    expect(actionsRendered).toHaveBeenCalledTimes(1);
    expect(lazyRendered).toHaveBeenCalledTimes(2);
  });
});
