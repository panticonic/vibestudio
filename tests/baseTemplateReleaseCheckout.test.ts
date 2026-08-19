import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkoutPinnedBaseRelease,
  readPinnedBaseRelease,
} from "../scripts/checkout-base-template-release.mjs";

describe("pinned Base release checkout", () => {
  it("reads the checked-in release coordinates", () => {
    expect(readPinnedBaseRelease()).toEqual({
      url: "https://github.com/panticonic/vibestudio-workspace-base.git",
      ref: "refs/tags/v0.3.24",
      commit: "3ab74952a218ad9d2b873b880a29f9a9f1113a6d",
    });
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
