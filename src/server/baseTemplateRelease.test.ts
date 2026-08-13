import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBaseTemplateRelease } from "./baseTemplateRelease.js";

const created: string[] = [];
afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const releasePin = {
  url: "git+https://example.test/base.git",
  ref: "refs/heads/main",
  commit: "c".repeat(40),
  snapshot: `v1-sha256:${"d".repeat(64)}` as const,
};

describe("host Base release pointer", () => {
  it("reads the exact checked host resource", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-base-release-"));
    created.push(root);
    fs.mkdirSync(path.join(root, "build-resources"));
    fs.writeFileSync(
      path.join(root, "build-resources", "base-template-release.json"),
      `${JSON.stringify({ format: "vibestudio-base-release/1", baseTemplate: releasePin })}\n`
    );
    expect(readBaseTemplateRelease(root).baseTemplate).toEqual(releasePin);
  });

  it("fails when the host has no release pointer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-base-release-"));
    created.push(root);
    expect(() => readBaseTemplateRelease(root)).toThrow(/no exact external Base release pointer/);
  });
});
