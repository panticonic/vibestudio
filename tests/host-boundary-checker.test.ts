import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectFindings,
  defaultReason,
  isAllowlisted,
  isTestContext,
  isWorkspaceImportScope,
  looksPathLike,
  matchesAllowlistEntry,
  resolvesIntoWorkspace,
  startsWithWorkspaceScope,
} from "../scripts/check-host-workspace-imports.mjs";

const SCRIPT = path.resolve(__dirname, "../scripts/check-host-workspace-imports.mjs");

// A fake host file deep enough that "../../workspace/x" lands in "/repo/workspace".
const HOST_FILE = "/repo/src/server/foo.ts";
const ROOT = "/repo";
const WS_ROOT = "/repo/workspace/";

function findings(text: string, absFile = HOST_FILE) {
  return collectFindings({ text, absFile, root: ROOT });
}

describe("isWorkspaceImportScope", () => {
  it("matches the plain and hyphenated workspace scopes", () => {
    for (const scope of [
      "@workspace/agentic-protocol",
      "@workspace-apps/shell",
      "@workspace-panels/foo",
      "@workspace-about/x",
      "@workspace-workers/gad-store",
      "@workspace-skills/y",
      "@workspace-extensions/browser-data",
      "@workspace-packages/z",
    ]) {
      expect(isWorkspaceImportScope(scope)).toBe(true);
    }
  });

  it("does not match unrelated specifiers or lookalikes", () => {
    for (const s of [
      "react",
      "@scope/pkg",
      "@workspacey/pkg",
      "workspace/thing",
      "./local",
      "@workspace",
    ]) {
      expect(isWorkspaceImportScope(s)).toBe(false);
    }
  });
});

describe("startsWithWorkspaceScope", () => {
  it("accepts bare scopes and subpaths but rejects lookalikes", () => {
    expect(startsWithWorkspaceScope("@workspace")).toBe(true);
    expect(startsWithWorkspaceScope("@workspace-apps/shell")).toBe(true);
    expect(startsWithWorkspaceScope("@workspace/eval")).toBe(true);
    expect(startsWithWorkspaceScope("@workspacey")).toBe(false);
    expect(startsWithWorkspaceScope("prefix @workspace/x")).toBe(false);
  });
});

describe("looksPathLike", () => {
  it("accepts slashed relative-ish paths", () => {
    expect(looksPathLike("workspace/apps/mobile")).toBe(true);
    expect(looksPathLike("../../workspace/x")).toBe(true);
  });
  it("rejects urls, scoped ids, prose and separator-less strings", () => {
    expect(looksPathLike("https://example.com/x")).toBe(false);
    expect(looksPathLike("@workspace/x")).toBe(false);
    expect(looksPathLike("build the workspace/ dir")).toBe(false);
    expect(looksPathLike("noseparator")).toBe(false);
  });
});

describe("resolvesIntoWorkspace", () => {
  it("resolves relative and root-relative paths into the workspace tree", () => {
    expect(resolvesIntoWorkspace(HOST_FILE, "../../workspace/x", WS_ROOT)).toBe(true);
    expect(resolvesIntoWorkspace("/repo/build.mjs", "workspace/apps/mobile", WS_ROOT)).toBe(true);
    expect(resolvesIntoWorkspace(HOST_FILE, "./sibling", WS_ROOT)).toBe(false);
    expect(resolvesIntoWorkspace(HOST_FILE, "../../src/other", WS_ROOT)).toBe(false);
  });
});

describe("isTestContext", () => {
  it("flags test/spec files and anything under test/fixture roots", () => {
    expect(isTestContext("src/server/foo.test.ts")).toBe(true);
    expect(isTestContext("src/server/foo.spec.tsx")).toBe(true);
    expect(isTestContext("tests/foo.ts")).toBe(true);
    expect(isTestContext("src/__tests__/foo.ts")).toBe(true);
    expect(isTestContext("tests/fixtures/foo.ts")).toBe(true);
    expect(isTestContext("src/server/foo.ts")).toBe(false);
  });
});

describe("collectFindings — import-violation category", () => {
  it("flags static imports, re-exports, dynamic imports and require() into workspace", () => {
    const text = [
      `import a from "@workspace/agentic-protocol";`,
      `export { b } from "@workspace-workers/gad-store";`,
      `const c = await import("@workspace-apps/shell");`,
      `const d = require("../../workspace/workers/gad-store/index.js");`,
    ].join("\n");
    const result = findings(text);
    expect(result.filter((f) => f.category === "import-violation")).toHaveLength(4);
    expect(result.every((f) => f.category === "import-violation")).toBe(true);
  });

  it("flags type-only imports/exports (type coupling is still coupling)", () => {
    const text = [
      `import type A from "@workspace/x";`,
      `import { type B } from "@workspace-apps/shell";`,
      `export type { C } from "@workspace-workers/gad-store";`,
    ].join("\n");
    const result = findings(text);
    expect(result).toHaveLength(3);
    expect(result.every((f) => f.category === "import-violation")).toBe(true);
  });

  it("does not flag ordinary imports", () => {
    const result = findings(
      `import React from "react";\nimport x from "./local";\nimport y from "../sibling";`
    );
    expect(result).toHaveLength(0);
  });

  it("does not double-count an import specifier as a workspace-reference", () => {
    const result = findings(`import a from "@workspace/agentic-protocol";`);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("import-violation");
  });
});

describe("collectFindings — workspace-reference category", () => {
  it("flags scope-prefixed and path-like string literals in production files", () => {
    const text = [`const id = "@workspace-apps/shell";`, `const p = "workspace/apps/mobile";`].join(
      "\n"
    );
    // Use a root-level file so "workspace/..." resolves into the workspace tree.
    const result = collectFindings({ text, absFile: "/repo/build.mjs", root: ROOT });
    const refs = result.filter((f) => f.category === "workspace-reference");
    expect(refs.map((f) => f.specifier).sort()).toEqual([
      "@workspace-apps/shell",
      "workspace/apps/mobile",
    ]);
  });

  it("skips string-literal references in test-context files (noise reduction)", () => {
    const text = `const id = "@workspace-apps/shell";`;
    const result = collectFindings({ text, absFile: "/repo/src/server/foo.test.ts", root: ROOT });
    expect(result).toHaveLength(0);
  });

  it("still flags hard imports in test-context files", () => {
    const text = `import a from "@workspace/runtime/worker/test-utils";`;
    const result = collectFindings({ text, absFile: "/repo/src/server/foo.test.ts", root: ROOT });
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("import-violation");
  });

  it("ignores unrelated string literals", () => {
    const result = collectFindings({
      text: `const s = "hello world";\nconst u = "https://x/y";`,
      absFile: "/repo/build.mjs",
      root: ROOT,
    });
    expect(result).toHaveLength(0);
  });
});

describe("allowlist matching", () => {
  const finding = {
    file: "src/server/foo.ts",
    line: 1,
    specifier: "@workspace/x",
    category: "import-violation",
  };

  it("matches on file + specifier + category", () => {
    expect(
      matchesAllowlistEntry(finding, {
        file: "src/server/foo.ts",
        specifier: "@workspace/x",
        category: "import-violation",
      })
    ).toBe(true);
    expect(
      matchesAllowlistEntry(finding, { file: "src/server/foo.ts", specifier: "@workspace/other" })
    ).toBe(false);
    expect(
      matchesAllowlistEntry(finding, { file: "src/server/bar.ts", specifier: "@workspace/x" })
    ).toBe(false);
  });

  it("treats a missing specifier as a whole-file allow", () => {
    expect(matchesAllowlistEntry(finding, { file: "src/server/foo.ts" })).toBe(true);
    expect(isAllowlisted(finding, [{ file: "src/server/foo.ts" }])).toBe(true);
  });

  it("filters by category when present", () => {
    expect(
      matchesAllowlistEntry(finding, { file: "src/server/foo.ts", category: "workspace-reference" })
    ).toBe(false);
  });
});

describe("defaultReason", () => {
  it("assigns the documented seed reasons", () => {
    expect(defaultReason({ file: "src/server/foo.ts", category: "import-violation" })).toBe(
      "pending-fix-2026-07: being removed by parallel cleanup"
    );
    expect(defaultReason({ file: "src/server/foo.test.ts", category: "import-violation" })).toBe(
      "DO/workspace integration test"
    );
    expect(
      defaultReason({ file: "src/server/buildV2/builder.ts", category: "workspace-reference" })
    ).toContain("workspace-reference baseline");
  });
});

describe("CLI (child process against a temp fixture dir)", () => {
  function makeFixtureDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-boundary-"));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "bad.ts"),
      `import x from "@workspace/thing";\nexport const y = x;\n`
    );
    return dir;
  }

  function run(dir: string, args: string[] = []) {
    try {
      const stdout = execFileSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
      return { code: 0, stdout, stderr: "" };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("exits non-zero and reports the violation when nothing is allowlisted", () => {
    const dir = makeFixtureDir();
    try {
      const { code, stderr } = run(dir);
      expect(code).toBe(1);
      expect(stderr).toContain("import-violation");
      expect(stderr).toContain("src/bad.ts");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes once the finding is allowlisted", () => {
    const dir = makeFixtureDir();
    try {
      fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "scripts", "host-boundary-allowlist.json"),
        JSON.stringify({
          entries: [
            {
              file: "src/bad.ts",
              specifier: "@workspace/thing",
              category: "import-violation",
              reason: "test",
            },
          ],
        })
      );
      const { code } = run(dir);
      expect(code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores publish build output directories", () => {
    const dir = makeFixtureDir();
    try {
      fs.mkdirSync(path.join(dir, "packages", "extension-host", "dist-publish"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(dir, "packages", "extension-host", "dist-publish", "index.js"),
        `const scope = "@workspace-apps/shell";\n`
      );
      fs.writeFileSync(path.join(dir, "src", "bad.ts"), `export const ok = true;\n`);
      expect(run(dir).code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--update-allowlist writes an allowlist that then passes", () => {
    const dir = makeFixtureDir();
    try {
      const updated = run(dir, ["--update-allowlist"]);
      expect(updated.code).toBe(0);
      const written = JSON.parse(
        fs.readFileSync(path.join(dir, "scripts", "host-boundary-allowlist.json"), "utf8")
      );
      expect(written.entries).toHaveLength(1);
      expect(written.entries[0]).toMatchObject({
        file: "src/bad.ts",
        specifier: "@workspace/thing",
        category: "import-violation",
      });
      expect(run(dir).code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
