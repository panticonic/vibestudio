// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const subscribe = vi.fn();
const unsubscribe = vi.fn();
const onRpcEvent = vi.fn();

vi.mock("./client.js", () => ({
  events: {
    subscribe: (...args: unknown[]) => subscribe(...args),
    unsubscribe: (...args: unknown[]) => unsubscribe(...args),
  },
  onRpcEvent: (...args: unknown[]) => onRpcEvent(...args),
}));

import { useShellEvent } from "./useShellEvent";

function Probe({ onUpdate }: { onUpdate: (payload: unknown) => void }) {
  useShellEvent("panel-tree-updated", onUpdate as never);
  return null;
}

describe("useShellEvent", () => {
  it("installs the listener before subscribing so immediate snapshots are delivered", async () => {
    const snapshot = { revision: 1, rootPanels: [] };
    const received = vi.fn();
    const order: string[] = [];

    listeners.clear();
    subscribe.mockReset();
    unsubscribe.mockReset();
    unsubscribe.mockResolvedValue(undefined);
    onRpcEvent.mockReset();
    onRpcEvent.mockImplementation(
      (channel: string, listener: (event: { payload: unknown }) => void) => {
        order.push("listen");
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      }
    );
    subscribe.mockImplementation(async (event: string) => {
      order.push("subscribe");
      listeners.get(`event:${event}`)?.({ payload: snapshot });
    });

    render(<Probe onUpdate={received} />);

    await waitFor(() => expect(received).toHaveBeenCalledWith(snapshot));
    expect(order).toEqual(["listen", "subscribe"]);
  });
});
