import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectFindings,
  collectWorkspaceFindings,
  isWorkspaceImportScope,
  resolvesIntoAnyRoot,
  resolvesIntoWorkspace,
  scanRepository,
} from "../scripts/check-host-workspace-imports.mjs";

const SCRIPT = path.resolve(__dirname, "../scripts/check-host-workspace-imports.mjs");

// A fake host file deep enough that "../../workspace/x" lands in "/repo/workspace".
const HOST_FILE = "/repo/src/server/foo.ts";
const WORKSPACE_FILE = "/repo/workspace/workers/foo.ts";
const ROOT = "/repo";
const WS_ROOT = "/repo/workspace/";
const HOST_PRIVATE_ROOTS = ["/repo/src/", "/repo/apps/", "/repo/scripts/", "/repo/tests/"];

function findings(text: string, absFile = HOST_FILE) {
  return collectFindings({ text, absFile, root: ROOT });
}

describe("isWorkspaceImportScope", () => {
  it("matches the plain and hyphenated workspace scopes", () => {
    for (const scope of [
      "@workspace/runtime",
      "@workspace-apps/shell",
      "@workspace-panels/foo",
      "@workspace-about/x",
      "@workspace-vibestudio/internal",
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

describe("resolvesIntoWorkspace", () => {
  it("resolves relative and root-relative paths into the workspace tree", () => {
    expect(resolvesIntoWorkspace(HOST_FILE, "../../workspace/x", WS_ROOT)).toBe(true);
    expect(resolvesIntoWorkspace("/repo/build.mjs", "workspace/apps/mobile", WS_ROOT)).toBe(true);
    expect(resolvesIntoWorkspace(HOST_FILE, "./sibling", WS_ROOT)).toBe(false);
    expect(resolvesIntoWorkspace(HOST_FILE, "../../src/other", WS_ROOT)).toBe(false);
  });
});

describe("resolvesIntoAnyRoot", () => {
  it("resolves relative imports into any protected root", () => {
    expect(resolvesIntoAnyRoot(WORKSPACE_FILE, "../../src/server/x", HOST_PRIVATE_ROOTS)).toBe(
      true
    );
    expect(resolvesIntoAnyRoot(WORKSPACE_FILE, "../packages/shared/x", HOST_PRIVATE_ROOTS)).toBe(
      false
    );
  });
});

describe("collectFindings — import-violation category", () => {
  it("flags static imports, re-exports, dynamic imports and require() into workspace", () => {
    const text = [
      `import a from "@workspace/runtime";`,
      `export { b } from "@workspace-vibestudio/internal";`,
      `const c = await import("@workspace-apps/shell");`,
      `const d = require("../../workspace/workers/workspace-source/GadWorkspaceDO.js");`,
    ].join("\n");
    const result = findings(text);
    expect(result.filter((f) => f.category === "import-violation")).toHaveLength(4);
    expect(result.every((f) => f.category === "import-violation")).toBe(true);
  });

  it("flags type-only imports/exports (type coupling is still coupling)", () => {
    const text = [
      `import type A from "@workspace/x";`,
      `import { type B } from "@workspace-apps/shell";`,
      `export type { C } from "@workspace-vibestudio/internal";`,
    ].join("\n");
    const result = findings(text);
    expect(result).toHaveLength(3);
    expect(result.every((f) => f.category === "import-violation")).toBe(true);
  });

  it("rejects a userland package regardless of its workspace scope", () => {
    const result = collectFindings({
      text: `export { GadWorkspaceDO } from "@workspace-vibestudio/internal";`,
      absFile: "/repo/src/server/internalDOs/index.ts",
      root: ROOT,
      workspacePackageNames: new Set(["@workspace-vibestudio/internal"]),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("import-violation");
  });

  it("does not flag ordinary imports", () => {
    const result = findings(
      `import React from "react";\nimport x from "./local";\nimport y from "../sibling";`
    );
    expect(result).toHaveLength(0);
  });

  it("reports each import once", () => {
    const result = findings(`import a from "@workspace/runtime";`);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("import-violation");
  });
  it("still flags hard imports in test files", () => {
    const text = `import a from "@workspace/runtime/worker/test-utils";`;
    const result = collectFindings({ text, absFile: "/repo/src/server/foo.test.ts", root: ROOT });
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("import-violation");
  });

  it("does not treat contract strings as dependencies", () => {
    const result = collectFindings({
      text: `const scope = "@workspace-apps/shell";\nconst path = "workspace/apps/mobile";`,
      absFile: "/repo/build.mjs",
      root: ROOT,
    });
    expect(result).toHaveLength(0);
  });
});

describe("collectWorkspaceFindings — workspace-host-import category", () => {
  it("flags workspace files importing host-private implementation roots", () => {
    const text = [
      `import { RpcServer } from "../../src/server/rpcServer.js";`,
      `const svc = await import("../../src/server/services/protectedRefStore.js");`,
      `const gate = require("../../scripts/check-host-workspace-imports.mjs");`,
    ].join("\n");
    const result = collectWorkspaceFindings({ text, absFile: WORKSPACE_FILE, root: ROOT });
    expect(result.map((f) => f.category)).toEqual([
      "workspace-host-import",
      "workspace-host-import",
      "workspace-host-import",
    ]);
  });

  it("allows shared package imports and workspace-local imports", () => {
    const text = [
      `import { x } from "@vibestudio/shared/foo";`,
      `import { y } from "@workspace/runtime";`,
      `import { z } from "../workspace/packages/runtime/src/shared/vcsClient.js";`,
    ].join("\n");
    expect(collectWorkspaceFindings({ text, absFile: WORKSPACE_FILE, root: ROOT })).toHaveLength(
      0
    );
  });
});

describe("workspace package identities", () => {
  it("rejects @vibestudio identities owned by the workspace tree", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-identity-"));
    try {
      fs.mkdirSync(path.join(dir, "workspace", "packages", "owned"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "workspace", "packages", "owned", "package.json"),
        JSON.stringify({ name: "@vibestudio/owned" })
      );
      expect(scanRepository(dir)).toContainEqual({
        file: "workspace/packages/owned/package.json",
        line: 1,
        specifier: "@vibestudio/owned",
        category: "workspace-package-identity",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it("ignores the neutral cross-boundary integration-test harness", () => {
    const dir = makeFixtureDir();
    try {
      fs.mkdirSync(path.join(dir, "tests", "workspace-integration"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "bad.ts"), `export const ok = true;\n`);
      fs.writeFileSync(
        path.join(dir, "tests", "workspace-integration", "mixed.test.ts"),
        `import x from "@workspace/runtime/worker/test-utils";\n`
      );
      expect(run(dir).code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
