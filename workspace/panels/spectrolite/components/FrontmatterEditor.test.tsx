// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";
import * as YAML from "yaml";
import { FrontmatterEditor } from "./FrontmatterEditor";

function renderEditor(yaml: string) {
  const onChange = vi.fn<(yaml: string) => void>();
  const utils = render(
    <Theme>
      <FrontmatterEditor yaml={yaml} onChange={onChange} />
    </Theme>
  );
  return { onChange, ...utils };
}

const SAMPLE = ["title: Welcome", "dependencies:", "  lodash: npm:^4.17.21"].join("\n");

/** The YAML the editor most recently emitted, parsed. */
function lastEmitted(onChange: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = onChange.mock.calls.at(-1);
  expect(call, "expected onChange to have been called").toBeTruthy();
  return YAML.parse(call![0]) as Record<string, unknown>;
}

describe("FrontmatterEditor", () => {
  it("renders scalar keys and dependency rows as structured fields", () => {
    renderEditor(SAMPLE);
    expect(screen.getByDisplayValue("Welcome")).toBeTruthy();
    expect(screen.getByDisplayValue("lodash")).toBeTruthy();
    expect(screen.getByDisplayValue("npm:^4.17.21")).toBeTruthy();
  });

  it("emits updated YAML when a scalar value is edited", () => {
    const { onChange } = renderEditor(SAMPLE);
    fireEvent.change(screen.getByDisplayValue("Welcome"), { target: { value: "Hello" } });
    const emitted = lastEmitted(onChange);
    expect(emitted["title"]).toBe("Hello");
    expect(emitted["dependencies"]).toEqual({ lodash: "npm:^4.17.21" });
  });

  it("preserves scalar types through the round-trip", () => {
    const { onChange } = renderEditor("draft: true\ncount: 3");
    fireEvent.change(screen.getByDisplayValue("3"), { target: { value: "5" } });
    const emitted = lastEmitted(onChange);
    expect(emitted).toEqual({ draft: true, count: 5 });
  });

  it("adds and removes dependency rows", () => {
    const { onChange } = renderEditor(SAMPLE);
    const addButtons = screen.getAllByRole("button", { name: /add package/i });
    fireEvent.click(addButtons[addButtons.length - 1]!);
    const nameInputs = screen.getAllByLabelText("Package name");
    const refInputs = screen.getAllByLabelText("Package reference");
    fireEvent.change(nameInputs[nameInputs.length - 1]!, { target: { value: "date-fns" } });
    fireEvent.change(refInputs[refInputs.length - 1]!, { target: { value: "npm:^2.30.0" } });
    expect(lastEmitted(onChange)["dependencies"]).toEqual({
      lodash: "npm:^4.17.21",
      "date-fns": "npm:^2.30.0",
    });
  });

  it("offers no affordance to delete the frontmatter", () => {
    renderEditor(SAMPLE);
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("validates malformed YAML in raw mode without emitting", () => {
    const { onChange } = renderEditor(SAMPLE);
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    const before = onChange.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Frontmatter YAML"), {
      target: { value: "title: [broken" },
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onChange.mock.calls.length).toBe(before); // invalid YAML is not emitted
  });

  it("re-seeds when the block is replaced from outside", () => {
    const { rerender } = renderEditor(SAMPLE);
    rerender(
      <Theme>
        <FrontmatterEditor yaml="title: Replaced" onChange={vi.fn()} />
      </Theme>
    );
    expect(screen.getByDisplayValue("Replaced")).toBeTruthy();
  });

  it("collapses to just the header", () => {
    renderEditor(SAMPLE);
    expect(screen.getByDisplayValue("Welcome")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /collapse properties/i }));
    expect(screen.queryByDisplayValue("Welcome")).toBeNull();
  });
});
