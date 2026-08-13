import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createBrowserPrivacyPresentationService } from "./browserPrivacyPresentationService.js";

const PROVIDER = "@workspace-extensions/browser-data";
const PANEL = "panel:credentials";

function panelCaller(id: string, userId: string) {
  return createVerifiedCaller(id, "panel", null, null, { userId, handle: userId });
}

function providerContext(initiator = panelCaller(PANEL, "alice")) {
  return {
    caller: {
      runtime: { id: PROVIDER, kind: "extension" as const },
      codeApproved: true as const,
      code: {
        callerId: PROVIDER,
        callerKind: "extension" as const,
        repoPath: "extensions/browser-data",
        effectiveVersion: "v1",
      },
      subject: { userId: "system", handle: "system" },
    },
    authorizingCaller: initiator,
  };
}

function fixture(platform: "desktop" | "mobile" | "headless" = "desktop") {
  const desktopCall = vi.fn(async () => undefined);
  const shell = {
    caller: { runtime: { id: "shell:alice-phone", kind: "shell" } },
    userId: "alice",
    clientPlatform: platform,
  };
  const service = createBrowserPrivacyPresentationService({
    browserDataBrokerRepoPath: "extensions/browser-data",
    getAuthorizingShell: (principalId) => (principalId === PANEL ? shell : null),
    getClientBridge: (callerId) =>
      callerId === shell.caller.runtime.id ? { call: desktopCall } : undefined,
  });
  return { service, shell, desktopCall };
}

describe("browser privacy presentation router", () => {
  it("opens on the exact desktop shell that issued the initiating panel grant", async () => {
    const f = fixture("desktop");
    await expect(
      f.service.handler(providerContext() as never, "open", ["inspect"])
    ).resolves.toBeUndefined();
    expect(f.desktopCall).toHaveBeenCalledWith(
      f.shell.caller.runtime.id,
      "desktopBrowserPrivacyPresentation.open",
      ["inspect"]
    );
  });

  it("opens the packaged manager on the exact authorizing mobile shell", async () => {
    const f = fixture("mobile");
    await expect(
      f.service.handler(providerContext() as never, "open", ["debug"])
    ).resolves.toBeUndefined();
    expect(f.desktopCall).toHaveBeenCalledWith(
      f.shell.caller.runtime.id,
      "mobileBrowserPrivacyPresentation.open",
      ["debug"]
    );
  });

  it("rejects missing ownership, user mismatch, unsupported hosts, and unreviewed providers", async () => {
    const missing = fixture();
    await expect(
      missing.service.handler(
        providerContext(panelCaller("panel:other", "alice")) as never,
        "open",
        []
      )
    ).rejects.toThrow(/no exact live authorizing shell/i);

    const mismatch = fixture();
    await expect(
      mismatch.service.handler(providerContext(panelCaller(PANEL, "bob")) as never, "open", [])
    ).rejects.toThrow(/no exact live authorizing shell/i);

    const headless = fixture("headless");
    await expect(headless.service.handler(providerContext() as never, "open", [])).rejects.toThrow(
      /unavailable.*platform/i
    );

    const unreviewed = fixture();
    const context = providerContext() as ReturnType<typeof providerContext>;
    context.caller.code.repoPath = "extensions/other";
    await expect(unreviewed.service.handler(context as never, "open", [])).rejects.toThrow(
      /exact reviewed browser-data provider/i
    );
  });
});
