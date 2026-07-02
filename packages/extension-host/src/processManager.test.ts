import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { extensionRuntimeExecArgv, resolveChildRuntimePath } from "./processManager.js";

describe("ExtensionProcessManager runtime resolution", () => {
  it("falls back to the TypeScript child runtime when running from source", () => {
    expect(path.basename(resolveChildRuntimePath())).toBe("childRuntime.ts");
  });

  it("preserves parent exec argv when inspector injection is disabled", () => {
    const previous = process.env["VIBEZ1_PROD"];
    process.env["VIBEZ1_PROD"] = "1";
    try {
      expect(extensionRuntimeExecArgv()).toEqual(
        process.execArgv.length > 0 ? process.execArgv : undefined
      );
    } finally {
      if (previous === undefined) delete process.env["VIBEZ1_PROD"];
      else process.env["VIBEZ1_PROD"] = previous;
    }
  });
});
