import fs from "node:fs";
import path from "node:path";
import { installedPackageGraphHashSync } from "./installed-package-graph.mjs";

/** Actual owner-resolved installations, independently of lockfile intentions. */
export function hostInstalledDependencyHash(cwd, { packageDirectories, tree }) {
  const directories = [
    ...new Set([cwd, ...packageDirectories].map((directory) => path.resolve(directory))),
  ].sort((a, b) => path.relative(cwd, a).localeCompare(path.relative(cwd, b)));
  const localNames = new Set(),
    realms = [],
    seen = new Set(),
    trees = new Map();
  for (const directory of directories) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (manifest) {
      if (directory !== path.resolve(cwd) && typeof manifest.name === "string")
        localNames.add(manifest.name);
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
      ])
        for (const [name, value] of Object.entries(manifest[field] ?? {}))
          if (typeof value === "string" && /^(?:file:|link:|workspace:)/.test(value))
            localNames.add(name);
    }
    const root = path.join(directory, "node_modules");
    let physical;
    try {
      physical = fs.realpathSync(root);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (seen.has(physical)) continue;
    seen.add(physical);
    realms.push({ name: path.relative(cwd, root).split(path.sep).join("/"), directory: root });
  }
  return installedPackageGraphHashSync(realms, localNames, {
    tree(root) {
      if (!trees.has(root)) trees.set(root, tree(root));
      return trees.get(root);
    },
  });
}
