import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import { runtimeClientCatalog } from "./lib/runtime-client-catalog.mjs";
import developmentTemplateConfig from "../src/dev/developmentTemplateConfig.cjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const userlandRoot = developmentTemplateConfig.requireDevelopmentTemplateCheckout(repoRoot, "base");

/** Load manifests in the same Node runtime as the other schema catalogs. */
async function loadRuntimeSurface(relativePath, exportName) {
  const filePath = path.join(repoRoot, relativePath);
  const module = await tsImport(filePath, import.meta.url);
  const runtimeSurface = module[exportName];
  if (!runtimeSurface || typeof runtimeSurface !== "object") {
    throw new Error(`Failed to load runtime surface from ${relativePath}`);
  }
  return runtimeSurface;
}

function renderSurfaceTable(surface) {
  const lines = [
    `Generated from \`${surface.target === "panel" ? "runtimeSurface.panel.ts" : "runtimeSurface.worker.ts"}\`. Use \`await help()\` at runtime for the live surface.`,
    "",
    "| Export | Kind | Members | Description |",
    "|--------|------|---------|-------------|",
  ];

  for (const [name, entry] of Object.entries(surface.exports)) {
    const members = entry.kind === "namespace" ? `\`${entry.members.join("`, `")}\`` : "";
    const description = entry.description ?? "";
    lines.push(
      `| \`${name}\` | ${entry.kind} | ${escapeTableCell(members)} | ${escapeTableCell(
        description
      )} |`
    );
  }

  return lines.join("\n");
}

function escapeTableCell(value) {
  return value.replace(/\|/g, "\\|");
}

function replaceBlock(contents, marker, replacement) {
  const begin = `<!-- BEGIN GENERATED: ${marker} -->`;
  const end = `<!-- END GENERATED: ${marker} -->`;
  const pattern = new RegExp(`${begin}[\\s\\S]*?${end}`);
  if (!pattern.test(contents)) {
    throw new Error(`Missing generated block markers for ${marker}`);
  }
  return contents.replace(pattern, `${begin}\n${replacement}\n${end}`);
}

function updateDoc(root, relativePath, replacements, checkOnly) {
  const filePath = path.join(root, relativePath);
  const current = fs.readFileSync(filePath, "utf8");
  let next = current;

  for (const [marker, replacement] of replacements) {
    next = replaceBlock(next, marker, replacement);
  }

  if (checkOnly) {
    if (next !== current) {
      throw new Error(`${relativePath} is out of date. Run: pnpm run generate:runtime-docs`);
    }
    return;
  }

  if (next !== current) {
    fs.writeFileSync(filePath, next);
  }
}

async function updateRuntimeCatalog(schemaFile, exportName, catalogFile, checkOnly) {
  const schemaPath = path.join(repoRoot, "packages/service-schemas/src", schemaFile);
  const catalogPath = path.join(
    repoRoot,
    "packages/service-schemas/src/runtime/generated",
    catalogFile
  );
  const module = await tsImport(schemaPath, import.meta.url);
  const { renderBytesJsonSchema } = await tsImport(
    path.join(repoRoot, "packages/shared/src/binary.ts"),
    import.meta.url
  );
  const methods = module[exportName];
  if (!methods || typeof methods !== "object") {
    throw new Error(`Failed to load ${exportName} for runtime catalog generation`);
  }
  const catalog = Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      {
        ...(method.description ? { description: method.description } : {}),
        ...(method.access || method.capability
          ? {
              access: {
                ...(method.access ?? {}),
                ...(method.capability ? { capability: method.capability } : {}),
              },
            }
          : {}),
        argsSchema: convertZodToJsonSchema(method.args, {
          target: "openApi3",
          postProcess: renderBytesJsonSchema,
        }),
        ...(method.returns
          ? {
              returnsSchema: convertZodToJsonSchema(method.returns, {
                target: "openApi3",
                postProcess: renderBytesJsonSchema,
              }),
            }
          : {}),
        ...(method.examples ? { examples: method.examples } : {}),
      },
    ])
  );
  writeRuntimeCatalog(catalogPath, catalogFile, catalog, checkOnly);
}

function writeRuntimeCatalog(catalogPath, catalogFile, catalog, checkOnly) {
  const next = `${JSON.stringify(catalog, null, 2)}\n`;
  const current = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, "utf8") : null;
  if (checkOnly) {
    if (next !== current) {
      throw new Error(
        `packages/service-schemas/src/runtime/generated/${catalogFile} is out of date. ` +
          "Run: pnpm run generate:runtime-docs"
      );
    }
    return;
  }
  if (next !== current) {
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(catalogPath, next);
  }
}

const checkOnly = process.argv.includes("--check");

await updateRuntimeCatalog("workspaceSource.ts", "gadMethods", "gadRuntimeCatalog.json", checkOnly);
await updateRuntimeCatalog(
  "gitInterop.ts",
  "gitInteropMethods",
  "gitRuntimeCatalog.json",
  checkOnly
);
await updateRuntimeCatalog(
  "templates.ts",
  "templatesMethods",
  "templatesRuntimeCatalog.json",
  checkOnly
);

const resolutionModule = await tsImport(
  path.join(repoRoot, "packages/workspace-contracts/src/workspaceConfigSchema.ts"),
  import.meta.url
);
writeRuntimeCatalog(
  path.join(
    repoRoot,
    "packages/service-schemas/src/runtime/generated/workspaceServiceResolution.json"
  ),
  "workspaceServiceResolution.json",
  convertZodToJsonSchema(resolutionModule.ResolvedWorkspaceServiceSchema, { target: "openApi3" }),
  checkOnly
);

writeRuntimeCatalog(
  path.join(
    repoRoot,
    "packages/service-schemas/src/runtime/generated/browserDataRuntimeCatalog.json"
  ),
  "browserDataRuntimeCatalog.json",
  runtimeClientCatalog({
    root: repoRoot,
    files: [
      "packages/browser-data/src/client/browserDataClient.ts",
      "packages/browser-data/src/types.ts",
      "packages/browser-data/src/environment.ts",
      "packages/browser-data/src/storage/types.ts",
    ],
    interfaceName: "BrowserDataClient",
    namespace: "browserData",
    moduleName: "@vibestudio/browser-data/client",
  }),
  checkOnly
);

const webhookCatalog = runtimeClientCatalog({
  root: repoRoot,
  files: [
    path.relative(repoRoot, path.join(userlandRoot, "packages/runtime/src/shared/webhooks.ts")),
    "packages/shared/src/webhooks/contracts.ts",
  ],
  interfaceName: "WebhookIngressClient",
  namespace: "webhooks",
  moduleName: "@workspace/runtime",
});
const { webhookIngressMethods } = await tsImport(
  path.join(repoRoot, "packages/service-schemas/src/webhookIngress.ts"),
  import.meta.url
);
for (const [name, contract] of Object.entries(webhookCatalog)) {
  const receiver = webhookIngressMethods[name];
  if (!receiver) throw new Error(`Public webhook method lacks receiver metadata: ${name}`);
  contract.description = [receiver.description, contract.description].filter(Boolean).join("\n\n");
  contract.access = {
    ...receiver.access,
    capability: receiver.capability,
  };
}
writeRuntimeCatalog(
  path.join(repoRoot, "packages/service-schemas/src/runtime/generated/webhooksRuntimeCatalog.json"),
  "webhooksRuntimeCatalog.json",
  webhookCatalog,
  checkOnly
);

// The authoritative schema-derived surfaces live in @vibestudio/service-schemas.
const panelSurface = await loadRuntimeSurface(
  "packages/service-schemas/src/runtime/runtimeSurface.panel.ts",
  "panelRuntimeSurface"
);
const workerSurface = await loadRuntimeSurface(
  "packages/service-schemas/src/runtime/runtimeSurface.worker.ts",
  "workerRuntimeSurface"
);

updateDoc(
  userlandRoot,
  "skills/sandbox/RUNTIME_API.md",
  [["panel-runtime-surface", renderSurfaceTable(panelSurface)]],
  checkOnly
);

updateDoc(
  userlandRoot,
  "skills/workspace-dev/WORKERS.md",
  [["worker-runtime-surface", renderSurfaceTable(workerSurface)]],
  checkOnly
);

const { EVAL_IMPORTABLE_KEYS } = await tsImport(
  path.join(repoRoot, "packages/service-schemas/src/runtime/runtimeSurface.eval.ts"),
  import.meta.url
);
if (!Array.isArray(EVAL_IMPORTABLE_KEYS) || EVAL_IMPORTABLE_KEYS.length === 0) {
  throw new Error("Failed to load EVAL_IMPORTABLE_KEYS from runtimeSurface.eval.ts");
}

updateDoc(
  userlandRoot,
  "skills/sandbox/EVAL.md",
  [
    [
      "eval-importable",
      // Blank lines keep the paragraph stable under Prettier's Markdown formatting.
      `\nImportable members (generated from \`EVAL_IMPORTABLE_KEYS\` in \`runtimeSurface.eval.ts\`): ${EVAL_IMPORTABLE_KEYS.map(
        (key) => `\`${key}\``
      ).join(", ")}.\n`,
    ],
  ],
  checkOnly
);
