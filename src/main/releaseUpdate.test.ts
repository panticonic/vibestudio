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

  it("installs in-app where no package manager owns the install", () => {
    for (const platform of ["win32", "darwin"] as const) {
      expect(
        updateDeliveryFor({ platform, packaged: true, linuxUpgrade: null, canElevate: false })
      ).toEqual({ kind: "in-app" });
    }
  });

  it("defers to the package manager that owns a Linux install", () => {
    expect(
      updateDeliveryFor({
        platform: "linux",
        packaged: true,
        linuxUpgrade: upgrade,
        canElevate: true,
      })
    ).toEqual({ kind: "privileged-command", upgrade, canElevate: true });
  });

  it("stays silent where there is nothing it could install", () => {
    // A development or linked launch, and a Linux tree no package database claims.
    expect(
      updateDeliveryFor({
        platform: "linux",
        packaged: false,
        linuxUpgrade: upgrade,
        canElevate: true,
      })
    ).toBeNull();
    expect(
      updateDeliveryFor({ platform: "linux", packaged: true, linuxUpgrade: null, canElevate: true })
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
    platform: "linux",
    linuxUpgrade: () => linuxUpgradeCommandFor("deb"),
    canElevate: () => true,
    runPrivileged: async () => ({ code: 0, stderr: "" }),
    fetch: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    now: () => 1_000,
    ...overrides,
  });
  return { controller, emitted };
}

describe("release update controller", () => {
  it("announces a newer release with the action its platform can perform", async () => {
    const { controller, emitted } = harness();

    await controller!.checkNow("startup");

    const shown = emitted.find((entry) => entry.event === "notification:show");
    expect(shown?.payload["title"]).toBe("Vibestudio 0.2.0 is available");
    expect(shown?.payload["actions"]).toMatchObject([{ id: "desktop-release-update-install" }]);
  });

  it("offers the command to copy when nothing can raise it to root", async () => {
    const { controller, emitted } = harness({ canElevate: () => false });

    await controller!.checkNow("startup");

    const shown = emitted.find((entry) => entry.event === "notification:show");
    expect(shown?.payload["actions"]).toMatchObject([{ id: "desktop-release-update-copy" }]);
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
      runPrivileged: async () => ({ code: 126, stderr: "" }),
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
