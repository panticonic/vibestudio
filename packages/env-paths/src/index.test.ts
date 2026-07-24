import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCentralDataPath, getProfileDataPath } from "./index.js";

describe("profile and instance paths", () => {
  const previousInstanceRoot = process.env["VIBESTUDIO_INSTANCE_ROOT"];

  afterEach(() => {
    if (previousInstanceRoot === undefined) delete process.env["VIBESTUDIO_INSTANCE_ROOT"];
    else process.env["VIBESTUDIO_INSTANCE_ROOT"] = previousInstanceRoot;
  });

  it("defaults instance state to the user profile", () => {
    delete process.env["VIBESTUDIO_INSTANCE_ROOT"];
    expect(getCentralDataPath()).toBe(getProfileDataPath());
  });

  it("isolates instance state without moving profile configuration", () => {
    process.env["VIBESTUDIO_INSTANCE_ROOT"] = "./relative-instance";
    expect(getCentralDataPath()).toBe(path.resolve("relative-instance"));
    expect(getProfileDataPath()).not.toBe(getCentralDataPath());
  });
});
