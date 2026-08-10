// @ts-expect-error The shipped React Native bootstrap is plain JavaScript.
import {
  createSuccessfulConnectCoalescer,
  routeIncomingConnectLink,
} from "../apps/mobile/connectLinkRouter.js";
import { describe, expect, it, vi } from "vitest";

function dependencies(overrides: Record<string, unknown> = {}) {
  const claimed = new Set<string>();
  return {
    consumeReplay: vi.fn(async () => false),
    parse: vi.fn(() => ({ room: "room-1" })),
    claim: vi.fn((url: string) => {
      if (claimed.has(url)) return false;
      claimed.add(url);
      return true;
    }),
    release: vi.fn((url: string) => claimed.delete(url)),
    markConsumed: vi.fn(async () => undefined),
    consumeUsbApproval: vi.fn(async () => false),
    connect: vi.fn(async () => undefined),
    present: vi.fn(),
    onUsbApproved: vi.fn(),
    ...overrides,
  };
}

describe("mobile connect-link routing", () => {
  it("consumes trusted USB links immediately even when the app is already running", async () => {
    const deps = dependencies({ consumeUsbApproval: vi.fn(async () => true) });

    await expect(routeIncomingConnectLink("vibestudio://connect?test", deps)).resolves.toBe(
      "connected"
    );
    expect(deps.onUsbApproved).toHaveBeenCalledOnce();
    expect(deps.connect).toHaveBeenCalledWith({
      pairing: { room: "room-1" },
      rawUrl: "vibestudio://connect?test",
    });
    expect(deps.present).not.toHaveBeenCalled();
  });

  it("keeps ordinary links behind explicit in-app confirmation", async () => {
    const deps = dependencies();

    await expect(routeIncomingConnectLink("vibestudio://connect?test", deps)).resolves.toBe(
      "presented"
    );
    expect(deps.present).toHaveBeenCalledWith("vibestudio://connect?test");
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("fails closed when native USB approval cannot be read", async () => {
    const deps = dependencies({
      consumeUsbApproval: vi.fn(async () => {
        throw new Error("native bridge unavailable");
      }),
    });

    await expect(routeIncomingConnectLink("vibestudio://connect?test", deps)).resolves.toBe(
      "presented"
    );
    expect(deps.present).toHaveBeenCalledOnce();
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("ignores replayed links before consulting native approval", async () => {
    const deps = dependencies({ consumeReplay: vi.fn(async () => true) });

    await expect(routeIncomingConnectLink("vibestudio://connect?test", deps)).resolves.toBe(
      "replay"
    );
    expect(deps.consumeUsbApproval).not.toHaveBeenCalled();
    expect(deps.present).not.toHaveBeenCalled();
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("ignores a duplicate delivery while trusted pairing is in flight", async () => {
    let finishPairing!: () => void;
    const pairing = new Promise<void>((resolve) => {
      finishPairing = resolve;
    });
    const deps = dependencies({
      consumeUsbApproval: vi.fn(async () => true),
      connect: vi.fn(async () => pairing),
    });

    const first = routeIncomingConnectLink("vibestudio://connect?test", deps);
    await vi.waitFor(() => expect(deps.connect).toHaveBeenCalledOnce());

    await expect(routeIncomingConnectLink("vibestudio://connect?test", deps)).resolves.toBe(
      "replay"
    );
    expect(deps.consumeUsbApproval).toHaveBeenCalledOnce();
    expect(deps.present).not.toHaveBeenCalled();

    finishPairing();
    await expect(first).resolves.toBe("connected");
    expect(deps.release).not.toHaveBeenCalled();
  });

  it("keeps an accepted trusted link consumed when connection later fails", async () => {
    const deps = dependencies({
      consumeUsbApproval: vi.fn(async () => true),
      connect: vi.fn(async () => {
        throw new Error("bundle activation failed");
      }),
    });

    await expect(routeIncomingConnectLink("vibestudio://connect?test", deps)).rejects.toThrow(
      "bundle activation failed"
    );
    expect(deps.markConsumed).toHaveBeenCalledWith("vibestudio://connect?test");
    expect(deps.release).not.toHaveBeenCalled();

    await expect(routeIncomingConnectLink("vibestudio://connect?test", deps)).resolves.toBe(
      "replay"
    );
    expect(deps.present).not.toHaveBeenCalled();
  });
});

describe("mobile connect single-flight", () => {
  it("coalesces a fresh approved link onto a successful active onboarding flow", async () => {
    let finish!: (value: boolean) => void;
    const active = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const connect = vi.fn(async () => active);
    const coalesced = createSuccessfulConnectCoalescer(connect);

    const first = coalesced({ room: "first" });
    const second = coalesced({ room: "second" });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    finish(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("uses the fresh request when the active onboarding flow fails", async () => {
    let finish!: (value: boolean) => void;
    const active = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const connect = vi
      .fn<(request: { room: string }) => Promise<boolean>>()
      .mockImplementationOnce(async () => active)
      .mockResolvedValueOnce(true);
    const coalesced = createSuccessfulConnectCoalescer(connect);

    const first = coalesced({ room: "first" });
    const second = coalesced({ room: "second" });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    finish(false);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(connect).toHaveBeenNthCalledWith(2, { room: "second" });
  });
});
