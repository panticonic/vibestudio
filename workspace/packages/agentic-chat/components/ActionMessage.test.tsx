// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InvocationCardPayload } from "@workspace/agentic-core";
import { ActionPill } from "./ActionMessage";

function closePayload(status: InvocationCardPayload["execution"]["status"]): InvocationCardPayload {
  return {
    id: `close-${status}`,
    name: "close_subagent",
    arguments: { runId: "call-child", discard: true },
    execution: { status, description: "" },
  };
}

describe("close_subagent action tone", () => {
  it.each([
    ["running", "pending", "amber"],
    ["complete", "complete", "green"],
    ["error", "error", "red"],
  ] as const)("renders a %s discard using the %s execution tone", (status, statusKey, color) => {
    render(<ActionPill id={`close-${status}`} payload={closePayload(status)} onExpand={vi.fn()} />);

    const pill = screen.getByTestId("invocation-pill");
    expect(pill.dataset["invocationStatus"]).toBe(statusKey);
    expect(pill.style.backgroundColor).toBe(`var(--${color}-a3)`);
    expect(pill.style.border).toBe(`1px solid var(--${color}-a5)`);
    expect(pill.textContent).toContain("Discard call-child");
  });
});
