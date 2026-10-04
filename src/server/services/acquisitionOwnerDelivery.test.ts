import { describe, expect, it, vi } from "vitest";
import {
  createAcquisitionOwnerNotifier,
  type AcquisitionOwnerDeliveryRoute,
} from "./acquisitionOwnerDelivery.js";

const owner = "do:workers/agent:Agent:one";
const ref = { source: "workers/agent", className: "Agent", objectKey: "one" };
function fixture() {
  const route: AcquisitionOwnerDeliveryRoute = {
    storageIncarnation: vi.fn(() => "host-incarnation"),
    requestWake: vi.fn(async (): Promise<"accepted" | "stale"> => "accepted"),
    dispatchHint: vi.fn(async () => undefined),
    notifyAlarmChanged: vi.fn(),
  };
  const getRoute = vi.fn(() => route);
  const notify = createAcquisitionOwnerNotifier(getRoute);
  const signal = new AbortController().signal;
  return { route, getRoute, notify, signal };
}

describe("canonical acquisition owner wake projection", () => {
  it("hands registered owners to the durable wake before scheduling a pass", async () => {
    const f = fixture();
    const order: string[] = [];
    vi.mocked(f.route.requestWake).mockImplementation(async () => {
      order.push("durable");
      return "accepted";
    });
    vi.mocked(f.route.notifyAlarmChanged).mockImplementation(() => order.push("schedule"));
    await f.notify(owner, "acq:original", f.signal);
    expect(f.route.storageIncarnation).toHaveBeenCalledExactlyOnceWith(ref);
    expect(f.route.requestWake).toHaveBeenCalledExactlyOnceWith(ref, "host-incarnation", f.signal);
    expect(order).toEqual(["durable", "schedule"]);
    expect(f.route.dispatchHint).not.toHaveBeenCalled();
  });

  it("keeps the original callback for generic owners without a registered wake source", async () => {
    const f = fixture();
    vi.mocked(f.route.requestWake).mockResolvedValue("stale");
    await f.notify(owner, "acq:original", f.signal);
    expect(f.route.dispatchHint).toHaveBeenCalledExactlyOnceWith(ref, "acq:original", f.signal);
    expect(f.route.notifyAlarmChanged).not.toHaveBeenCalled();
  });

  it("propagates an unavailable route instead of reporting a successful handoff", async () => {
    const notify = createAcquisitionOwnerNotifier(() => null);
    await expect(notify(owner, "acq:original", new AbortController().signal)).rejects.toThrow(
      "routing is not ready"
    );
  });

  it("propagates the original failed durable projection without switching delivery paths", async () => {
    const f = fixture();
    const failure = new Error("canonical wake write rejected");
    vi.mocked(f.route.requestWake).mockRejectedValue(failure);
    await expect(f.notify(owner, "acq:original", f.signal)).rejects.toBe(failure);
    expect(f.route.dispatchHint).not.toHaveBeenCalled();
    expect(f.route.notifyAlarmChanged).not.toHaveBeenCalled();
  });

  it("propagates the original generic receiver failure", async () => {
    const f = fixture();
    const failure = new Error("generic receiver disconnected");
    vi.mocked(f.route.requestWake).mockResolvedValue("stale");
    vi.mocked(f.route.dispatchHint).mockRejectedValue(failure);
    await expect(f.notify(owner, "acq:original", f.signal)).rejects.toBe(failure);
  });

  it("refuses an invalid wake result without manufacturing a fallback", async () => {
    const f = fixture();
    vi.mocked(f.route.requestWake).mockResolvedValue("foreign" as "accepted");
    await expect(f.notify(owner, "acq:original", f.signal)).rejects.toThrow("invalid result");
    expect(f.route.dispatchHint).not.toHaveBeenCalled();
  });

  it("does not admit work after explicit delivery shutdown", async () => {
    const f = fixture();
    const lifetime = new AbortController();
    const reason = new Error("host delivery shutdown");
    lifetime.abort(reason);
    await expect(f.notify(owner, "acq:original", lifetime.signal)).rejects.toBe(reason);
    expect(f.getRoute).not.toHaveBeenCalled();
  });

  it("leaves non-DO response delivery with its existing in-band owner", async () => {
    const f = fixture();
    await f.notify("panel:one", "acq:original", f.signal);
    expect(f.getRoute).not.toHaveBeenCalled();
  });
});
