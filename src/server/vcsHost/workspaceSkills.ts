import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { CONTAINER_SECTIONS, FLAT_SECTIONS } from "@vibestudio/shared/runtime/entitySpec";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

export interface SkillEntry {
  /** Skill identifier from frontmatter, falling back to the containing repo name. */
  name: string;
  /** Short human-readable description from frontmatter, if present. */
  description: string;
  /** Workspace-relative repo path containing the skill. */
  dirPath: string;
  /** Workspace-relative path to the skill document. */
  skillPath: string;
}

export async function listWorkspaceSkillEntries(workspaceRoot: string): Promise<SkillEntry[]> {
  const repoPaths = await candidateRepoPaths(workspaceRoot);
  const entries = await Promise.all(
    repoPaths.map((repoPath) => readWorkspaceSkillEntry(workspaceRoot, repoPath))
  );
  return entries
    .filter((entry): entry is SkillEntry => Boolean(entry))
    .sort((a, b) => a.dirPath.localeCompare(b.dirPath));
}

export async function readWorkspaceSkillEntry(
  workspaceRoot: string,
  repoPath: string
): Promise<SkillEntry | null> {
  const skillPath = `${repoPath}/SKILL.md`;
  const frontmatter = await readSkillFrontmatter(path.join(workspaceRoot, skillPath));
  if (!frontmatter) return null;
  return {
    name: frontmatter.name ?? path.basename(repoPath),
    description: frontmatter.description ?? "",
    dirPath: repoPath,
    skillPath,
  };
}

export async function readSkillFrontmatter(skillMdPath: string): Promise<SkillFrontmatter | null> {
  let content: string;
  try {
    content = await fs.readFile(skillMdPath, "utf8");
  } catch {
    return null;
  }
  return parseSkillFrontmatter(content);
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  try {
    const parsed = YAML.parse(match[1] ?? "") as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const name = record["name"];
    const description = record["description"];
    return {
      ...(typeof name === "string" && name ? { name } : {}),
      ...(typeof description === "string" ? { description } : {}),
    };
  } catch {
    return {};
  }
}

async function candidateRepoPaths(workspaceRoot: string): Promise<string[]> {
  const repoPaths: string[] = [];
  for (const section of FLAT_SECTIONS) {
    repoPaths.push(section);
  }
  for (const section of CONTAINER_SECTIONS) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(workspaceRoot, section), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      repoPaths.push(`${section}/${entry.name}`);
    }
  }
  return repoPaths.sort((a, b) => a.localeCompare(b));
}
