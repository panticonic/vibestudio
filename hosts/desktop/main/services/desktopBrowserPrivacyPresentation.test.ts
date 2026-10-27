import { describe, expect, it, vi } from "vitest";
import { createDesktopBrowserPrivacyPresentation } from "./desktopBrowserPrivacyPresentation.js";

describe("desktop browser privacy presentation", () => {
  it("opens only a validated section in the host-owned manager", async () => {
    const open = vi.fn();
    const service = createDesktopBrowserPrivacyPresentation({
      openSettings: open,
    });
    await expect(service.handler({} as never, "open", ["autofill"])).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledWith("autofill");
    await expect(service.handler({} as never, "open", ["evil"])).rejects.toThrow();
  });

  it("fails closed while the protected-data manager is unavailable", async () => {
    const service = createDesktopBrowserPrivacyPresentation({
      openSettings: () => {
        throw new Error("Browser data settings unavailable");
      },
    });
    await expect(service.handler({} as never, "open", ["passwords"])).rejects.toThrow(
      /unavailable/i
    );
  });
});
