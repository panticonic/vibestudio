import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTemplateRelease } from "./templateRelease.js";

const created: string[] = [];
afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const releasePin = {
  url: "git+https://example.test/base.git",
  ref: "refs/heads/main",
  commit: "c".repeat(40),
};

describe("host Base release pointer", () => {
  it("reads the exact checked host resource", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-base-release-"));
    created.push(root);
    fs.mkdirSync(path.join(root, "build-resources"));
    fs.writeFileSync(
      path.join(root, "build-resources", "workspace-template-release.json"),
      `${JSON.stringify({ format: "vibestudio-template-release/1", workspaceTemplates: { base: releasePin, personal: releasePin, system: releasePin } })}\n`
    );
    expect(readTemplateRelease(root).workspaceTemplates.base).toEqual(releasePin);
  });

  it("fails when the host has no release pointer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-base-release-"));
    created.push(root);
    expect(() => readTemplateRelease(root)).toThrow(/no exact workspace template release pointer/);
  });
});
