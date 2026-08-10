// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PanelIcon } from "./PanelIcon";

afterEach(cleanup);

describe("PanelIcon", () => {
  it("renders a declared semantic icon at the requested breadcrumb size", () => {
    const { getByText } = render(<PanelIcon icon="💬" size={17} fallback="panel" />);
    const icon = getByText("💬");
    expect(icon.style.width).toBe("17px");
    expect(icon.style.height).toBe("17px");
  });

  it("resolves a real image through the immutable unit-icon route", () => {
    const { container } = render(
      <PanelIcon icon="./assets/icon.svg" source="workers/mail" fallback="worker" />
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "../../__vibestudio/unit-icon?source=workers%2Fmail&path=assets%2Ficon.svg"
    );
  });

  it("uses the typed fallback if a declared image cannot be loaded", () => {
    const { container } = render(
      <PanelIcon icon="./assets/icon.svg" source="workers/mail" fallback="worker" />
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).not.toContain("./assets/icon.svg");
  });

  it("uses distinct glyphs for panel, browser, worker, app, and extension fallbacks", () => {
    const kinds = ["panel", "browser", "worker", "app", "extension"] as const;
    const glyphs = kinds.map((fallback) => {
      const { container, unmount } = render(<PanelIcon fallback={fallback} />);
      const markup = container.innerHTML;
      unmount();
      return markup;
    });
    expect(new Set(glyphs).size).toBe(kinds.length);
  });
});
