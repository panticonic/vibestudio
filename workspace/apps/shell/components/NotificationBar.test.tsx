// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventName, EventPayloads, NotificationPayload } from "@vibestudio/shared/events";

const shellClient = vi.hoisted(() => ({
  applyUpdate: vi.fn(() => Promise.resolve({ applied: true })),
  rollback: vi.fn(() => Promise.resolve()),
  restart: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve("notif")),
  reportAction: vi.fn(() => Promise.resolve()),
  dismiss: vi.fn(() => Promise.resolve()),
}));

vi.mock("../shell/client", () => ({
  app: {
    applyUpdate: shellClient.applyUpdate,
  },
  notification: {
    show: shellClient.show,
    reportAction: shellClient.reportAction,
    dismiss: shellClient.dismiss,
  },
  workspaceUnits: {
    rollback: shellClient.rollback,
    restart: shellClient.restart,
  },
}));

vi.mock("../shell/useShellEvent", () => ({
  useShellEvent: vi.fn(),
}));
vi.mock("../shell/useDirectShellEvent", () => ({
  useDirectShellEvent: vi.fn(),
}));

import { useShellEvent } from "../shell/useShellEvent";
import { useDirectShellEvent } from "../shell/useDirectShellEvent";
import { NotificationBar } from "./NotificationBar";

function renderBar() {
  render(
    <Theme>
      <NotificationBar />
    </Theme>
  );
}

function emitShellEvent<E extends EventName>(event: E, payload: EventPayloads[E]) {
  const callback = vi
    .mocked(useShellEvent)
    .mock.calls.find(([registeredEvent]) => registeredEvent === event)?.[1] as
    | ((payload: EventPayloads[E]) => void)
    | undefined;
  expect(callback).toBeTruthy();
  act(() => {
    callback?.(payload);
  });
}

function emitDirectShellEvent<E extends EventName>(event: E, payload: EventPayloads[E]) {
  const callback = vi
    .mocked(useDirectShellEvent)
    .mock.calls.find(([registeredEvent]) => registeredEvent === event)?.[1] as
    | ((payload: EventPayloads[E]) => void)
    | undefined;
  expect(callback).toBeTruthy();
  act(() => {
    callback?.(payload);
  });
}

describe("NotificationBar", () => {
  beforeEach(() => {
    vi.mocked(useShellEvent).mockClear();
    vi.mocked(useDirectShellEvent).mockClear();
    shellClient.applyUpdate.mockClear();
    shellClient.rollback.mockClear();
    shellClient.restart.mockClear();
    shellClient.show.mockClear();
    shellClient.reportAction.mockClear();
    shellClient.dismiss.mockClear();
  });

  it("renders notifications addressed directly to the authenticated account", () => {
    renderBar();

    emitDirectShellEvent("notification:show", {
      id: "account-only",
      type: "info",
      title: "Account notification",
      message: "This was not a watched broadcast.",
    });

    expect(screen.getByText("Account notification")).toBeTruthy();
  });

  it("expands bounded diagnostic details and all recorded errors", () => {
    renderBar();

    const payload: NotificationPayload = {
      id: "extension-crash",
      type: "error",
      title: "Extension stopped",
      message: "@workspace-extensions/react-native failed 5 times and will not restart until reloaded.",
      details: [
        { label: "Extension", value: "@workspace-extensions/react-native", mono: true },
        { label: "Attempts", value: "5" },
        { label: "Latest error", value: "Cannot find module typedServiceClient.js", mono: true },
      ],
      history: [
        { title: "Attempt 1", message: "First crash\nstack line 1", timestamp: 1 },
        { title: "Attempt 2", message: "Second crash\nstack line 2", timestamp: 2 },
      ],
    };

    emitShellEvent("notification:show", payload);

    expect(screen.getByText("Extension stopped")).toBeTruthy();
    expect(screen.getByText(payload.message!)).toBeTruthy();
    expect(screen.queryByText("First crash")).toBeNull();

    fireEvent.click(screen.getByText("Details"));

    expect(screen.getByText("Extension")).toBeTruthy();
    expect(screen.getByText("@workspace-extensions/react-native")).toBeTruthy();
    expect(screen.getByText("Latest error")).toBeTruthy();
    expect(screen.getByText("Cannot find module typedServiceClient.js")).toBeTruthy();
    expect(screen.getByText("Recent errors")).toBeTruthy();
    expect(screen.getByText(/Attempt 1/)).toBeTruthy();
    expect(screen.getByText(/Attempt 2/)).toBeTruthy();
    expect(screen.getByText(/First crash/)).toBeTruthy();
    expect(screen.getByText(/Second crash/)).toBeTruthy();

    const detailsPane = screen.getByTestId("notification-details-pane");
    expect(detailsPane.style.maxHeight).toBe("280px");
    expect(detailsPane.style.overflowY).toBe("auto");
  });

  it("shows queued notifications in the expanded panel instead of hiding them", () => {
    renderBar();

    emitShellEvent("notification:show", {
      id: "older",
      type: "error",
      title: "Older extension error",
      message: "Older failure",
    });
    emitShellEvent("notification:show", {
      id: "newer",
      type: "error",
      title: "Newest extension error",
      message: "Newest failure",
      details: [{ label: "Extension", value: "@workspace-extensions/newer" }],
    });

    expect(screen.getByText("Newest extension error")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.queryByText("Older extension error")).toBeNull();

    fireEvent.click(screen.getByText("Details"));

    expect(screen.getByText("Other notifications")).toBeTruthy();
    expect(screen.getByText("Older extension error")).toBeTruthy();
    expect(screen.getByText("Older failure")).toBeTruthy();
  });
});
