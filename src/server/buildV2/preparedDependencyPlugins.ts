import path from "node:path";
import { isBuiltin } from "node:module";
import type * as esbuild from "esbuild";
import type { PreparedDependencyResolution } from "./preparedDependencyResolution.js";

const SELECTED_INSTALLATION = Symbol("selected-installation-resolution");

function beneath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/**
 * Keep ordinary esbuild/plugin module identity and loading. The sole resolution
 * policy is choosing the prepared npm installation for workspace-source imports:
 * nodePaths alone is only a fallback after ambient ancestor node_modules.
 * Package imports otherwise use esbuild's native resolver in their own realm.
 */
export function composePreparedDependencyPlugins(
  plugins: readonly esbuild.Plugin[],
  nodePaths: readonly string[],
  sourceRoots: readonly string[],
  externals: readonly string[] = [],
  prepared?: PreparedDependencyResolution
): esbuild.Plugin[] {
  const roots = sourceRoots.map((root) => path.resolve(root));
  const resolveDir = nodePaths[0] ? path.dirname(path.resolve(nodePaths[0])) : undefined;
  const external = (specifier: string): boolean =>
    externals.some((item) =>
      item.endsWith("/*") ? specifier.startsWith(item.slice(0, -1)) : specifier === item
    );
  const optionalFor = (directory: string, name: string): boolean => {
    for (;;) {
      const optional = prepared?.absentOptionalImports.get(directory);
      if (optional) return optional.has(name);
      const parent = path.dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  };
  const installedPackage = (directory: string): boolean => {
    for (;;) {
      if (prepared?.packageDirectories.has(directory)) return true;
      const parent = path.dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  };
  return [
    ...plugins,
    {
      name: "prepared-installation-resolution",
      setup(build) {
        build.initialOptions.nodePaths = [...nodePaths];
        build.onResolve({ filter: /^[^./#]|^@/ }, async (args) => {
          if (path.isAbsolute(args.path) || args.pluginData?.[SELECTED_INSTALLATION]) return null;
          if (external(args.path)) return { path: args.path, external: true };
          if (build.initialOptions.platform === "node" && isBuiltin(args.path)) return null;
          const name = args.path.startsWith("@")
            ? args.path.split("/", 2).join("/")
            : args.path.split("/", 1)[0]!;
          if (args.resolveDir && optionalFor(args.resolveDir, name))
            return { path: args.path, external: true };
          if (
            !resolveDir ||
            !args.resolveDir ||
            installedPackage(args.resolveDir) ||
            (roots.length > 0 && !roots.some((root) => beneath(root, args.resolveDir)))
          )
            return null;
          return build.resolve(args.path, {
            kind: args.kind,
            resolveDir,
            pluginData: { [SELECTED_INSTALLATION]: true },
            with: args.with,
          });
        });
      },
    },
  ];
}
