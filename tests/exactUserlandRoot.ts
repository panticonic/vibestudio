import path from "node:path";
import { requireDevelopmentTemplateCheckouts } from "../src/dev/developmentTemplateConfig.js";

export const exactTemplateRoots = requireDevelopmentTemplateCheckouts(process.cwd()).checkouts;

/** Base-only tests use the canonical Base checkout, never an authoring superset. */
export const exactUserlandRoot = path.resolve(exactTemplateRoots.base);
