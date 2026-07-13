import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChromiumProfileDir } from "./launch.js";

describe("resolveChromiumProfileDir", () => {
  it("keeps the configured profile dir for non-snap chromium", () => {
    expect(
      resolveChromiumProfileDir({
        executablePath: "/usr/bin/chromium",
        profileDir: "/home/alice/.local/state/vibestudio/headless-host",
        homeDir: "/home/alice",
      })
    ).toBe("/home/alice/.local/state/vibestudio/headless-host");
  });

  it("keeps a visible profile dir for snap chromium", () => {
    expect(
      resolveChromiumProfileDir({
        executablePath: "/snap/bin/chromium",
        profileDir: "/home/alice/Vibestudio/headless-host",
        homeDir: "/home/alice",
      })
    ).toBe("/home/alice/Vibestudio/headless-host");
  });

  it("moves hidden home profile dirs under snap common storage", () => {
    expect(
      resolveChromiumProfileDir({
        executablePath: "/snap/bin/chromium",
        profileDir: "/home/alice/.local/state/vibestudio/headless-host",
        homeDir: "/home/alice",
      })
    ).toBe(path.join("/home/alice", "snap", "chromium", "common", "vibestudio", "headless-host"));
  });

  it("preserves the host instance beneath the snap-accessible profile root", () => {
    expect(
      resolveChromiumProfileDir({
        executablePath: "/snap/bin/chromium",
        profileDir: "/home/alice/.local/state/vibestudio/headless-host/instance-headless-one",
        homeDir: "/home/alice",
      })
    ).toBe(
      path.join(
        "/home/alice",
        "snap",
        "chromium",
        "common",
        "vibestudio",
        "headless-host",
        "instance-headless-one"
      )
    );
  });
});
