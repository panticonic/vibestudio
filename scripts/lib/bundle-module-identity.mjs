import fs from "node:fs";
import path from "node:path";

/** A bundle owns one resolution policy; package-local tsconfigs must not split
 * an infrastructure package between its source and emitted module trees. */
export function assertSingleInfrastructureModuleTree(
  metafile,
  repoRoot,
  workingDirectory = repoRoot
) {
  const trees = new Map();
  for (const input of Object.keys(metafile?.inputs ?? {})) {
    if (input.startsWith("<")) continue;
    const absolute = path.resolve(workingDirectory, input);
    const resolved = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
    const relative = path.relative(repoRoot, resolved).split(path.sep).join("/");
    const match = /^packages\/([^/]+)\/(src|dist)\//u.exec(relative);
    if (!match) continue;
    const [, owner, tree] = match;
    const previous = trees.get(owner);
    if (previous && previous.tree !== tree)
      throw new Error(
        `Bundle mixes source and compiled modules for @vibestudio/${owner}: ${previous.input} and ${input}`
      );
    trees.set(owner, { tree, input });
  }
}
