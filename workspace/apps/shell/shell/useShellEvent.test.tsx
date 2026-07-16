// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (payload: unknown) => void>();
const subscribe = vi.fn();
const unsubscribe = vi.fn();
const onEvent = vi.fn();

vi.mock("./client.js", () => ({
  events: {
    subscribe: (...args: unknown[]) => subscribe(...args),
    unsubscribe: (...args: unknown[]) => unsubscribe(...args),
    on: (...args: unknown[]) => onEvent(...args),
  },
}));

import { useShellEvent } from "./useShellEvent";

function Probe({ onUpdate }: { onUpdate: (payload: unknown) => void }) {
  useShellEvent("panel-tree-updated", onUpdate as never);
  return null;
}

describe("useShellEvent", () => {
  it("installs the listener before subscribing so immediate snapshots are delivered", async () => {
    const snapshot = { revision: 1, forest: [] };
    const received = vi.fn();
    const order: string[] = [];

    listeners.clear();
    subscribe.mockReset();
    unsubscribe.mockReset();
    unsubscribe.mockResolvedValue(undefined);
    onEvent.mockReset();
    onEvent.mockImplementation((event: string, listener: (payload: unknown) => void) => {
        order.push("listen");
        listeners.set(event, listener);
        return () => listeners.delete(event);
      });
    subscribe.mockImplementation(async (event: string) => {
      order.push("subscribe");
      listeners.get(event)?.(snapshot);
    });

    render(<Probe onUpdate={received} />);

    await waitFor(() => expect(received).toHaveBeenCalledWith(snapshot));
    expect(order).toEqual(["listen", "subscribe"]);
  });
});
