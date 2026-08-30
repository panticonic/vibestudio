import { describe, expect, it } from "vitest";
import {
  IROH_CATASTROPHIC_ACTIVE_REQUEST_CEILING,
  IROH_CATASTROPHIC_LOGICAL_SESSION_CEILING,
  IROH_CATASTROPHIC_PENDING_STREAM_HEADER_CEILING,
} from "./resourcePolicy.js";
import { IROH_CONCURRENT_BI_STREAM_WINDOW } from "./nodeEndpoint.js";

describe("Iroh catastrophic resource policy", () => {
  it("does not turn the former startup thresholds into product limits", () => {
    expect(IROH_CATASTROPHIC_LOGICAL_SESSION_CEILING).toBeGreaterThanOrEqual(65_536);
    expect(IROH_CATASTROPHIC_ACTIVE_REQUEST_CEILING).toBeGreaterThanOrEqual(1_048_576);
  });

  it("does not impose a pending-header boundary below native QUIC admission", () => {
    expect(IROH_CATASTROPHIC_PENDING_STREAM_HEADER_CEILING).toBeGreaterThanOrEqual(
      Number(IROH_CONCURRENT_BI_STREAM_WINDOW)
    );
  });
});
