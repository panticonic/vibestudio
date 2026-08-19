import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkoutPinnedBaseRelease,
  readPinnedBaseRelease,
} from "../scripts/checkout-base-template-release.mjs";

describe("pinned Base release checkout", () => {
  it("reads release coordinates from the artifact without duplicating the current pin", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-base-release-read-"));
    const commit = "a".repeat(40);
    try {
      fs.mkdirSync(path.join(root, "build-resources"));
      fs.writeFileSync(
        path.join(root, "build-resources", "base-template-release.json"),
        JSON.stringify({
          format: "vibestudio-base-release/1",
          baseTemplate: {
            url: "git+https://example.test/base.git",
            ref: "refs/tags/v1.2.3",
            commit,
            snapshot: `v1-sha256:${"b".repeat(64)}`,
          },
        })
      );

      expect(readPinnedBaseRelease(root)).toEqual({
        url: "https://example.test/base.git",
        ref: "refs/tags/v1.2.3",
        commit,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks out only the pinned ref and verifies the detached commit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-base-release-checkout-"));
    const destination = path.join(root, "base");
    const commit = "a".repeat(40);
    const calls: string[][] = [];
    const result = checkoutPinnedBaseRelease({
      destination,
      release: {
        url: "https://example.test/base.git",
        ref: "refs/tags/v1.2.3",
        commit,
      },
      runGit(args) {
        calls.push(args);
        if (args[0] === "clone") fs.mkdirSync(destination);
        return args.at(-1) === "HEAD" ? `${commit}\n` : "";
      },
    });
    expect(result).toBe(destination);
    expect(calls).toEqual([
      [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--single-branch",
        "--branch",
        "v1.2.3",
        "https://example.test/base.git",
        destination,
      ],
      ["-C", destination, "checkout", "--detach", commit],
      ["-C", destination, "rev-parse", "HEAD"],
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
