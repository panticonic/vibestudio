import { describe, expect, it } from "vitest";
import {
  CHANNEL_DELIVERY_LATENCY_BASELINE_MS,
  channelDeliveryLatencyViolations,
} from "./delivery-latency.js";

describe("channel delivery latency regression gate", () => {
  it("fails only metrics whose observed execution span exceeds the checked-in baseline", () => {
    const metric = "publish-to-recipient-execution";
    expect(
      channelDeliveryLatencyViolations({
        channelDelivery: {
          deliveryLifecycle: {
            latencyHistogram: [
              {
                metric,
                maximum_ms: CHANNEL_DELIVERY_LATENCY_BASELINE_MS[metric] + 1,
              },
              { metric: "call-to-provider-execution", maximum_ms: 20 },
            ],
          },
        },
      })
    ).toEqual([expect.stringContaining(metric)]);
  });

  it("fails closed when collected channel latency diagnostics are malformed", () => {
    expect(
      channelDeliveryLatencyViolations({ channelDelivery: { deliveryLifecycle: {} } })
    ).toEqual([expect.stringContaining("unavailable")]);
    expect(
      channelDeliveryLatencyViolations({
        channelDelivery: {
          deliveryLifecycle: {
            latencyHistogram: [{ metric: "call-to-provider-execution", maximum_ms: Number.NaN }],
          },
        },
      })
    ).toEqual([expect.stringContaining("invalid maximum_ms")]);
  });
});
