import fs from "node:fs";
import path from "node:path";

function repositoryRelative(filter) {
  if (path.isAbsolute(filter)) {
    throw new Error(`--filter must be repository-relative: ${filter}`);
  }
  const normalized = path.normalize(filter);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`--filter must stay inside its source repository: ${filter}`);
  }
  return normalized.split(path.sep).join("/");
}

/**
 * Resolve each focused userland test from its declared source owner. Exact-pair
 * tests live in the host repository because their subject is the composed
 * host/template boundary; ordinary userland tests live in the external
 * template checkout. Neither source is ever used as the other's tool workspace.
 */
export function resolveUserlandTestFilters({ root, checkout, template, filters, exactPairTests }) {
  const exactPairsByPath = new Map(exactPairTests.map((test) => [test.path, test.template]));
  return filters.map((filter) => {
    const relative = repositoryRelative(filter);
    const pairTemplate = exactPairsByPath.get(relative);
    if (pairTemplate) {
      if (pairTemplate !== template) {
        throw new Error(
          `${relative} is a host-owned exact-pair test for template ${pairTemplate}, not ${template}`
        );
      }
      return path.join(root, relative);
    }

    const templatePath = path.join(checkout, relative);
    if (fs.existsSync(templatePath)) return templatePath;

    const hostPath = path.join(root, relative);
    if (fs.existsSync(hostPath)) {
      throw new Error(
        `${relative} is host-owned but is not declared as an exact-pair test for a template`
      );
    }
    throw new Error(`${relative} does not exist in the ${template} template checkout`);
  });
}
