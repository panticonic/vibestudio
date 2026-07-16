// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (payload: unknown) => void>();
const stopListening = vi.fn();
const onDirectEvent = vi.fn();

vi.mock("./client.js", () => ({
  directEvents: {
    on: (...args: unknown[]) => onDirectEvent(...args),
  },
}));

import { useDirectShellEvent } from "./useDirectShellEvent";

function Probe({ onChange }: { onChange: (payload: unknown) => void }) {
  useDirectShellEvent("user-notifications-changed", onChange as never);
  return null;
}

describe("useDirectShellEvent", () => {
  beforeEach(() => {
    listeners.clear();
    stopListening.mockReset();
    onDirectEvent.mockReset().mockImplementation(
      (event: string, listener: (payload: unknown) => void) => {
        listeners.set(event, listener);
        return stopListening;
      }
    );
  });

  it("owns one direct RPC listener and removes it on unmount", () => {
    const first = vi.fn();
    const second = vi.fn();
    const rendered = render(<Probe onChange={first} />);

    expect(onDirectEvent).toHaveBeenCalledTimes(1);
    listeners.get("user-notifications-changed")?.({ changedAt: 10 });
    expect(first).toHaveBeenCalledWith({ changedAt: 10 });

    rendered.rerender(<Probe onChange={second} />);
    expect(onDirectEvent).toHaveBeenCalledTimes(1);
    listeners.get("user-notifications-changed")?.({ changedAt: 20 });
    expect(second).toHaveBeenCalledWith({ changedAt: 20 });

    rendered.unmount();
    expect(stopListening).toHaveBeenCalledTimes(1);
  });
});
