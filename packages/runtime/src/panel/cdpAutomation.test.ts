import { describe, expect, it, vi } from "vitest";
import { createCdpAutomation } from "./cdpAutomation.js";

describe("createCdpAutomation screenshot", () => {
  it("uses the one-RPC host capture path and returns its typed metadata", async () => {
    const shot = {
      data: "iVBORw0KGgo=",
      mimeType: "image/png" as const,
      width: 1280,
      height: 720,
    };
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "panelCdp.screenshot") return shot;
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const cdp = createCdpAutomation({ call } as never, "panel:child");

    await expect(cdp.screenshot({ format: "png", quality: 90 })).resolves.toEqual(shot);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("main", "panelCdp.screenshot", [
      "panel:child",
      { format: "png", quality: 90 },
    ]);
    expect(call.mock.calls.some(([, method]) => method === "panelCdp.getCdpEndpoint")).toBe(false);
  });
});
