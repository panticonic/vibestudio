import * as path from "node:path";
import { Module } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCentralDataPath,
  getProfileDataPath,
  getSharedDerivedDataPath,
  getUserDataPath,
  setUserDataPath,
} from "./index.js";

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
    expect(getSharedDerivedDataPath()).toBe(path.join(getProfileDataPath(), "derived-cache"));
  });
});

describe("runtime-owned user-data paths", () => {
  const loader = Module as unknown as { _load(request: string, ...args: unknown[]): unknown };
  let originalPath: string;
  let electronVersion: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalPath = getUserDataPath();
    electronVersion = Object.getOwnPropertyDescriptor(process.versions, "electron");
    setUserDataPath("");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (electronVersion) Object.defineProperty(process.versions, "electron", electronVersion);
    else Reflect.deleteProperty(process.versions, "electron");
    setUserDataPath(originalPath);
  });
  function interceptElectron(app: unknown) {
    const original = loader._load;
    let requests = 0;
    vi.spyOn(loader, "_load").mockImplementation((request, ...args) => {
      if (request === "electron") {
        requests += 1;
        return app;
      }
      return original.call(Module, request, ...args);
    });
    return () => requests;
  }
  it("uses the profile in Node without acquiring an Electron executable", () => {
    Reflect.deleteProperty(process.versions, "electron");
    const requests = interceptElectron({
      app: {
        getPath: () => {
          throw new Error("Node must not own native app paths");
        },
      },
    });
    expect(getUserDataPath()).toBe(getProfileDataPath());
    expect(requests()).toBe(0);
  });
  it("reads the native app path in an actual Electron process", () => {
    Object.defineProperty(process.versions, "electron", {
      configurable: true,
      value: "test-electron-runtime",
    });
    const getPath = vi.fn(() => "/native-electron/user-data");
    const requests = interceptElectron({ app: { getPath } });
    expect(getUserDataPath()).toBe("/native-electron/user-data");
    expect(getPath).toHaveBeenCalledWith("userData");
    expect(requests()).toBe(1);
  });
  it("keeps explicit headless ownership ahead of native app lookup", () => {
    Object.defineProperty(process.versions, "electron", {
      configurable: true,
      value: "test-electron-runtime",
    });
    const requests = interceptElectron({ app: { getPath: () => "/native-electron/user-data" } });
    setUserDataPath("/owned-headless/user-data");
    expect(getUserDataPath()).toBe("/owned-headless/user-data");
    expect(requests()).toBe(0);
  });
});
