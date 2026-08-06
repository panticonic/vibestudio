import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { preflightProjectFiles, type ProjectType } from "./project-manifest.js";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const SKIP_DIRECTORIES = new Set([".git", "build", "dist", "node_modules"]);
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|md|mdx|svelte|css|scss|html|ya?ml|toml|txt)$/i;

function repositoryFiles(directory: string, prefix = ""): Record<string, string | Uint8Array> {
  const files: Record<string, string | Uint8Array> = {};
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, repositoryFiles(directory, relative));
      continue;
    }
    const source = fs.readFileSync(path.join(directory, relative));
    files[relative] =
      TEXT_FILE.test(entry.name) || !entry.name.includes(".")
        ? source.toString("utf8")
        : new Uint8Array(source);
  }
  return files;
}

function executableRepositories(type: Extract<ProjectType, "panel" | "worker">): string[] {
  const section = type === "panel" ? "panels" : "workers";
  const root = path.join(workspaceRoot, section);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "package.json"))
    )
    .map((entry) => `${section}/${entry.name}`)
    .sort();
}

describe("canonical executable repository contracts", () => {
  for (const projectType of ["panel", "worker"] as const) {
    it(`keeps every ${projectType} fork-ready under the same preflight contract`, () => {
      const failures: Array<{ repository: string; error: unknown }> = [];
      for (const repository of executableRepositories(projectType)) {
        try {
          preflightProjectFiles({
            projectType,
            name: path.basename(repository),
            files: repositoryFiles(path.join(workspaceRoot, repository)),
          });
        } catch (error) {
          failures.push({
            repository,
            error:
              error && typeof error === "object" && "errorData" in error
                ? (error as { errorData: unknown }).errorData
                : error instanceof Error
                  ? error.message
                  : String(error),
          });
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("panel debugging guidance", () => {
  it("keeps the bounded loop explicit about context refs and durable phase receipts", () => {
    const skill = fs.readFileSync(path.join(workspaceRoot, "skills/workspace-dev/SKILL.md"), "utf8");
    const loop = fs.readFileSync(
      path.join(workspaceRoot, "skills/workspace-dev/PANEL_DEBUG_LOOP.md"),
      "utf8"
    );

    expect(skill).toContain("PANEL_DEBUG_LOOP.md");
    expect(loop).toContain("Never call `createProjects` again");
    expect(loop).toContain("ref: `ctx:${ctx.contextId}`");
    expect(loop).toContain("requestedRef");
    expect(loop).toContain("const page = await scope.panel.cdp.page(); // fresh after runtime replacement");
    expect(loop).toContain("await page.screenshot({ fullPage: true })");
  });
});
