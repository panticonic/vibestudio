// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AboutPanelRoot from "./index";

const mocks = vi.hoisted(() => ({
  getHistory: vi.fn(),
  searchHistory: vi.fn(),
  getPageFavicon: vi.fn(),
  reopen: vi.fn(),
  sourceTree: vi.fn(),
  sourceUsage: vi.fn(),
  roots: vi.fn(),
  children: vi.fn(),
  focus: vi.fn(),
  onFocus: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  browserData: {
    getHistory: mocks.getHistory,
    searchHistoryForAutocomplete: mocks.searchHistory,
    getPageFavicon: mocks.getPageFavicon,
  },
  buildPanelLink: (source: string) => `/${source}/`,
  panel: {
    onFocus: mocks.onFocus,
    onChildCreationError: () => () => {},
    reopen: mocks.reopen,
  },
  panelTree: {
    sourceUsage: mocks.sourceUsage,
    roots: mocks.roots,
    children: mocks.children,
  },
  workspace: { sourceTree: mocks.sourceTree },
}));

vi.mock("@workspace/react/responsive", () => ({
  useIsMobile: () => false,
  useViewportHeight: () => 800,
}));
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

/** Rows render their destination as the title line, so match that node only. */
const findRow = (title: string) => screen.findByText(title, { selector: ".launcher-title" });

let storageValues: Map<string, string>;
let panelFocusCallback: () => void;

describe("new panel launcher", () => {
  beforeEach(() => {
    storageValues = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storageValues.get(key) ?? null,
        setItem: (key: string, value: string) => storageValues.set(key, value),
      },
    });
    mocks.getHistory.mockReset().mockResolvedValue([historyRow]);
    mocks.searchHistory.mockReset().mockResolvedValue([historyRow]);
    mocks.getPageFavicon.mockReset().mockResolvedValue(null);
    mocks.reopen.mockReset().mockResolvedValue({ id: "slot-1", title: "Example" });
    mocks.sourceUsage.mockReset().mockResolvedValue([]);
    mocks.roots.mockReset().mockResolvedValue({ entries: [], nextCursor: null, revision: 1 });
    mocks.children.mockReset().mockResolvedValue({ entries: [], nextCursor: null, revision: 1 });
    mocks.focus.mockReset().mockResolvedValue({ phase: "ready" });
    mocks.onFocus.mockReset().mockImplementation((callback: () => void) => {
      panelFocusCallback = callback;
      return () => {};
    });
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
        {
          name: "about",
          path: "about",
          isUnit: false,
          children: [
            {
              name: "about",
              path: "about/about",
              isUnit: true,
              children: [],
              launchable: { type: "app", title: "About Vibestudio" },
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

  it("keeps about pages searchable without letting them crowd apps out of the idle list", async () => {
    render(<AboutPanelRoot />);

    expect(await findRow("Terminal")).toBeTruthy();
    expect(screen.queryByText("About Vibestudio", { selector: ".launcher-title" })).toBeNull();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "about" } });
    expect(await findRow("About Vibestudio")).toBeTruthy();
  });

  it("treats an empty canonical history as a normal empty result", async () => {
    mocks.getHistory.mockResolvedValue([]);

    render(<AboutPanelRoot />);

    expect(await screen.findByText("Terminal")).toBeTruthy();
    await waitFor(() => expect(mocks.getHistory).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/History suggestions couldn/)).toBeNull();
  });

  it("quietly reconciles history after the workspace review resolves", async () => {
    mocks.getHistory.mockRejectedValueOnce(
      Object.assign(new Error("workspace review pending"), { code: "EREVIEWPENDING" })
    );

    render(<AboutPanelRoot />);

    await waitFor(() => expect(mocks.getHistory).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/History suggestions couldn/)).toBeNull();
    act(() => panelFocusCallback());

    expect(await screen.findByText("Example Docs")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/History suggestions couldn/)).toBeNull());
    expect(mocks.getHistory).toHaveBeenCalledTimes(2);
  });

  it("renders a warm catalog before any revalidation API completes", () => {
    storageValues.set(
      "vibestudio:new-panel-catalog",
      JSON.stringify({
        version: 2,
        groups: { panels: [{ path: "panels/terminal", title: "Terminal" }], about: [] },
      })
    );
    mocks.sourceTree.mockReturnValue(new Promise(() => {}));
    mocks.sourceUsage.mockReturnValue(new Promise(() => {}));
    mocks.roots.mockReturnValue(new Promise(() => {}));

    render(<AboutPanelRoot />);

    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByRole("combobox").getAttribute("disabled")).toBeNull();
  });

  it("publishes a cold source catalog without waiting for open-panel traversal", async () => {
    mocks.roots.mockReturnValue(new Promise(() => {}));

    render(<AboutPanelRoot />);

    expect(await screen.findByText("Terminal")).toBeTruthy();
    await waitFor(() => expect(mocks.roots).toHaveBeenCalledTimes(1));
  });

  it("uses the tree revision to avoid repeating a deep traversal on focus", async () => {
    mocks.roots.mockResolvedValue({
      revision: 7,
      nextCursor: null,
      entries: [
        {
          node: { slotId: "parent", childCount: 1 },
          handle: { id: "parent", source: "panels/chat", kind: "workspace" },
        },
      ],
    });
    mocks.children.mockResolvedValue({ revision: 7, nextCursor: null, entries: [] });
    render(<AboutPanelRoot />);
    await waitFor(() => expect(mocks.children).toHaveBeenCalledTimes(1));

    act(() => panelFocusCallback());
    await waitFor(() => expect(mocks.roots).toHaveBeenCalledTimes(2));
    expect(mocks.children).toHaveBeenCalledTimes(1);
    expect(mocks.sourceTree).toHaveBeenCalledTimes(1);
  });

  it("moves the active suggestion with arrows", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "docs" } });

    await findRow("Start a new Agentic Chat");
    await findRow("Example Docs");
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true")
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true")
    );
  });

  it("preserves a keyboard selection while asynchronous history reshuffles results", async () => {
    let resolveHistory!: (rows: (typeof historyRow)[]) => void;
    mocks.searchHistory.mockReturnValue(
      new Promise<(typeof historyRow)[]>((resolve) => {
        resolveHistory = resolve;
      })
    );
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "docs" } });
    const chat = await findRow("Start a new Agentic Chat");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    resolveHistory([historyRow]);
    await screen.findByText("Example Docs");
    await waitFor(() =>
      expect(chat.closest('[role="option"]')?.getAttribute("aria-selected")).toBe("true")
    );
  });

  it("opens the selected address suggestion with Enter", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "example.com" } });

    await findRow("https://example.com/");
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

    await findRow("Start a new Agentic Chat");
    await waitFor(() => expect(input.style.height).toBe("96px"));
    expect(input.tagName).toBe("TEXTAREA");
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    expect(mocks.reopen).not.toHaveBeenCalled();
  });

  it("accepts the highlighted inline completion with Tab", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: ">term" } });
    await screen.findByText("Terminal");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe(">Terminal");
    expect(mocks.reopen).not.toHaveBeenCalled();
  });

  it("focuses an already-open destination instead of creating a duplicate", async () => {
    mocks.roots.mockResolvedValue({
      revision: 1,
      nextCursor: null,
      entries: [
        {
          node: { slotId: "slot-terminal", childCount: 0 },
          handle: {
            id: "slot-terminal",
            source: "panels/terminal",
            kind: "workspace",
            focus: mocks.focus,
          },
        },
      ],
    });
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "terminal" } });
    const badge = await screen.findByText("Already open");
    await waitFor(() =>
      expect(badge.closest('[role="option"]')?.getAttribute("aria-selected")).toBe("true")
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mocks.focus).toHaveBeenCalledTimes(1));
    expect(mocks.reopen).not.toHaveBeenCalled();
  });

  it("renders panel destinations as addressable links", async () => {
    render(<AboutPanelRoot />);
    const row = (await findRow("Terminal")).closest('[role="option"]');
    expect(row?.tagName).toBe("A");
    expect(row?.getAttribute("href")).toBe("/panels/terminal/");
  });

  it("scopes results from the mode chips without losing the typed query", async () => {
    render(<AboutPanelRoot />);
    const input = screen.getByRole("combobox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "chat" } });
    await findRow("Chat");

    fireEvent.click(screen.getByRole("button", { name: /Panels/ }));
    await waitFor(() => expect(input.value).toBe(">chat"));
    await waitFor(() =>
      expect(screen.queryAllByRole("group").map((group) => group.textContent?.slice(0, 6))).toEqual(
        ["Panels"]
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /Panels/ }));
    await waitFor(() => expect(input.value).toBe("chat"));
  });
});
