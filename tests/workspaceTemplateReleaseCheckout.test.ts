import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkoutPinnedWorkspaceTemplateRelease,
  readPinnedWorkspaceTemplateRelease,
} from "../scripts/checkout-workspace-template-release.mjs";

const templateNames = ["base", "personal", "system"] as const;

describe("pinned workspace template release checkout", () => {
  it("reads every foundation release coordinate from the artifact", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-release-read-"));
    const commit = "a".repeat(40);
    try {
      fs.mkdirSync(path.join(root, "build-resources"));
      fs.writeFileSync(
        path.join(root, "build-resources", "workspace-template-release.json"),
        JSON.stringify({
          format: "vibestudio-template-release/1",
          workspaceTemplates: Object.fromEntries(
            templateNames.map((name) => [
              name,
              {
                url: `git+https://example.test/${name}.git`,
                ref: "refs/tags/v1.2.3",
                commit,
              },
            ])
          ),
        })
      );

      expect(readPinnedWorkspaceTemplateRelease(root)).toEqual(
        Object.fromEntries(
          templateNames.map((name) => [
            name,
            {
              url: `https://example.test/${name}.git`,
              ref: "refs/tags/v1.2.3",
              commit,
            },
          ])
        )
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks out and verifies every pinned foundation commit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-release-checkout-"));
    const destination = path.join(root, "templates");
    const commit = "a".repeat(40);
    const calls: string[][] = [];
    const releases = Object.fromEntries(
      templateNames.map((name) => [
        name,
        { url: `https://example.test/${name}.git`, ref: "refs/tags/v1.2.3", commit },
      ])
    );
    const checkouts = checkoutPinnedWorkspaceTemplateRelease({
      destination,
      releases,
      runGit(args) {
        calls.push(args);
        if (args[0] === "clone") fs.mkdirSync(args.at(-1));
        return args.at(-1) === "HEAD" ? `${commit}\n` : "";
      },
    });

    expect(checkouts).toEqual(
      Object.fromEntries(templateNames.map((name) => [name, path.join(destination, name)]))
    );
    for (const name of templateNames) {
      const checkout = path.join(destination, name);
      expect(calls).toContainEqual([
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--single-branch",
        "--branch",
        "v1.2.3",
        `https://example.test/${name}.git`,
        checkout,
      ]);
      expect(calls).toContainEqual(["-C", checkout, "checkout", "--detach", commit]);
      expect(calls).toContainEqual(["-C", checkout, "rev-parse", "HEAD"]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});
