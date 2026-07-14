import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createNativeChildEnvironment,
  prependPathOnce,
} from "./nativeProcessEnvironment.js";

describe("native child environment", () => {
  it("strips provider, bearer, loader, and unrelated terminal authority", () => {
    const result = createNativeChildEnvironment({
      purpose: "claude",
      ambient: {
        HOME: "/home/dev",
        PATH: "/usr/bin",
        VIBESTUDIO_EXTENSION_RPC_TOKEN: "parent-token",
        VIBESTUDIO_EXTENSION_STORAGE_DIR: "/private/provider",
        VIBESTUDIO_ADMIN_TOKEN: "admin",
        VIBESTUDIO_TERMINAL_ENDPOINT: "/tmp/terminal.sock",
        NODE_OPTIONS: "--require hostile.js",
        LD_PRELOAD: "/tmp/hook.so",
      },
      toolchainDir: "/host/toolchains/build-a",
      hostBuildId: "build-a",
      purposeCredential: { name: "VIBESTUDIO_LINKED_AGENT", value: "agent-only" },
    });
    expect(result.env).toMatchObject({
      HOME: "/home/dev",
      VIBESTUDIO_HOST_BUILD_ID: "build-a",
      VIBESTUDIO_LINKED_AGENT: "agent-only",
    });
    expect(result.env["PATH"]?.split(path.delimiter)[0]).toBe(
      path.resolve("/host/toolchains/build-a/bin")
    );
    expect(result.env).not.toHaveProperty("VIBESTUDIO_EXTENSION_RPC_TOKEN");
    expect(result.env).not.toHaveProperty("VIBESTUDIO_ADMIN_TOKEN");
    expect(result.env).not.toHaveProperty("VIBESTUDIO_TERMINAL_ENDPOINT");
    expect(result.env).not.toHaveProperty("NODE_OPTIONS");
    expect(result.declaredNames).not.toContain("VIBESTUDIO_LINKED_AGENT");
  });

  it("prepends an owned toolchain exactly once", () => {
    const bin = path.resolve("/host/toolchain/bin");
    const once = prependPathOnce(`/usr/bin${path.delimiter}${bin}`, bin);
    const twice = prependPathOnce(once, bin);
    expect(twice).toBe(once);
    expect(once.split(path.delimiter).filter((part) => part === bin)).toHaveLength(1);
  });

  it("binds output-affecting declarations into the environment hash", () => {
    const base = createNativeChildEnvironment({ purpose: "build", declared: { CI: "1" } });
    const changed = createNativeChildEnvironment({ purpose: "build", declared: { CI: "0" } });
    expect(base.declaredEnvironmentHash).not.toBe(changed.declaredEnvironmentHash);
  });
});
