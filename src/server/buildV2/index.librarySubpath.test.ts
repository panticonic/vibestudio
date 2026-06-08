import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@natstack/env-paths";

import { initBuildSystemV2, type BuildSystemV2 } from "./index.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function commitPackage(pkgDir: string): void {
  git(pkgDir, ["init", "-b", "main"]);
  git(pkgDir, ["add", "."]);
  git(pkgDir, [
    "-c",
    "user.name=NatStack Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial package",
  ]);
}

function createFakeGitServer() {
  return {
    onPush: () => () => {},
  };
}

describe("BuildSystemV2 library package subpaths", () => {
  let root: string;
  let workspaceRoot: string;
  let buildSystem: BuildSystemV2 | null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-lib-subpath-"));
    workspaceRoot = path.join(root, "workspace");
    setUserDataPath(path.join(root, "state"));
    buildSystem = null;
  });

  afterEach(async () => {
    await buildSystem?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds the requested package export subpath instead of the package root", async () => {
    const pkgDir = path.join(workspaceRoot, "packages", "split-library");
    fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@workspace/split-library",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": "./src/root.ts",
          "./report": "./src/report.ts",
        },
      })
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "root.ts"),
      [
        'import { Buffer } from "node:buffer";',
        'export const root = await Promise.resolve(Buffer.from("root").toString("utf8"));',
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "report.ts"),
      'export const marker = "safe-report-entry";\n'
    );
    commitPackage(pkgDir);

    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      createFakeGitServer() as never,
      [],
      new Set()
    );

    await expect(
      buildSystem.getBuild("@workspace/split-library", undefined, { library: true })
    ).rejects.toThrow(/Top-level await|node:buffer/);

    const result = await buildSystem.getBuild("@workspace/split-library/report", undefined, {
      library: true,
    });
    expect(result.bundle).toContain("safe-report-entry");
    expect(result.bundle).not.toContain("Buffer.from");
  });
});
