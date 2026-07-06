// @vitest-environment jsdom

import { Theme } from "@radix-ui/themes";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PubSubClient } from "@workspace/pubsub";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";

import { LinkedPermissionCards } from "./LinkedPermissionCards";

function signal(kind: string, details: Record<string, unknown>, ts: number) {
  return {
    delivery: "signal",
    type: "signal",
    contentType: AGENTIC_EVENT_PAYLOAD_KIND,
    content: JSON.stringify({ kind: "system.event", payload: { kind, details } }),
    ts,
  };
}

function createClient(events: unknown[]): PubSubClient {
  return {
    events: vi.fn(async function* () {
      for (const event of events) yield event;
    }),
  } as unknown as PubSubClient;
}

describe("LinkedPermissionCards", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders the pending permission and dispatches resolveExternalAgentByRequest on Allow", async () => {
    const call = vi.fn(async () => ({ resolved: true }));
    const client = createClient([
      signal(
        "linked-agent.permission_pending",
        {
          channelId: "channel-1",
          requestId: "req-1",
          resolveToken: "resolve-token-123",
          toolName: "Bash",
          description: "run a shell command",
          preview: "npm install",
        },
        1
      ),
    ]);

    render(
      <Theme>
        <LinkedPermissionCards client={client} chat={{ rpc: { call } }} />
      </Theme>
    );

    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeTruthy();
    });
    expect(screen.getByText("run a shell command")).toBeTruthy();
    expect(screen.getByText("npm install")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Allow/i }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith("main", "shellApproval.resolveExternalAgentByRequest", [
        { channelId: "channel-1", requestId: "req-1", resolveToken: "resolve-token-123" },
        "allow",
      ]);
    });
    // Optimistic clear removes the card after the user's own click.
    await waitFor(() => {
      expect(screen.queryByText("Bash")).toBeNull();
    });
  });

  it("clears the card when the companion permission_settled signal arrives", async () => {
    const call = vi.fn(async () => ({ resolved: true }));
    const client = createClient([
      signal(
        "linked-agent.permission_pending",
        {
          channelId: "channel-1",
          requestId: "req-1",
          resolveToken: "resolve-token-123",
          toolName: "Bash",
        },
        1
      ),
      signal(
        "linked-agent.permission_settled",
        { channelId: "channel-1", requestId: "req-1", settledBy: "terminal-answered" },
        2
      ),
    ]);

    render(
      <Theme>
        <LinkedPermissionCards client={client} chat={{ rpc: { call } }} />
      </Theme>
    );

    await waitFor(() => {
      expect(client.events).toHaveBeenCalledWith({ includeSignals: true });
    });
    // The settle signal (from any surface) clears the card without a click.
    await waitFor(() => {
      expect(screen.queryByText("Bash")).toBeNull();
    });
    expect(call).not.toHaveBeenCalled();
  });
});
