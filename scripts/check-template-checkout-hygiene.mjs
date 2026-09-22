#!/usr/bin/env node
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTemplateCheckoutHygiene } from "./lib/template-checkout-hygiene.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { requireDevelopmentTemplateCheckouts } = createRequire(import.meta.url)(
  "../src/dev/developmentTemplateConfig.cjs"
);

assertTemplateCheckoutHygiene(requireDevelopmentTemplateCheckouts(root));
console.log("Development template checkouts contain no host-owned derived artifacts.");
