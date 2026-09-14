import * as fs from "node:fs";
import path from "node:path";
import { requireDevelopmentTemplateCheckouts } from "../src/dev/developmentTemplateConfig.js";

const selected = requireDevelopmentTemplateCheckouts(process.cwd());

export const exactTemplateRoots = selected.checkouts;

/** Base-only tests use the canonical Base checkout, never an authoring superset. */
export const exactUserlandRoot = path.resolve(exactTemplateRoots.base);

/**
 * Every configured template checkout, roots and dependency templates alike.
 *
 * A contract that covers units across templates -- "every agent worker journals
 * a typed terminal outcome", say -- has to look in each repository that can
 * supply one, because which template owns a unit is not the contract's subject.
 */
export const exactAllTemplateRoots: readonly string[] = Object.values(selected.checkouts).map(
  (checkout) => path.resolve(checkout)
);

/** Every existing directory at `relativePath` across the configured templates. */
export function exactUnitRoots(relativePath: string): string[] {
  return exactAllTemplateRoots
    .map((root) => path.join(root, relativePath))
    .filter((candidate) => fs.existsSync(candidate));
}
