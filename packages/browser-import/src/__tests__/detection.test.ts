import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Test Firefox profiles.ini parsing
import { detectFirefoxProfiles } from "../detection/firefox.js";
import { detectChromiumProfiles } from "../detection/chromium.js";
import { BROWSER_PATHS, getBrowserDataDirs, packagingLabel } from "../detection/paths.js";

describe("Firefox profile detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-test-firefox-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses profiles.ini with multiple profiles", () => {
    // Create profiles.ini
    const ini = `
[General]
StartWithLastProfile=1

[Profile0]
Name=default
IsRelative=1
Path=abcd1234.default
Default=1

[Profile1]
Name=dev-edition
IsRelative=1
Path=efgh5678.dev-edition
`;
    fs.writeFileSync(path.join(tmpDir, "profiles.ini"), ini);

    // Create profile directories
    fs.mkdirSync(path.join(tmpDir, "abcd1234.default"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "efgh5678.dev-edition"), { recursive: true });

    const profiles = detectFirefoxProfiles(tmpDir);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]!.displayName).toBe("default");
    expect(profiles[0]!.isDefault).toBe(true);
    expect(profiles[1]!.displayName).toBe("dev-edition");
    expect(profiles[1]!.isDefault).toBe(false);
  });

  it("lets installs.ini override the legacy Default flag", () => {
    // The installation launches `live`; `stale` still carries Default=1 from an
    // older Firefox. Honouring both marked two profiles default, so an
    // abandoned profile claimed it would reopen on launch.
    fs.writeFileSync(
      path.join(tmpDir, "profiles.ini"),
      `
[Profile0]
Name=stale
IsRelative=1
Path=aaaa1111.stale
Default=1

[Profile1]
Name=live
IsRelative=1
Path=bbbb2222.live
`
    );
    fs.writeFileSync(
      path.join(tmpDir, "installs.ini"),
      "[Install0]\nDefault=bbbb2222.live\nLocked=1\n"
    );
    fs.mkdirSync(path.join(tmpDir, "aaaa1111.stale"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "bbbb2222.live"), { recursive: true });

    const profiles = detectFirefoxProfiles(tmpDir);
    expect(profiles.filter((profile) => profile.isDefault)).toHaveLength(1);
    expect(profiles.find((profile) => profile.isDefault)?.displayName).toBe("live");
  });

  it("returns empty array for missing profiles.ini", () => {
    const profiles = detectFirefoxProfiles(tmpDir);
    expect(profiles).toHaveLength(0);
  });

  it("skips profiles with missing directories", () => {
    const ini = `
[Profile0]
Name=exists
IsRelative=1
Path=exists.profile

[Profile1]
Name=missing
IsRelative=1
Path=missing.profile
`;
    fs.writeFileSync(path.join(tmpDir, "profiles.ini"), ini);
    fs.mkdirSync(path.join(tmpDir, "exists.profile"), { recursive: true });

    const profiles = detectFirefoxProfiles(tmpDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.displayName).toBe("exists");
  });

  it("marks first profile as default when none are marked", () => {
    const ini = `
[Profile0]
Name=first
IsRelative=1
Path=first.profile

[Profile1]
Name=second
IsRelative=1
Path=second.profile
`;
    fs.writeFileSync(path.join(tmpDir, "profiles.ini"), ini);
    fs.mkdirSync(path.join(tmpDir, "first.profile"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "second.profile"), { recursive: true });

    const profiles = detectFirefoxProfiles(tmpDir);
    expect(profiles[0]!.isDefault).toBe(true);
    expect(profiles[1]!.isDefault).toBe(false);
  });

  it("finds profiles.ini in parent directory (macOS/Windows layout)", () => {
    const profilesDir = path.join(tmpDir, "Profiles");
    fs.mkdirSync(profilesDir);

    const ini = `
[Profile0]
Name=test
IsRelative=1
Path=Profiles/test.profile
`;
    fs.writeFileSync(path.join(tmpDir, "profiles.ini"), ini);
    fs.mkdirSync(path.join(tmpDir, "Profiles", "test.profile"), { recursive: true });

    const profiles = detectFirefoxProfiles(profilesDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.displayName).toBe("test");
  });
});

describe("Chromium profile detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-test-chromium-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects profiles from Local State info_cache", () => {
    const localState = {
      profile: {
        info_cache: {
          Default: { name: "Person 1", gaia_name: "John Doe" },
          "Profile 1": { name: "Work", gaia_name: "" },
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, "Local State"), JSON.stringify(localState));

    // Create profile dirs
    fs.mkdirSync(path.join(tmpDir, "Default"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "Profile 1"), { recursive: true });

    const profiles = detectChromiumProfiles(tmpDir);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]!.displayName).toBe("John Doe");
    expect(profiles[0]!.isDefault).toBe(true);
    expect(profiles[1]!.displayName).toBe("Work");
    expect(profiles[1]!.isDefault).toBe(false);
  });

  it("falls back to directory scanning when Local State is missing", () => {
    // Create Default profile with Preferences
    const defaultDir = path.join(tmpDir, "Default");
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(path.join(defaultDir, "Preferences"), "{}");

    // Create Profile 1 with Preferences
    const profile1Dir = path.join(tmpDir, "Profile 1");
    fs.mkdirSync(profile1Dir, { recursive: true });
    fs.writeFileSync(path.join(profile1Dir, "Preferences"), "{}");

    const profiles = detectChromiumProfiles(tmpDir);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]!.id).toBe("Default");
    expect(profiles[0]!.isDefault).toBe(true);
    expect(profiles[1]!.id).toBe("Profile 1");
  });

  it("returns empty array for empty directory", () => {
    const profiles = detectChromiumProfiles(tmpDir);
    expect(profiles).toHaveLength(0);
  });

  it("skips directories without Preferences file in fallback mode", () => {
    // Create Default without Preferences (should be skipped)
    fs.mkdirSync(path.join(tmpDir, "Default"), { recursive: true });

    // Create Profile 1 with Preferences
    const profile1Dir = path.join(tmpDir, "Profile 1");
    fs.mkdirSync(profile1Dir, { recursive: true });
    fs.writeFileSync(path.join(profile1Dir, "Preferences"), "{}");

    const profiles = detectChromiumProfiles(tmpDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.id).toBe("Profile 1");
  });
});

describe("packaged browser roots", () => {
  it("offers sandboxed roots alongside the native one on Linux", () => {
    if (process.platform !== "linux") return;
    const chrome = BROWSER_PATHS.find((entry) => entry.name === "chrome");
    const roots = getBrowserDataDirs(chrome!).map((root) => root.path);
    // A stale native install must not be the only place we look: Flatpak
    // redirects the entire config tree.
    expect(roots.length).toBeGreaterThan(1);
    expect(roots.some((root) => root.includes("/.var/app/com.google.Chrome/"))).toBe(true);
  });

  it("names the packaging, preferring an explicit label over the path shape", () => {
    expect(
      packagingLabel({ path: "/home/u/.var/app/com.google.Chrome/config/google-chrome" })
    ).toBe("Flatpak");
    expect(packagingLabel({ path: "/home/u/snap/chromium/common/chromium" })).toBe("Snap");
    expect(packagingLabel({ path: "/home/u/.config/google-chrome" })).toBeUndefined();
    expect(
      packagingLabel({
        path: "/home/u/.var/app/io.github.x/config/chromium",
        label: "ungoogled, Flatpak",
      })
    ).toBe("ungoogled, Flatpak");
  });

  it("returns a single root for browsers with one location", () => {
    const entry = {
      name: "chrome" as const,
      family: "chromium" as const,
      displayName: "x",
      linux: "/one",
    };
    expect(getBrowserDataDirs(entry)).toEqual([{ path: "/one" }]);
  });
});
