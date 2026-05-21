/**
 * Workspace path index. Keeps a list of every `.mdx` file under the repo
 * root, refreshed on demand (after flush or commit, or when the user
 * creates a file). Used for wikilink resolution and the backlinks panel.
 */

import { promises as fs } from "fs";

export async function listMdxPaths(root: string): Promise<string[]> {
  async function walk(dir: string): Promise<string[]> {
    let entries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as { name: string; isDirectory: () => boolean }[];
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        out.push(...(await walk(full)));
      } else if (e.name.endsWith(".mdx")) {
        out.push(full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full);
      }
    }
    return out;
  }
  return (await walk(root)).sort();
}
