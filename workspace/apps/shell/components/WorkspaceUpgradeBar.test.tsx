// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  operations: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  createPanel: vi.fn(),
  handler: undefined as undefined | (() => void),
}));

vi.mock("../shell/client", () => ({
  templates: { operations: client.operations },
  panel: { createPanel: client.createPanel },
  events: {
    subscribe: client.subscribe,
    unsubscribe: client.unsubscribe,
    on: (_event: string, handler: () => void) => {
      client.handler = handler;
      return () => {
        client.handler = undefined;
      };
    },
  },
}));
vi.mock("../shell/useShellEvent", () => ({ useShellEvent: () => undefined }));
vi.mock("@radix-ui/themes", () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Flex: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@radix-ui/react-icons", () => ({ UpdateIcon: () => <span /> }));

import { WorkspaceUpgradeBar } from "./WorkspaceUpgradeBar";

describe("WorkspaceUpgradeBar", () => {
  beforeEach(() => {
    client.operations.mockReset().mockResolvedValue([]);
    client.subscribe.mockReset().mockResolvedValue(undefined);
    client.unsubscribe.mockReset().mockResolvedValue(undefined);
    client.createPanel.mockReset().mockResolvedValue({ id: "upgrade-chat" });
    client.handler = undefined;
  });

  it("appears and clears from durable migration operations", async () => {
    const view = render(<WorkspaceUpgradeBar />);
    await waitFor(() => expect(client.operations).toHaveBeenCalledTimes(1));
    expect(view.container.textContent).toBe("");

    client.operations.mockResolvedValueOnce([
      {
        operationId: "host-release",
        kind: "pull",
        contextId: "template-operation-host-release",
        initiator: "host-release",
        target: { alias: "workspace-base", ref: "refs/tags/v2" },
        state: "repairing",
        fingerprint: `v1-sha256:${"a".repeat(64)}`,
        migration: {
          facets: ["system"],
          notes: [
            {
              path: "migrations/system/runtime.md",
              title: "Runtime contract",
              degradedOk: false,
            },
          ],
        },
      },
    ]);
    await act(async () => client.handler?.());
    expect(await screen.findByText("Repair needed")).toBeTruthy();
    expect(screen.getByText(/workspace-base/)).toBeTruthy();
    expect(screen.getByText(/Runtime contract/)).toBeTruthy();
    expect(screen.getByText(/may be incompatible/)).toBeTruthy();
    expect(view.container.textContent).not.toContain("host-release");

    fireEvent.click(screen.getByRole("button", { name: "Continue upgrade" }));
    await waitFor(() => expect(client.createPanel).toHaveBeenCalledTimes(1));
    expect(client.createPanel).toHaveBeenCalledWith(
      "panels/chat",
      expect.objectContaining({
        contextId: "template-operation-host-release",
        stateArgs: { initialPrompt: expect.stringContaining("Use the Templates skill") },
      })
    );

    client.operations.mockResolvedValueOnce([]);
    await act(async () => client.handler?.());
    await waitFor(() => expect(view.container.textContent).toBe(""));
  });
});
