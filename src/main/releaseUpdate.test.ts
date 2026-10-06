import { describe, expect, it, vi } from "vitest";
import {
  createReleaseUpdateController,
  linuxUpgradeCommandFor,
  newerReleaseVersion,
  updateDeliveryFor,
} from "./releaseUpdate.js";

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  ...extra,
});

describe("release discovery", () => {
  it("offers only a newer stable release", () => {
    expect(newerReleaseVersion(release("v0.2.0"), "0.1.34")).toEqual({ version: "0.2.0" });
    expect(newerReleaseVersion(release("0.2.0"), "0.1.34")).toEqual({ version: "0.2.0" });
    expect(newerReleaseVersion(release("v0.1.34"), "0.1.34")).toBeNull();
    expect(newerReleaseVersion(release("v0.1.0"), "0.1.34")).toBeNull();
    // A draft or prerelease is published for someone else's attention.
    expect(newerReleaseVersion(release("v0.3.0", { draft: true }), "0.1.34")).toBeNull();
    expect(newerReleaseVersion(release("v0.3.0", { prerelease: true }), "0.1.34")).toBeNull();
  });

  it("refuses a payload it cannot read as a version", () => {
    for (const payload of [null, undefined, {}, release("nightly"), release(""), "v1.0.0"]) {
      expect(newerReleaseVersion(payload, "0.1.34")).toBeNull();
    }
  });
});

describe("update delivery", () => {
  const upgrade = linuxUpgradeCommandFor("deb")!;

  const base = {
    packaged: true,
    linuxUpgrade: null,
    canElevate: false,
    developerIdSigned: false,
    brewUpgrade: null,
  };
  const brew = { display: "brew upgrade --cask vibestudio", argv: ["/opt/homebrew/bin/brew"] };

  it("installs in-app on Windows, which has no package manager behind it", () => {
    expect(updateDeliveryFor({ ...base, platform: "win32" })).toEqual({ kind: "in-app" });
  });

  it("installs in-app on macOS only when the build carries a Developer ID", () => {
    // Squirrel refuses an ad-hoc signed build, so the cask is the path there.
    expect(updateDeliveryFor({ ...base, platform: "darwin", developerIdSigned: true })).toEqual({
      kind: "in-app",
    });
    expect(updateDeliveryFor({ ...base, platform: "darwin", brewUpgrade: brew })).toEqual({
      kind: "command",
      upgrade: brew,
      elevate: false,
      canRun: true,
    });
  });

  it("elevates a Linux package manager, and only when it can", () => {
    expect(
      updateDeliveryFor({ ...base, platform: "linux", linuxUpgrade: upgrade, canElevate: true })
    ).toEqual({ kind: "command", upgrade, elevate: true, canRun: true });
    expect(updateDeliveryFor({ ...base, platform: "linux", linuxUpgrade: upgrade })).toEqual({
      kind: "command",
      upgrade,
      elevate: false,
      canRun: false,
    });
  });

  it("still announces a release it cannot install", () => {
    // A Linux tree no package database claims, and an unsigned mac without brew.
    expect(updateDeliveryFor({ ...base, platform: "linux" })).toEqual({ kind: "announce-only" });
    expect(updateDeliveryFor({ ...base, platform: "darwin" })).toEqual({ kind: "download" });
  });

  it("says nothing at all for an unpackaged launch", () => {
    expect(
      updateDeliveryFor({ ...base, platform: "linux", packaged: false, linuxUpgrade: upgrade })
    ).toBeNull();
  });

  it("runs each package manager as root without a nested privilege prefix", () => {
    for (const owner of ["deb", "rpm", "pacman"] as const) {
      const command = linuxUpgradeCommandFor(owner)!;
      expect(command.display).toContain("sudo");
      expect(command.argv.join(" ")).not.toContain("sudo");
      // polkit collects the only consent available, so the manager must not
      // stop to ask a question no one can answer.
      expect(command.argv.join(" ")).toMatch(/-y|--noconfirm/u);
    }
    expect(linuxUpgradeCommandFor(null)).toBeNull();
  });
});

function harness(
  overrides: Partial<Parameters<typeof createReleaseUpdateController>[0]> = {},
  payload: unknown = release("v0.2.0")
) {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const controller = createReleaseUpdateController({
    eventService: {
      emit: (event: string, value: Record<string, unknown>) =>
        emitted.push({ event, payload: value }),
    } as never,
    currentVersion: "0.1.34",
    packaged: true,
    prepareInstall: async () => {},
    platform: "linux",
    linuxUpgrade: () => linuxUpgradeCommandFor("deb"),
    canElevate: () => true,
    runCommand: async () => ({ code: 0, stderr: "" }),
    installedVersion: async () => "0.2.0",
    fetch: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    now: () => 1_000,
    ...overrides,
  });
  return { controller, emitted };
}

describe("release update controller", () => {
  const macDownload =
    "https://github.com/panticonic/vibestudio/releases/download/v0.2.0/Vibestudio-0.2.0-arm64.dmg";
  const macRelease = release("v0.2.0", {
    assets: [
      { name: "Vibestudio-0.2.0-arm64.dmg", state: "uploaded", browser_download_url: macDownload },
    ],
  });

  it("offers the Mac installer and persistent instructions through the real notification action", async () => {
    const openExternal = vi.fn(async () => {});
    const prepareInstall = vi.fn(async () => {});
    const { controller, emitted } = harness(
      { platform: "darwin", openExternal, prepareInstall },
      macRelease
    );
    await controller!.checkNow("startup");
    expect(emitted.at(-1)?.payload).toMatchObject({
      ttl: 0,
      actions: [{ label: "Download update" }],
    });
    await controller!.handleNotificationAction(
      "desktop-release-update",
      "desktop-release-update-install"
    );
    expect(openExternal).toHaveBeenCalledWith(macDownload);
    expect(prepareInstall).toHaveBeenCalledOnce();
    expect(emitted.at(-1)?.payload).toMatchObject({
      id: "desktop-release-update-download-instructions",
      ttl: 0,
      message: expect.stringContaining("choose Replace"),
    });
    controller!.stop();
  });

  it("waits for the Mac installer to be published", async () => {
    const { controller, emitted } = harness({ platform: "darwin" });
    await controller!.checkNow("startup");
    expect(emitted).toEqual([]);
    controller!.stop();
  });

  it("keeps a dismissed version quiet but offers the next release", async () => {
    let payload = release("v0.2.0");
    const { controller, emitted } = harness({
      fetch: (async () => new Response(JSON.stringify(payload))) as typeof fetch,
    });
    await controller!.checkNow("startup");
    await controller!.handleNotificationAction("desktop-release-update", "dismiss");
    emitted.length = 0;
    await controller!.checkNow("interval");
    expect(emitted).toEqual([]);
    payload = release("v0.3.0");
    await controller!.checkNow("interval");
    expect(emitted.at(-1)?.payload["title"]).toBe("Vibestudio 0.3.0 is available");
    controller!.stop();
  });

  it("offers install and copy actions and copies without invoking the installer", async () => {
    const writeClipboard = vi.fn();
    const runCommand = vi.fn();
    const { controller, emitted } = harness({ writeClipboard, runCommand });
    await controller!.checkNow("startup");
    expect(emitted.at(-1)?.payload["actions"]).toMatchObject([
      { label: "Install update" },
      { label: "Copy upgrade command" },
    ]);
    await controller!.handleNotificationAction(
      "desktop-release-update",
      "desktop-release-update-copy-command"
    );
    expect(writeClipboard).toHaveBeenCalledWith(linuxUpgradeCommandFor("deb")!.display);
    expect(runCommand).not.toHaveBeenCalled();
    controller!.stop();
  });

  it("offers only the manual command when Linux cannot authorize the upgrade", async () => {
    const { controller, emitted } = harness({ canElevate: () => false });
    await controller!.checkNow("startup");
    expect(emitted.at(-1)?.payload["actions"]).toMatchObject([{ label: "Copy upgrade command" }]);
    await expect(controller!.requestInstall()).rejects.toThrow("Run this command in a terminal");
    controller!.stop();
  });

  it("reports a lagging repository without claiming an update succeeded", async () => {
    const { controller, emitted } = harness({ installedVersion: async () => "0.1.34-1" });
    await controller!.checkNow("startup");
    await expect(
      controller!.handleNotificationAction(
        "desktop-release-update",
        "desktop-release-update-install"
      )
    ).rejects.toThrow("not available there yet");
    expect(emitted.at(-1)?.payload).toMatchObject({ type: "error", ttl: 0 });
    expect(emitted.some(({ payload }) => payload["title"] === "Vibestudio updated")).toBe(false);
    controller!.stop();
  });

  it("runs the Windows installer through the notification action and propagates restart failures", async () => {
    const downloadUpdate = vi.fn(async () => {});
    const quitAndInstall = vi.fn(async () => {
      throw new Error("Installer could not restart");
    });
    const { controller, emitted } = harness({
      platform: "win32",
      installer: () => ({ downloadUpdate, quitAndInstall }),
    });
    await controller!.checkNow("startup");
    await expect(
      controller!.handleNotificationAction(
        "desktop-release-update",
        "desktop-release-update-install"
      )
    ).rejects.toThrow("Installer could not restart");
    expect(downloadUpdate).toHaveBeenCalledOnce();
    expect(emitted.at(-1)?.payload["message"]).toBe("Installer could not restart");
    controller!.stop();
  });

  it("restarts after a package update through the completion notification", async () => {
    const restart = vi.fn(async () => {});
    const { controller } = harness({ restart });
    await controller!.checkNow("startup");
    await controller!.handleNotificationAction(
      "desktop-release-update",
      "desktop-release-update-install"
    );
    await controller!.handleNotificationAction(
      "desktop-release-update-install-status",
      "desktop-release-update-restart"
    );
    expect(restart).toHaveBeenCalledOnce();
    controller!.stop();
  });
  it("announces a newer release with the action its platform can perform", async () => {
    const { controller, emitted } = harness();

    await controller!.checkNow("startup");

    const shown = emitted.find((entry) => entry.event === "notification:show");
    expect(shown?.payload["title"]).toBe("Vibestudio 0.2.0 is available");
    expect(shown?.payload["actions"]).toMatchObject([
      { id: "desktop-release-update-install" },
      { id: "desktop-release-update-copy-command" },
    ]);
  });

  it("names the command when it cannot raise it to root itself", async () => {
    const { controller, emitted } = harness({ canElevate: () => false });

    await controller!.checkNow("startup");

    const shown = emitted.find((entry) => entry.event === "notification:show");
    expect(String(shown?.payload["message"])).toContain("apt install --only-upgrade vibestudio");
  });

  it("asks for a restart after the package manager succeeds", async () => {
    const { controller, emitted } = harness();

    await controller!.checkNow("startup");
    await controller!.requestInstall();

    const restart = emitted.filter((entry) => entry.event === "notification:show").at(-1);
    expect(restart?.payload["title"]).toBe("Vibestudio updated");
    expect(restart?.payload["actions"]).toMatchObject([{ id: "desktop-release-update-restart" }]);
  });

  it("tells the user to run it themselves when polkit refuses", async () => {
    const { controller } = harness({
      runCommand: async () => ({ code: 126, stderr: "" }),
    });

    await controller!.checkNow("startup");
    await expect(controller!.requestInstall()).rejects.toThrow(/did not authorize.*sudo apt/su);
  });

  it("dismisses a stale notice once the installation is current", async () => {
    const { controller, emitted } = harness({}, release("v0.1.34"));

    await controller!.checkNow("startup");

    expect(emitted.map((entry) => entry.event)).toEqual(["notification:dismiss"]);
  });

  it("never reports a failed check as an update", async () => {
    const { controller, emitted } = harness({
      fetch: (async () => new Response("rate limited", { status: 403 })) as typeof fetch,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await controller!.checkNow("interval");

    expect(emitted).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("is absent for an unpackaged launch", () => {
    expect(harness({ packaged: false }).controller).toBeNull();
  });
});

it("does not invoke an installer when retaining the workspace host fails", async () => {
  const runCommand = vi.fn();
  const { controller } = harness({
    prepareInstall: async () => {
      throw new Error("Could not preserve workspace host");
    },
    runCommand,
  });
  await controller!.checkNow("startup");
  await expect(controller!.requestInstall()).rejects.toThrow("Could not preserve workspace host");
  expect(runCommand).not.toHaveBeenCalled();
});
it("preserves the outgoing host before invoking the package manager", async () => {
  const order: string[] = [];
  const { controller } = harness({
    prepareInstall: async () => {
      order.push("retain");
    },
    runCommand: async () => {
      order.push("install");
      return { code: 0, stderr: "" };
    },
  });
  await controller!.checkNow("startup");
  await controller!.requestInstall();
  expect(order).toEqual(["retain", "install"]);
});
