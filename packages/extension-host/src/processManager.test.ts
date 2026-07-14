import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extensionProcessEnvironment,
  extensionRuntimeExecArgv,
  resolveChildRuntimePath,
} from "./processManager.js";

describe("ExtensionProcessManager runtime resolution", () => {
  it("falls back to the TypeScript child runtime when running from source", () => {
    expect(path.basename(resolveChildRuntimePath())).toBe("childRuntime.ts");
  });

  it("preserves parent exec argv when inspector injection is disabled", () => {
    const previous = process.env["VIBESTUDIO_PROD"];
    process.env["VIBESTUDIO_PROD"] = "1";
    try {
      expect(extensionRuntimeExecArgv()).toEqual(
        process.execArgv.length > 0 ? process.execArgv : undefined
      );
    } finally {
      if (previous === undefined) delete process.env["VIBESTUDIO_PROD"];
      else process.env["VIBESTUDIO_PROD"] = previous;
    }
  });

  it("uses only the exact runtime dependency layer for external module resolution", () => {
    const env = extensionProcessEnvironment(
      {
        name: "@workspace-extensions/shell",
        version: "1.0.0",
        bundlePath: "/artifacts/shell/bundle.js",
        runtimeNodeModulesDir: "/runtime-deps/abi-key/node_modules",
        storageDir: "/state/shell",
        gatewayUrl: "http://127.0.0.1:3000",
        rpcToken: "token",
      },
      { PATH: "/bin", NODE_PATH: "/ambient/node_modules" }
    );

    expect(env["NODE_PATH"]).toBe("/runtime-deps/abi-key/node_modules");
    expect(env["PATH"]).toBe("/bin");
    expect(env["VIBESTUDIO_EXTENSION_BUNDLE_PATH"]).toBe("/artifacts/shell/bundle.js");
  });

  it("removes ambient NODE_PATH when an extension has no external runtime layer", () => {
    const env = extensionProcessEnvironment(
      {
        name: "extension",
        version: "1.0.0",
        bundlePath: "/artifact/bundle.js",
        storageDir: "/storage",
        gatewayUrl: "http://127.0.0.1:3000",
        rpcToken: "token",
      },
      { NODE_PATH: "/ambient/node_modules" }
    );

    expect(env).not.toHaveProperty("NODE_PATH");
  });
});
