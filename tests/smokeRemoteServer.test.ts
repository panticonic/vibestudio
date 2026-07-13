import { describe, expect, it } from "vitest";

import { requireRootInvite } from "../scripts/cli/lib/smoke-remote-server.mjs";

describe("smoke remote-server root invite selection", () => {
  it("selects the platform-specific invite from the ready-file contract", () => {
    const ready = {
      rootInvites: {
        desktop: { pairUrl: "https://vibestudio.app/pair#desktop" },
        mobile: { pairUrl: "https://vibestudio.app/pair#mobile" },
      },
    };

    expect(requireRootInvite(ready, "desktop")).toBe(ready.rootInvites.desktop);
    expect(requireRootInvite(ready, "mobile")).toBe(ready.rootInvites.mobile);
  });

  it("fails when the fresh hub did not publish root invites", () => {
    expect(() => requireRootInvite({ rootInvites: null }, "desktop")).toThrow(
      "did not publish the desktop root invite"
    );
  });
});
