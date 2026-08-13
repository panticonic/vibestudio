import { describe, expect, it, vi } from "vitest";
import { createDesktopBrowserPrivacyPresentation } from "./desktopBrowserPrivacyPresentation.js";

describe("desktop browser privacy presentation", () => {
  it("opens only a validated section in the host-owned manager", async () => {
    const open = vi.fn();
    const service = createDesktopBrowserPrivacyPresentation({
      getPrivacyManager: () => ({ open }),
    });
    await expect(service.handler({} as never, "open", ["formFill"])).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledWith("formFill");
    await expect(service.handler({} as never, "open", ["evil"])).rejects.toThrow();
  });

  it("fails closed while the protected-data manager is unavailable", async () => {
    const service = createDesktopBrowserPrivacyPresentation({ getPrivacyManager: () => null });
    await expect(service.handler({} as never, "open", ["credentials"])).rejects.toThrow(
      /unavailable/i
    );
  });
});
