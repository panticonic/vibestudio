import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { configuredFiles, prepareHostValidation } from "./lib/host-validation.js";
import { ValidationProjects } from "./lib/validation-projects.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projects = new ValidationProjects(appRoot);
try {
  const host = await prepareHostValidation(appRoot, projects);
  projects.checkUnits(
    [
      ...host.packageTests,
      {
        name: "host",
        root: path.join(appRoot, "src"),
        files: host.files.filter(
          (file) => !file.startsWith(path.join(appRoot, "packages") + path.sep)
        ),
      },
    ],
    host.sourcePaths,
    host.paths,
    host.options,
    host.ambientFiles
  );
  const toolingConfig = path.join(appRoot, "scripts/tsconfig.validation.json");
  projects.check(
    "validation tooling",
    [...configuredFiles(toolingConfig), ...host.ambientFiles],
    {
      ...host.options,
      paths: host.paths,
      allowJs: true,
    },
    toolingConfig
  );
  const workerConfig = path.join(appRoot, "src/server/workerdPrograms/tsconfig.json");
  projects.check(
    "workerd programs",
    configuredFiles(workerConfig),
    {
      typeRoots: host.options.typeRoots,
    },
    workerConfig
  );
} finally {
  await projects.close();
}
