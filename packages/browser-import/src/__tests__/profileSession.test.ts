import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isProfileRunning,
  profileSessionState,
  restoresSessionOnLaunch,
} from "../readers/profileSession.js";

function profileDir(): string {
  return mkdtempSync(path.join(tmpdir(), "vibestudio-profile-"));
}

describe("isProfileRunning", () => {
  it("treats a Firefox profile with a lock symlink as running", () => {
    const dir = profileDir();
    symlinkSync("127.0.0.1:+12345", path.join(dir, "lock"));
    expect(isProfileRunning("firefox", dir)).toBe(true);
  });

  it("ignores the .parentlock a clean Firefox exit leaves behind", () => {
    const dir = profileDir();
    writeFileSync(path.join(dir, ".parentlock"), "");
    expect(isProfileRunning("firefox", dir)).toBe(false);
  });

  it("accepts the Windows parent.lock name", () => {
    const dir = profileDir();
    writeFileSync(path.join(dir, "parent.lock"), "");
    expect(isProfileRunning("firefox", dir)).toBe(true);
  });

  it("finds a Chromium SingletonLock in the user-data directory", () => {
    const userData = profileDir();
    const profile = path.join(userData, "Default");
    mkdirSync(profile);
    symlinkSync("host-1", path.join(userData, "SingletonLock"));
    expect(isProfileRunning("chromium", profile)).toBe(true);
  });

  it("reports a profile with no lock as not running", () => {
    expect(isProfileRunning("chromium", profileDir())).toBe(false);
    expect(isProfileRunning("firefox", profileDir())).toBe(false);
  });

  it("does not claim liveness for families without a known lock", () => {
    const dir = profileDir();
    writeFileSync(path.join(dir, "lock"), "");
    expect(isProfileRunning("safari", dir)).toBe(false);
  });
});

describe("restoresSessionOnLaunch", () => {
  it("reads the Firefox restore-previous-session preference", () => {
    const dir = profileDir();
    writeFileSync(path.join(dir, "prefs.js"), 'user_pref("browser.startup.page", 3);\n');
    expect(restoresSessionOnLaunch("firefox", dir)).toBe(true);
  });

  it("treats other Firefox startup choices as no restore", () => {
    const dir = profileDir();
    writeFileSync(path.join(dir, "prefs.js"), 'user_pref("browser.startup.page", 1);\n');
    expect(restoresSessionOnLaunch("firefox", dir)).toBe(false);
  });

  it("answers false when the preference file is missing", () => {
    expect(restoresSessionOnLaunch("firefox", profileDir())).toBe(false);
    expect(restoresSessionOnLaunch("chromium", profileDir())).toBe(false);
  });

  it("reads the Chromium continue-where-you-left-off preference", () => {
    const dir = profileDir();
    writeFileSync(
      path.join(dir, "Preferences"),
      JSON.stringify({ session: { restore_on_startup: 1 } })
    );
    expect(restoresSessionOnLaunch("chromium", dir)).toBe(true);
    const other = profileDir();
    writeFileSync(
      path.join(other, "Preferences"),
      JSON.stringify({ session: { restore_on_startup: 5 } })
    );
    expect(restoresSessionOnLaunch("chromium", other)).toBe(false);
  });

  it("survives an unparseable Preferences file", () => {
    const dir = profileDir();
    writeFileSync(path.join(dir, "Preferences"), "{not json");
    expect(restoresSessionOnLaunch("chromium", dir)).toBe(false);
  });
});

describe("profileSessionState", () => {
  it("reports a running profile as open regardless of preferences", () => {
    const dir = profileDir();
    symlinkSync("127.0.0.1:+1", path.join(dir, "lock"));
    expect(profileSessionState("firefox", { path: dir, isDefault: false })).toBe("open");
  });

  it("reports the default profile with restore enabled as restoring", () => {
    const dir = profileDir();
    writeFileSync(path.join(dir, "prefs.js"), 'user_pref("browser.startup.page", 3);\n');
    expect(profileSessionState("firefox", { path: dir, isDefault: true })).toBe("restores");
  });

  it("reports a non-default profile as merely saved even with restore enabled", () => {
    const dir = profileDir();
    writeFileSync(path.join(dir, "prefs.js"), 'user_pref("browser.startup.page", 3);\n');
    expect(profileSessionState("firefox", { path: dir, isDefault: false })).toBe("saved");
  });

  it("reports the default profile without restore as saved", () => {
    const dir = profileDir();
    writeFileSync(path.join(dir, "prefs.js"), 'user_pref("browser.startup.page", 1);\n');
    expect(profileSessionState("firefox", { path: dir, isDefault: true })).toBe("saved");
  });
});
