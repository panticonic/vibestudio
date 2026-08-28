// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import { parseArgs, rotateEndpoint } from "../scripts/cli/remote-rotate-endpoint.mjs";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("remote endpoint rotation", () => {
  it("requires an explicit workspace and confirmation", () => {
    expect(() => parseArgs([])).toThrow(/workspace is required/);
    expect(parseArgs(["--workspace", "dev", "--yes"])).toMatchObject({
      workspace: "dev",
      yes: true,
    });
  });

  it("atomically installs a 0600 32-byte secret and keeps the old key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-rotate-endpoint-"));
    const identity = path.join(root, "endpoint.key");
    fs.writeFileSync(identity, Buffer.alloc(32, 1), { mode: 0o600 });
    const result = rotateEndpoint(
      { workspace: "dev", identity },
      { randomBytes: () => Buffer.alloc(32, 2), randomUUID: () => "fixed" }
    );
    expect(fs.readFileSync(identity)).toEqual(Buffer.alloc(32, 2));
    expect(fs.readFileSync(result.backup)).toEqual(Buffer.alloc(32, 1));
    expect(fs.statSync(identity).mode & 0o777).toBe(0o600);
  });
});
