import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appSourceFromCallerId,
  hasWorkspaceAppTrust,
  isAuthorizedChromeAppCaller,
  isAuthorizedChromeAppSource,
  normalizeAppSourcePath,
  setWorkspaceAppTrust,
} from "./chromeTrust.js";

/**
 * Workspace app trust is manifest-declared (meta/vibestudio.yml `trust.*`) and
 * seeded per process — nothing is hardcoded here. Seeded processes enforce the
 * declared lists strictly; a process that never loaded a manifest (remote thin
 * client) defers to the server-granted capability the check is conjoined with.
 */
const GRANTS = {
  chromeApps: ["apps/shell", "apps/mobile"],
};

afterEach(() => {
  setWorkspaceAppTrust(null);
  vi.restoreAllMocks();
});

describe("seeded workspace app trust (manifest-declared)", () => {
  it("authorizes exactly the declared chrome apps", () => {
    setWorkspaceAppTrust(GRANTS);
    expect(hasWorkspaceAppTrust()).toBe(true);
    expect(isAuthorizedChromeAppSource("apps/shell")).toBe(true);
    expect(isAuthorizedChromeAppSource("apps/mobile")).toBe(true);
    expect(isAuthorizedChromeAppSource("apps/evil")).toBe(false);
    expect(isAuthorizedChromeAppSource("apps/remote-cli")).toBe(false);
  });

  it("denies everything when the manifest declares an empty list", () => {
    setWorkspaceAppTrust({ chromeApps: [] });
    expect(isAuthorizedChromeAppSource("apps/shell")).toBe(false);
  });

  it("normalizes declared and checked sources the same way", () => {
    setWorkspaceAppTrust({
      chromeApps: ["workspace/apps/shell"],
    });
    expect(isAuthorizedChromeAppSource("apps/shell")).toBe(true);
    expect(isAuthorizedChromeAppSource("workspace/apps/shell")).toBe(true);
    expect(isAuthorizedChromeAppSource("apps/shell/")).toBe(true);
  });

  it("re-seeding replaces the previous grants (meta-change reload)", () => {
    setWorkspaceAppTrust(GRANTS);
    setWorkspaceAppTrust({ chromeApps: ["apps/kiosk"] });
    expect(isAuthorizedChromeAppSource("apps/shell")).toBe(false);
    expect(isAuthorizedChromeAppSource("apps/kiosk")).toBe(true);
  });
});

describe("unseeded process (no workspace manifest loaded)", () => {
  it("defers non-empty sources to the host-granted capability, with a one-time warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(hasWorkspaceAppTrust()).toBe(false);
    expect(isAuthorizedChromeAppSource("apps/anything")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    // Second check does not warn again.
    expect(isAuthorizedChromeAppSource("apps/other")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still refuses null/empty sources", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isAuthorizedChromeAppSource(null)).toBe(false);
    expect(isAuthorizedChromeAppSource(undefined)).toBe(false);
    expect(isAuthorizedChromeAppSource("")).toBe(false);
  });
});

describe("caller-id → app source resolution", () => {
  it("resolves device-scoped app callerIds", () => {
    expect(appSourceFromCallerId("app:apps/shell:device-1")).toBe("apps/shell");
  });

  it("resolves workspace-app package names via the shared scope constant", () => {
    expect(appSourceFromCallerId("@workspace-apps/shell")).toBe("apps/shell");
  });

  it("resolves bare repo paths", () => {
    expect(appSourceFromCallerId("apps/shell")).toBe("apps/shell");
    expect(appSourceFromCallerId("workspace/apps/shell")).toBe("apps/shell");
  });

  it("returns null for non-app callerIds", () => {
    expect(appSourceFromCallerId("panel:123")).toBeNull();
    expect(appSourceFromCallerId("shell")).toBeNull();
  });

  it("isAuthorizedChromeAppCaller combines resolution with seeded grants", () => {
    setWorkspaceAppTrust(GRANTS);
    expect(isAuthorizedChromeAppCaller("app:apps/shell:device-1")).toBe(true);
    expect(isAuthorizedChromeAppCaller("@workspace-apps/mobile")).toBe(true);
    expect(isAuthorizedChromeAppCaller("@workspace-apps/evil")).toBe(false);
    // Explicit source wins over callerId parsing.
    expect(isAuthorizedChromeAppCaller("whatever", "apps/shell")).toBe(true);
    expect(isAuthorizedChromeAppCaller("app:apps/shell:device-1", "apps/evil")).toBe(false);
  });
});

describe("normalizeAppSourcePath", () => {
  it("normalizes separators, leading slashes, and the workspace/ prefix", () => {
    expect(normalizeAppSourcePath("workspace\\apps\\shell")).toBe("apps/shell");
    expect(normalizeAppSourcePath("/apps/shell/")).toBe("apps/shell");
  });
});
