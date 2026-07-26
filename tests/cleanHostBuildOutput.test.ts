import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanHostBuildOutput } from "../scripts/clean-host-build-output.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("host build output cleanup", () => {
  it("removes stale generated outputs without deleting an explicit app bake or active lock", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-clean-"));
    temporaryDirectories.push(cwd);
    for (const relative of [
      "dist/server.mjs",
      "dist/server.mjs.map",
      "dist/bootstrap/obsolete.js",
      "dist/removed-worker.js",
      "dist/baked-app/index.html",
      "dist/source-server-prerequisites.lock",
    ]) {
      const target = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, relative);
    }

    cleanHostBuildOutput(cwd);

    expect(fs.readdirSync(path.join(cwd, "dist")).sort()).toEqual([
      "baked-app",
      "source-server-prerequisites.lock",
    ]);
    expect(fs.readFileSync(path.join(cwd, "dist", "baked-app", "index.html"), "utf8")).toBe(
      "dist/baked-app/index.html"
    );
  });
});
