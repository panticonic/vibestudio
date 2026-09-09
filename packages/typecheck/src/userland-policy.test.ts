import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { USERLAND_TYPECHECK_BASELINE } from "./userland-policy.js";

// A Base checkout carries no root tsconfig: `scripts/config/userland` owns the
// compiler options and `type-check-userland.ts` projects them beside the
// checkout for each run. Pin the baseline against that authoritative config
// rather than a file the checkout is not supposed to contain.
const userlandTsconfig = path.resolve(__dirname, "../../../scripts/config/userland/tsconfig.json");

describe("USERLAND_TYPECHECK_BASELINE", () => {
  it("stays aligned with the repository-wide userland typecheck", () => {
    const workspaceConfig = JSON.parse(fs.readFileSync(userlandTsconfig, "utf8")) as {
      compilerOptions?: Record<string, unknown>;
    };

    expect(workspaceConfig.compilerOptions).toMatchObject(USERLAND_TYPECHECK_BASELINE);
  });
});
