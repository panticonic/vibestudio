import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listWorkspaceSkillEntries, parseSkillFrontmatter } from "./workspaceSkills.js";
import { WorkspaceTreeScanner } from "./workspaceTreeScanner.js";

describe("workspaceSkills", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempWorkspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "workspace-skills-"));
    tmpRoots.push(root);
    return root;
  }

  it("lists top-level SKILL.md files from workspace repo taxonomy only", async () => {
    const root = tempWorkspace();
    mkdirSync(path.join(root, "meta"), { recursive: true });
    writeFileSync(
      path.join(root, "meta", "SKILL.md"),
      "---\nname: meta-skill\ndescription: Flat repo\n---\n"
    );
    mkdirSync(path.join(root, "packages", "foo"), { recursive: true });
    writeFileSync(path.join(root, "packages", "foo", "SKILL.md"), "# no frontmatter\n");
    mkdirSync(path.join(root, "agents", "ignored"), { recursive: true });
    writeFileSync(
      path.join(root, "agents", "ignored", "SKILL.md"),
      "---\nname: ignored\ndescription: ignored\n---\n"
    );

    await expect(listWorkspaceSkillEntries(root)).resolves.toEqual([
      {
        name: "meta-skill",
        description: "Flat repo",
        dirPath: "meta",
        skillPath: "meta/SKILL.md",
      },
      {
        name: "foo",
        description: "",
        dirPath: "packages/foo",
        skillPath: "packages/foo/SKILL.md",
      },
    ]);
  });

  it("parses YAML frontmatter with a BOM and tolerates invalid YAML", () => {
    expect(
      parseSkillFrontmatter("\uFEFF---\nname: quoted\ndescription: 'YAML string'\n---\n")
    ).toEqual({
      name: "quoted",
      description: "YAML string",
    });
    expect(parseSkillFrontmatter("---\nname: [unterminated\n---\n")).toEqual({});
  });

  it("annotates meta/SKILL.md in the source tree", async () => {
    const root = tempWorkspace();
    mkdirSync(path.join(root, "meta"), { recursive: true });
    writeFileSync(
      path.join(root, "meta", "SKILL.md"),
      "---\nname: meta-skill\ndescription: Flat repo skill\n---\n"
    );

    const tree = await new WorkspaceTreeScanner(root).getSourceTree();
    expect(tree.children).toContainEqual({
      name: "meta",
      path: "meta",
      isUnit: true,
      children: [],
      skillInfo: { name: "meta-skill", description: "Flat repo skill" },
    });
  });
});
