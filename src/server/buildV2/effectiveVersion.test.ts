/**
 * Tests for effectiveVersion.ts — git-based functions with mocked child_process.
 */

vi.mock("@natstack/shared/gitRuntime", () => ({
  execGitFileSync: vi.fn(),
  execGitFile: vi.fn(),
}));

vi.mock("@natstack/shared/envPaths", () => ({
  getUserDataPath: vi.fn().mockReturnValue("/tmp/test-ev"),
}));

import { execGitFileSync } from "@natstack/shared/gitRuntime";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  resolveMainRef,
  computeGitTreeHash,
  getCommitAt,
  diffEvMaps,
  computeBuildKey,
} from "./effectiveVersion.js";

const execGitFileSyncMock = execGitFileSync as unknown as ReturnType<typeof vi.fn>;

describe("effectiveVersion", () => {
  beforeEach(() => {
    execGitFileSyncMock.mockReset();
  });

  // -------------------------------------------------------------------------
  // resolveMainRef
  // -------------------------------------------------------------------------
  describe("resolveMainRef", () => {
    it("returns refs/heads/main when git rev-parse succeeds for main", () => {
      execGitFileSyncMock.mockReturnValue("deadbeef\n");

      // Use a unique repo path to avoid the internal cache
      const ref = resolveMainRef("/repo/resolve-main-success");
      expect(ref).toBe("refs/heads/main");
      expect(execGitFileSync).toHaveBeenCalledWith(
        ["rev-parse", "--verify", "--end-of-options", "refs/heads/main"],
        expect.objectContaining({ cwd: "/repo/resolve-main-success" })
      );
    });

    it("falls back to refs/heads/master when main fails", () => {
      execGitFileSyncMock
        .mockImplementationOnce(() => {
          throw new Error("not found");
        })
        .mockReturnValueOnce("abcd1234\n");

      const ref = resolveMainRef("/repo/resolve-fallback-master");
      expect(ref).toBe("refs/heads/master");
    });

    it("throws when both main and master fail", () => {
      execGitFileSyncMock.mockImplementation(() => {
        throw new Error("not found");
      });

      expect(() => resolveMainRef("/repo/resolve-both-fail")).toThrowError(
        /No main\/master branch found/
      );
    });
  });

  // -------------------------------------------------------------------------
  // computeGitTreeHash
  // -------------------------------------------------------------------------
  describe("computeGitTreeHash", () => {
    it("returns trimmed git rev-parse output for tree ref", () => {
      // First call resolves the main ref, second returns the tree hash
      execGitFileSyncMock
        .mockReturnValueOnce("ok\n") // rev-parse --verify refs/heads/main
        .mockReturnValueOnce("aabbccdd1122334455667788aabbccdd11223344\n"); // rev-parse refs/heads/main^{tree}

      const hash = computeGitTreeHash("/repo/tree-hash-test");
      expect(hash).toBe("aabbccdd1122334455667788aabbccdd11223344");
    });

    it("uses an explicit ref when provided", () => {
      execGitFileSyncMock.mockReturnValue("abc123def456\n");

      const hash = computeGitTreeHash("/repo/tree-explicit-ref", "refs/heads/feature");
      expect(execGitFileSync).toHaveBeenCalledWith(
        ["rev-parse", "--verify", "--end-of-options", "refs/heads/feature^{tree}"],
        expect.anything()
      );
      expect(hash).toBe("abc123def456");
    });
  });

  // -------------------------------------------------------------------------
  // getCommitAt
  // -------------------------------------------------------------------------
  describe("getCommitAt", () => {
    it("returns trimmed SHA on success", () => {
      // First call resolves the main ref
      execGitFileSyncMock
        .mockReturnValueOnce("ok\n") // rev-parse --verify refs/heads/main
        .mockReturnValueOnce("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n"); // rev-parse refs/heads/main

      const sha = getCommitAt("/repo/commit-at-success");
      expect(sha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    });

    it("returns null when git command fails", () => {
      execGitFileSyncMock.mockImplementation(() => {
        throw new Error("not found");
      });

      const sha = getCommitAt("/repo/commit-at-fail", "refs/heads/nonexistent");
      expect(sha).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // diffEvMaps (pure function, no git needed)
  // -------------------------------------------------------------------------
  describe("diffEvMaps", () => {
    it("detects changed, added, and removed entries", () => {
      const previous = { a: "hash1", b: "hash2", c: "hash3" };
      const current = { a: "hash1", b: "hash2-changed", d: "hash4" };

      const result = diffEvMaps(previous, current);
      expect(result.changed).toEqual(["b"]);
      expect(result.added).toEqual(["d"]);
      expect(result.removed).toEqual(["c"]);
    });

    it("returns empty arrays when maps are identical", () => {
      const map = { x: "h1", y: "h2" };
      const result = diffEvMaps(map, { ...map });
      expect(result.changed).toEqual([]);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);
    });
  });

  describe("computeBuildKey", () => {
    it("changes when root dependency metadata changes", () => {
      const previousCwd = process.cwd();
      const previousAppRoot = process.env["NATSTACK_APP_ROOT"];
      const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-build-key-a-"));
      const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-build-key-b-"));
      try {
        process.chdir(rootA);
        fs.mkdirSync(path.join(rootA, "dist"));
        fs.mkdirSync(path.join(rootB, "dist"));
        fs.writeFileSync(path.join(rootA, "package.json"), '{"dependencies":{"x":"1.0.0"}}\n');
        fs.writeFileSync(path.join(rootB, "package.json"), '{"dependencies":{"x":"2.0.0"}}\n');
        fs.writeFileSync(path.join(rootA, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        fs.writeFileSync(
          path.join(rootB, "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\nchanged: true\n"
        );
        fs.writeFileSync(path.join(rootA, "dist", "server.mjs"), "console.log('a');\n");
        fs.writeFileSync(path.join(rootB, "dist", "server.mjs"), "console.log('b changed');\n");

        process.env["NATSTACK_APP_ROOT"] = rootA;
        const before = computeBuildKey("workers/agent-worker", "ev-1", false);
        process.env["NATSTACK_APP_ROOT"] = rootB;
        const after = computeBuildKey("workers/agent-worker", "ev-1", false);

        expect(after).not.toBe(before);
      } finally {
        process.chdir(previousCwd);
        if (previousAppRoot === undefined) {
          delete process.env["NATSTACK_APP_ROOT"];
        } else {
          process.env["NATSTACK_APP_ROOT"] = previousAppRoot;
        }
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
      }
    });
  });
});
