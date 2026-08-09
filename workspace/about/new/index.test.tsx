// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AboutPanelRoot from "./index";

const mocks = vi.hoisted(() => ({
  getHistory: vi.fn(),
  searchHistory: vi.fn(),
  reopen: vi.fn(),
  sourceTree: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  browserData: {
    getHistory: mocks.getHistory,
    searchHistoryForAutocomplete: mocks.searchHistory,
  },
  buildPanelLink: (source: string) => `/${source}/`,
  panel: {
    onFocus: () => () => {},
    onChildCreationError: () => () => {},
    reopen: mocks.reopen,
  },
  workspace: { sourceTree: mocks.sourceTree },
}));

vi.mock("@workspace/react/responsive", () => ({ useIsMobile: () => false }));
vi.mock("../../packages/about-shared/ui", () => ({
  AboutThemeRoot: ({ children }: { children: ReactNode }) => <>{children}</>,
  AboutPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  Section: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

const historyRow = {
  id: 1,
  url: "https://example.com/docs",
  title: "Example Docs",
  visit_count: 12,
  typed_count: 3,
  first_visit: 1,
  last_visit: 100,
};

describe("new panel launcher", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    mocks.getHistory.mockReset().mockResolvedValue([historyRow]);
    mocks.searchHistory.mockReset().mockResolvedValue([historyRow]);
    mocks.reopen.mockReset().mockResolvedValue({ id: "slot-1", title: "Example" });
    mocks.sourceTree.mockReset().mockResolvedValue({
      children: [
        {
          name: "panels",
          path: "panels",
          isUnit: false,
          children: [
            {
              name: "chat",
              path: "panels/chat",
              isUnit: true,
              children: [],
              launchable: { type: "app", title: "Chat" },
            },
            {
              name: "terminal",
              path: "panels/terminal",
              isUnit: true,
              children: [],
              launchable: { type: "app", title: "Terminal" },
            },
          ],
        },
      ],
    });
  });

  it("shows panel and usage-ranked browser history suggestions in one list", async () => {
    render(<AboutPanelRoot />);

    expect(await screen.findByText("Terminal")).toBeTruthy();
    expect(await screen.findByText("Example Docs")).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBeGreaterThanOrEqual(3);
  });

  it("moves the active suggestion with arrows", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "docs" } });

    await screen.findByText("Chat: docs");
    await screen.findByText("Example Docs");
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true")
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true")
    );
  });

  it("opens the selected address suggestion with Enter", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "example.com" } });

    await screen.findAllByText("Open https://example.com/");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.reopen).toHaveBeenCalledWith({ source: "https://example.com/" });
  });

  it("grows into an agent prompt composer and preserves Shift+Enter for newlines", async () => {
    mocks.searchHistory.mockResolvedValue([]);
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox") as HTMLTextAreaElement;
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 96 });

    fireEvent.input(input, {
      target: { value: "Please investigate this issue and explain the best next step" },
    });

    await screen.findAllByText("Start Agentic Chat");
    await waitFor(() => expect(input.style.height).toBe("96px"));
    expect(input.tagName).toBe("TEXTAREA");
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    expect(mocks.reopen).not.toHaveBeenCalled();
  });
});
