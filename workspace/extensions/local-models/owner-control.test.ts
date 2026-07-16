import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpOwnerControlTransport, type OwnerControlListener } from "./owner-control.js";

const listeners: OwnerControlListener[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});

describe("HTTP owner control transport", () => {
  it("dispatches authenticated cold-load requests", async () => {
    const transport = createHttpOwnerControlTransport(fetch);
    const handler = vi.fn(async () => ({ baseUrl: "http://127.0.0.1:43117/v1" }));
    const listener = await transport.listen("secret", handler);
    listeners.push(listener);

    await expect(
      transport.request(listener.port, "secret", {
        action: "ensureLoaded",
        slug: "lfm2.5-1.2b",
      })
    ).resolves.toEqual({ baseUrl: "http://127.0.0.1:43117/v1" });
    expect(handler).toHaveBeenCalledWith({
      action: "ensureLoaded",
      slug: "lfm2.5-1.2b",
    });
  });

  it("dispatches validated library mutations to the machine owner", async () => {
    const transport = createHttpOwnerControlTransport(fetch);
    const handler = vi.fn(async () => ({ library: { kind: "ok" as const } }));
    const listener = await transport.listen("secret", handler);
    listeners.push(listener);
    const request = {
      action: "library" as const,
      request: {
        operation: "setModelConfig" as const,
        slug: "toy",
        config: { contextLength: 4096, gpuLayers: null },
      },
    };

    await expect(transport.request(listener.port, "secret", request)).resolves.toEqual({
      library: { kind: "ok" },
    });
    expect(handler).toHaveBeenCalledWith(request);
  });

  it("rejects callers without the machine-local api key", async () => {
    const transport = createHttpOwnerControlTransport(fetch);
    const handler = vi.fn(async () => ({ restarted: true as const }));
    const listener = await transport.listen("secret", handler);
    listeners.push(listener);

    await expect(
      transport.request(listener.port, "wrong", { action: "restart", kind: "utility" })
    ).rejects.toThrow(/unauthorized/);
    expect(handler).not.toHaveBeenCalled();
  });
});
