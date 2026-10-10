import { describe, expect, it } from "vitest";
import { isAuthorizedChromeAppSource, normalizeAppSourcePath } from "./chromeTrust.js";

const GRANTS = { chromeApps: ["apps/shell", "apps/mobile"] };

describe("workspace-owned app trust", () => {
  it("authorizes only sources in the owning manifest", () => {
    expect(isAuthorizedChromeAppSource("apps/shell", GRANTS)).toBe(true);
    expect(isAuthorizedChromeAppSource("apps/mobile", GRANTS)).toBe(true);
    expect(isAuthorizedChromeAppSource("apps/evil", GRANTS)).toBe(false);
    expect(isAuthorizedChromeAppSource("apps/remote-cli", GRANTS)).toBe(false);
    expect(isAuthorizedChromeAppSource("apps/shell", { chromeApps: [] })).toBe(false);
  });

  it("keeps different workspaces' grants independent", () => {
    const personal = { chromeApps: [] };
    expect(isAuthorizedChromeAppSource("apps/shell", GRANTS)).toBe(true);
    expect(isAuthorizedChromeAppSource("apps/shell", personal)).toBe(false);
    expect(isAuthorizedChromeAppSource("apps/shell", GRANTS)).toBe(true);
  });

  it("normalizes both declared and checked sources", () => {
    const grants = { chromeApps: ["workspace/apps/shell"] };
    expect(isAuthorizedChromeAppSource("apps/shell", grants)).toBe(true);
    expect(isAuthorizedChromeAppSource("workspace/apps/shell/", grants)).toBe(true);
  });

  it("denies missing sources even when the manifest grants chrome authority", () => {
    expect(isAuthorizedChromeAppSource(null, GRANTS)).toBe(false);
    expect(isAuthorizedChromeAppSource(undefined, GRANTS)).toBe(false);
    expect(isAuthorizedChromeAppSource("", GRANTS)).toBe(false);
  });
});

it("normalizes separators, leading slashes, and workspace prefixes", () => {
  expect(normalizeAppSourcePath("workspace\\apps\\shell")).toBe("apps/shell");
  expect(normalizeAppSourcePath("/apps/shell/")).toBe("apps/shell");
});
