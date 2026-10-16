import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LINUX_DESKTOP_NAME } from "./desktopIdentity.js";

describe("Linux desktop identity", () => {
  it("names the .desktop entry the packager writes for the executable", () => {
    const builder = readFileSync(join(__dirname, "../../../electron-builder.yml"), "utf8");
    const executable = /^linux:\n(?:[ \t].*\n|\n)*?[ \t]+executableName:\s*(\S+)/mu.exec(
      builder
    )?.[1];
    expect(executable).toBeDefined();
    expect(LINUX_DESKTOP_NAME).toBe(`${executable}.desktop`);
  });
});
