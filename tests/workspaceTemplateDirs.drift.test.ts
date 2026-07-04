/**
 * Drift guard: the packaged-template staging list in the (.mjs, un-importable
 * by TS) build script must stay in sync with the canonical workspace taxonomy
 * in @vibez1/shared/workspace/sourceDirs.
 *
 * The build script mirrors the dir list because an .mjs script cannot import the
 * TS constant. This test imports the script's exported list and the shared
 * constant and asserts they agree modulo a small, explicitly-documented set of
 * source dirs that are intentionally NOT shipped in the initial template.
 */

import * as fs from "node:fs";
import YAML from "yaml";

import { WORKSPACE_SOURCE_DIRS } from "@vibez1/shared/workspace/sourceDirs";
import {
  WORKSPACE_TEMPLATE_DIRS,
  WORKSPACE_TEMPLATE_ROOT_FILES,
  WORKSPACE_TEMPLATE_SUPPORT_DIRS,
} from "../scripts/build-npm-packages.mjs";

// Source dirs that exist in the workspace taxonomy but are deliberately NOT
// staged into the packaged template. `projects/` is runtime-only content
// created per user; a fresh install starts with no projects.
const UNSTAGED_SOURCE_DIRS = new Set<string>(["projects"]);

interface ElectronBuilderConfig {
  extraResources?: Array<{
    from?: string;
    to?: string;
    filter?: string[];
  }>;
}

function electronBuilderConfig(): ElectronBuilderConfig {
  return YAML.parse(fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
}

describe("packaged workspace template staging drift guard", () => {
  it("stages exactly the workspace source dirs minus the documented runtime-only ones", () => {
    // Every documented exclusion must itself be a real source dir (catches a
    // stale exclusion if a dir is renamed/removed from the taxonomy).
    for (const dir of UNSTAGED_SOURCE_DIRS) {
      expect(WORKSPACE_SOURCE_DIRS).toContain(dir);
    }

    const expected = [...WORKSPACE_SOURCE_DIRS]
      .filter((dir) => !UNSTAGED_SOURCE_DIRS.has(dir))
      .sort();
    expect([...WORKSPACE_TEMPLATE_DIRS].sort()).toEqual(expected);
  });

  it("never stages a dir that is not a known workspace source dir", () => {
    const valid = new Set<string>(WORKSPACE_SOURCE_DIRS);
    for (const dir of WORKSPACE_TEMPLATE_DIRS) {
      expect(valid.has(dir)).toBe(true);
    }
  });

  it("stages the workspace root files that define the nested package graph", () => {
    expect([...WORKSPACE_TEMPLATE_ROOT_FILES].sort()).toEqual([
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.integration.json",
      "tsconfig.integration.mobile.json",
      "tsconfig.json",
    ]);
  });

  it("stages the parent package graph and patches referenced by workspace metadata", () => {
    expect([...WORKSPACE_TEMPLATE_SUPPORT_DIRS].sort()).toEqual(["packages", "patches"]);
  });

  it("keeps the native Electron workspace template self-contained", () => {
    const resources = electronBuilderConfig().extraResources ?? [];
    const workspaceTemplate = resources.find(
      (entry) => entry.from === "workspace" && entry.to === "workspace-template"
    );
    expect(workspaceTemplate?.filter).toEqual(
      expect.arrayContaining([
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.json",
        "tsconfig.integration.json",
        "tsconfig.integration.mobile.json",
      ])
    );

    for (const dir of WORKSPACE_TEMPLATE_SUPPORT_DIRS) {
      expect(resources).toEqual(
        expect.arrayContaining([expect.objectContaining({ from: dir, to: dir })])
      );
    }
  });
});
