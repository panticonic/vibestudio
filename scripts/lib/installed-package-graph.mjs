import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire, isBuiltin } from "node:module";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function platformGated(manifest) {
  const value = JSON.parse(manifest.toString("utf8"));
  return [value.os, value.cpu, value.libc].some(
    (field) => (Array.isArray(field) && field.length > 0) || (typeof field === "string" && field)
  );
}
/** One traversal/serialization for synchronous build ownership and bounded async workspace capture. */
function* graph(nodeModulesRoot, localSourceNames) {
  const nodes = [],
    identities = new Map();
  function* packagesAt(directory) {
    let entries;
    try {
      entries = yield { kind: "readdir", path: directory };
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const result = [];
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const root = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        const scopedEntries = yield { kind: "readdir", path: root };
        for (const scoped of scopedEntries.sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        ))
          if (scoped.isDirectory() || scoped.isSymbolicLink())
            result.push([`${entry.name}/${scoped.name}`, path.join(root, scoped.name)]);
      } else result.push([entry.name, root]);
    }
    return result;
  }
  function* packageNode(root, localSource = false) {
    let physical, manifest;
    try {
      physical = yield { kind: "realpath", path: root };
      manifest = yield { kind: "readFile", path: path.join(physical, "package.json") };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (platformGated(manifest)) return null;
    const parsed = JSON.parse(manifest.toString("utf8"));
    localSource ||=
      parsed.private === true ||
      (typeof parsed.name === "string" && localSourceNames.has(parsed.name));
    const prior = identities.get(physical);
    if (prior !== undefined) {
      if (localSource && !nodes[prior].implementation)
        nodes[prior].implementation = yield { kind: "tree", path: physical };
      return prior;
    }
    const id = nodes.length;
    identities.set(physical, id);
    const node = { manifest: hash(manifest), dependencies: [], installed: [] };
    nodes.push(node);
    if (localSource) node.implementation = yield { kind: "tree", path: physical };
    const dependencyNames = new Set(),
      localDependencies = new Set();
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ]) {
      const value = parsed[field];
      if (value && typeof value === "object" && !Array.isArray(value))
        for (const [name, specifier] of Object.entries(value)) {
          dependencyNames.add(name);
          if (typeof specifier === "string" && /^(?:file:|link:|workspace:)/.test(specifier))
            localDependencies.add(name);
        }
    }
    const require = createRequire(path.join(physical, "package.json"));
    for (const name of [...dependencyNames].sort()) {
      if (isBuiltin(name)) {
        node.dependencies.push([name, "builtin"]);
        continue;
      }
      if (
        !/^(?:@[^/]+\/)?[^/]+$/.test(name) ||
        name.includes("\\") ||
        name.includes("\0") ||
        name.split("/").some((part) => part === "." || part === "..")
      )
        throw new Error(`Invalid installed dependency name: ${name}`);
      let target = null;
      for (const directory of require.resolve.paths(name) ?? []) {
        const candidate = path.join(directory, name);
        try {
          yield { kind: "access", path: path.join(candidate, "package.json") };
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        target = yield* packageNode(
          candidate,
          localDependencies.has(name) || localSourceNames.has(name)
        );
        break;
      }
      node.dependencies.push([name, target]);
    }
    for (const [name, installed] of yield* packagesAt(path.join(physical, "node_modules"))) {
      const target = yield* packageNode(installed, localSourceNames.has(name));
      if (target !== null) node.installed.push([name, target]);
    }
    return id;
  }
  const roots = [];
  const realms = Array.isArray(nodeModulesRoot)
    ? nodeModulesRoot
    : [{ name: null, directory: nodeModulesRoot }];
  for (const realm of realms)
    for (const [name, root] of yield* packagesAt(realm.directory)) {
      const target = yield* packageNode(root, localSourceNames.has(name));
      if (target !== null)
        roots.push([realm.name === null ? name : `${realm.name}/${name}`, target]);
    }
  return hash(Buffer.from(JSON.stringify({ schema: "installed-package-graph/2", roots, nodes })));
}
const synchronous = (request, tree) =>
  request.kind === "tree"
    ? tree(request.path)
    : request.kind === "readdir"
      ? fs.readdirSync(request.path, { withFileTypes: true })
      : fs[`${request.kind}Sync`](request.path);
export function installedPackageGraphHashSync(nodeModulesRoot, localSourceNames, { tree } = {}) {
  const iterator = graph(nodeModulesRoot, localSourceNames);
  let step = iterator.next();
  while (!step.done) {
    try {
      step = iterator.next(synchronous(step.value, tree));
    } catch (error) {
      step = iterator.throw(error);
    }
  }
  return step.value;
}
export async function installedPackageGraphHash(nodeModulesRoot, localSourceNames, { tree, io }) {
  const iterator = graph(nodeModulesRoot, localSourceNames);
  let step = iterator.next();
  while (!step.done) {
    try {
      const request = step.value;
      const value = await (request.kind === "tree"
        ? tree(request.path)
        : io.run(() =>
            request.kind === "readdir"
              ? fs.promises.readdir(request.path, { withFileTypes: true })
              : fs.promises[request.kind](request.path)
          ));
      step = iterator.next(value);
    } catch (error) {
      step = iterator.throw(error);
    }
  }
  return step.value;
}
