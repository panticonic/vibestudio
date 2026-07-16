import { describe, expect, it, vi } from "vitest";
import { retireRoutedReach } from "./routedReachRetirement.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("retireRoutedReach", () => {
  it("invalidates callers immediately and disarms routes only after every response drains", async () => {
    const first = deferred();
    const second = deferred();
    const revokeToken = vi.fn();
    const retireCaller = vi.fn((callerId: string) =>
      callerId === "shell:first" ? first.promise : second.promise
    );
    const disarmRoute = vi.fn(async () => undefined);

    const retirement = retireRoutedReach(
      {
        tokenManager: { revokeToken },
        rpcServer: { retireCaller },
        disarmRoute,
      },
      ["shell:first", "shell:first", "agent:second"],
      ["device:first", "device:first", "user:one"]
    );

    expect(revokeToken.mock.calls).toEqual([["shell:first"], ["agent:second"]]);
    expect(disarmRoute).not.toHaveBeenCalled();
    first.resolve();
    await Promise.resolve();
    expect(disarmRoute).not.toHaveBeenCalled();
    second.resolve();
    await retirement;
    expect(disarmRoute.mock.calls).toEqual([["device:first"], ["user:one"]]);
  });

  it("removes unoccupied persisted routes without waiting for a caller", async () => {
    const disarmRoute = vi.fn(async () => undefined);
    await retireRoutedReach(
      {
        tokenManager: { revokeToken: vi.fn() },
        rpcServer: { retireCaller: vi.fn() },
        disarmRoute,
      },
      [],
      ["user:gone"]
    );
    expect(disarmRoute).toHaveBeenCalledWith("user:gone");
  });
});
