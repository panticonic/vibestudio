import { describe, expect, it, vi } from "vitest";
import { IntentInbox } from "./clientIntents.js";

const intent = (n: number) => ({ name: "open-panel", params: { panel: `p${n}` } });

describe("IntentInbox", () => {
  it("holds intents in order until the renderer subscribes, then delivers live", () => {
    const inbox = new IntentInbox();
    const send = vi.fn();
    inbox.deliver("w", intent(1));
    inbox.deliver("w", intent(2));
    inbox.subscribe("w", send);
    expect(send.mock.calls).toEqual([[intent(1)], [intent(2)]]);
    inbox.deliver("w", intent(3));
    expect(send).toHaveBeenLastCalledWith(intent(3));
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("forgets the subscription of a replaced document, so the new one gets what it missed", () => {
    const inbox = new IntentInbox();
    const old = vi.fn();
    const next = vi.fn();
    inbox.subscribe("w", old);
    inbox.reset("w");
    inbox.deliver("w", intent(1));
    expect(old).not.toHaveBeenCalled();
    inbox.subscribe("w", next);
    expect(next).toHaveBeenCalledWith(intent(1));
  });

  it("keeps windows apart and drops everything for a window that went away", () => {
    const inbox = new IntentInbox();
    inbox.deliver("a", intent(1));
    inbox.deliver("b", intent(2));
    inbox.retire("a");
    const a = vi.fn();
    const b = vi.fn();
    inbox.subscribe("a", a);
    inbox.subscribe("b", b);
    expect(a).not.toHaveBeenCalled();
    expect(b.mock.calls).toEqual([[intent(2)]]);
  });
});
