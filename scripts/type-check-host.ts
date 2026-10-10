import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { configuredFiles } from "./lib/host-validation.js";
import { ValidationProjects } from "./lib/validation-projects.js";
import { buildInfrastructurePackages } from "./infrastructure-package-cache.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projects = new ValidationProjects(appRoot);
try {
  buildInfrastructurePackages({ cwd: appRoot });
  for (const [name, relative] of [
    ["host", "tsconfig.json"],
    ["validation tooling", "scripts/tsconfig.validation.json"],
    ["workerd programs", "src/server/workerdPrograms/tsconfig.json"],
  ] as const) {
    const config = path.join(appRoot, relative);
    projects.check(name, configuredFiles(config), {}, config);
  }
} finally {
  await projects.close();
}
