import * as fs from "node:fs";
import * as path from "node:path";
import { API } from "typescript/unstable/sync";
import { buildInfrastructurePackages } from "../infrastructure-package-cache.mjs";
import {
  ValidationProjects,
  type ValidationPaths,
  type ValidationUnit,
} from "./validation-projects.js";

export function configuredFiles(config: string): string[] {
  const api = new API({ cwd: path.dirname(config) });
  try {
    return api.parseConfigFile(config).fileNames;
  } finally {
    api.close();
  }
}

export async function prepareHostValidation(appRoot: string, projects: ValidationProjects) {
  buildInfrastructurePackages({ cwd: appRoot });
  const config = JSON.parse(fs.readFileSync(path.join(appRoot, "tsconfig.json"), "utf8"));
  const options = {
    ...config.compilerOptions,
    typeRoots: [path.join(appRoot, "node_modules/@types"), path.join(appRoot, "node_modules")],
  };
  const paths: ValidationPaths = Object.fromEntries(
    Object.entries(options.paths as ValidationPaths).map(([name, targets]) => [
      name,
      targets.map((target) => path.resolve(appRoot, target)),
    ])
  );
  const sourcePaths = { ...paths };
  const files = configuredFiles(path.join(appRoot, "tsconfig.json"));
  const units: ValidationUnit[] = [];
  const packageTests: ValidationUnit[] = [];
  for (const directory of fs.readdirSync(path.join(appRoot, "packages"))) {
    const root = path.join(appRoot, "packages", directory);
    const manifest = path.join(root, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const json = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const owned = files.filter((file) => file.startsWith(`${root}${path.sep}`));
    if (!owned.length) continue;
    packageTests.push({ name: json.name, root, files: owned });
    if (!json.scripts?.build) {
      units.push({
        name: json.name,
        root,
        files: owned.filter(
          (file) =>
            file.startsWith(path.join(root, "src") + path.sep) &&
            !/\.(test|spec)\.[cm]?tsx?$/.test(file)
        ),
      });
    } else {
      // Compiled public exports are the package boundary, including subpaths.
      for (const [name, targets] of Object.entries(paths))
        paths[name] = targets.map((target) => {
          const source = path.join(root, "src") + path.sep;
          return target.startsWith(source)
            ? path.join(root, "dist", target.slice(source.length)).replace(/\.[cm]?tsx?$/, ".d.ts")
            : target;
        });
    }
  }
  const ambientFiles = files.filter((file) => /\.d\.[cm]?ts$/.test(file));
  const contracts = await projects.contracts(units, paths, options, ambientFiles);
  return { options, paths: contracts, sourcePaths, files, packageTests, ambientFiles };
}
