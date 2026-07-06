// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PubSubClient } from "@workspace/pubsub";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";

import {
  useLinkedPermissionSignals,
  type LinkedPermissionPrompt,
} from "./useLinkedPermissionSignals";

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

function Probe({
  client,
  onValue,
}: {
  client: PubSubClient;
  onValue: (value: ReadonlyArray<LinkedPermissionPrompt>) => void;
}) {
  const { prompts } = useLinkedPermissionSignals(client);
  onValue(prompts);
  return null;
}

describe("useLinkedPermissionSignals", () => {
  afterEach(() => vi.restoreAllMocks());

  it("adds a card on permission_pending", async () => {
    let latest: ReadonlyArray<LinkedPermissionPrompt> = [];
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

    render(<Probe client={client} onValue={(v) => (latest = v)} />);

    await waitFor(() => {
      expect(latest).toEqual([
        expect.objectContaining({
          channelId: "channel-1",
          requestId: "req-1",
          resolveToken: "resolve-token-123",
          toolName: "Bash",
          description: "run a shell command",
          preview: "npm install",
        }),
      ]);
    });
  });

  it("clears the card on the companion permission_settled signal", async () => {
    let latest: ReadonlyArray<LinkedPermissionPrompt> = [];
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
        {
          channelId: "channel-1",
          requestId: "req-1",
          behavior: "allow",
          settledBy: "workspace-approval",
        },
        2
      ),
    ]);

    render(<Probe client={client} onValue={(v) => (latest = v)} />);

    await waitFor(() => {
      expect(client.events).toHaveBeenCalledWith({ includeSignals: true });
    });
    await waitFor(() => {
      expect(latest).toEqual([]);
    });
  });

  it("ignores a pending signal missing required fields", async () => {
    let latest: ReadonlyArray<LinkedPermissionPrompt> = [];
    const client = createClient([
      signal("linked-agent.permission_pending", { requestId: "req-1", toolName: "Bash" }, 1),
    ]);

    render(<Probe client={client} onValue={(v) => (latest = v)} />);

    await waitFor(() => {
      expect(client.events).toHaveBeenCalledWith({ includeSignals: true });
    });
    expect(latest).toEqual([]);
  });
});
