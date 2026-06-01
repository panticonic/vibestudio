import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("live CLI smoke", () => {
  it("routes remote serve help to the live TypeScript server entry", async () => {
    const { stdout } = await execFileAsync("pnpm", ["cli", "remote", "serve", "--help"], {
      timeout: 10_000,
    });

    expect(stdout).toContain("natstack remote serve");
    expect(stdout).toContain("src/server/index.ts");
  });
});
