import { describe, expect, it, vi } from "vitest";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { gatewayMethods } from "./gateway.js";

describe("streamed gateway contract", () => {
  it("preserves a live response and forwards body cancellation to the transport", async () => {
    const canceled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: canceled });
    const response = new Response(body, { headers: { "content-type": "image/svg+xml" } });
    const invoke = vi.fn(async () => response);
    const client = createTypedServiceClient("gateway", gatewayMethods, invoke);

    const result: Response = await client.fetch({
      path: "/__vibestudio/unit-icon?source=about/new",
    });
    expect(invoke).toHaveBeenCalledWith("gateway", "fetch", [
      { path: "/__vibestudio/unit-icon?source=about/new" },
    ]);
    expect(result).toBe(response);
    expect(result.body).toBe(body);
    expect(result.bodyUsed).toBe(false);
    expect(result.body?.locked).toBe(false);
    await result.body?.cancel("view ended");
    expect(canceled).toHaveBeenCalledWith("view ended");
  });

  it("rejects buffered-body descriptors before dispatch and JSON response lookalikes", async () => {
    const invoke = vi.fn(async () => ({ ok: true, status: 200, body: "not a stream" }));
    const client = createTypedServiceClient("gateway", gatewayMethods, invoke);
    await expect(
      // @ts-expect-error Request bodies belong to the transport, not the descriptor.
      client.fetch({ path: "/asset", body: "buffered" })
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    await expect(client.fetch({ path: "/asset" })).rejects.toThrow();
  });
});
