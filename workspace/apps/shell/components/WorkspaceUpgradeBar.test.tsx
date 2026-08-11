// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  operations: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  handler: undefined as undefined | (() => void),
}));

vi.mock("../shell/client", () => ({
  templates: { operations: client.operations },
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
}));
vi.mock("@radix-ui/react-icons", () => ({ UpdateIcon: () => <span /> }));

import { WorkspaceUpgradeBar } from "./WorkspaceUpgradeBar";

describe("WorkspaceUpgradeBar", () => {
  beforeEach(() => {
    client.operations.mockReset().mockResolvedValue([]);
    client.subscribe.mockReset().mockResolvedValue(undefined);
    client.unsubscribe.mockReset().mockResolvedValue(undefined);
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
        state: "repairing",
        fingerprint: `v1-sha256:${"a".repeat(64)}`,
        migration: { facets: ["system"] },
      },
    ]);
    await act(async () => client.handler?.());
    expect(await screen.findByText("Workspace upgrading")).toBeTruthy();
    expect(screen.getByText(/system/)).toBeTruthy();

    client.operations.mockResolvedValueOnce([]);
    await act(async () => client.handler?.());
    await waitFor(() => expect(view.container.textContent).toBe(""));
  });
});
