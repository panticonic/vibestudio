import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { USERLAND_TYPECHECK_BASELINE } from "./userland-policy.js";

describe("USERLAND_TYPECHECK_BASELINE", () => {
  it("stays aligned with the repository-wide userland typecheck", () => {
    const workspaceConfig = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "../../../workspace/tsconfig.json"), "utf8")
    ) as { compilerOptions?: Record<string, unknown> };

    expect(workspaceConfig.compilerOptions).toMatchObject(USERLAND_TYPECHECK_BASELINE);
  });
});
