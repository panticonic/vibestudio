/** Keep the agent-facing template contract tied to the canonical RPC schemas. */
import fs from "node:fs";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { templatesMethods } from "../packages/service-schemas/src/templates.ts";
import developmentTemplateConfig from "../src/dev/developmentTemplateConfig.cjs";
const root = developmentTemplateConfig.requireDevelopmentTemplateCheckouts(process.cwd()).checkouts
  .base;
const file = path.join(root, "skills/templates/public-contract.json");
const previous = JSON.parse(fs.readFileSync(file, "utf8"));
const methods = Object.fromEntries(
  Object.entries(templatesMethods).map(([name, method]) => [
    name,
    {
      description: method.description,
      sensitivity: method.access.sensitivity,
      arguments: zodToJsonSchema(method.args, { $refStrategy: "none" }),
      returns: zodToJsonSchema(method.returns, { $refStrategy: "none" }),
    },
  ])
);
const value =
  JSON.stringify(
    {
      ...previous,
      schemaVersion: 2,
      generatedBy: "scripts/generate-template-skill-contract.mjs",
      methods,
    },
    null,
    2
  ) + "\n";
if (process.argv.includes("--check")) {
  if (fs.readFileSync(file, "utf8") !== value)
    throw new Error(
      "Template skill contract is stale; run node --import tsx scripts/generate-template-skill-contract.mjs"
    );
} else fs.writeFileSync(file, value);
