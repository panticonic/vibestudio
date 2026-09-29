import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { tsImport } from "tsx/esm/api";
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import developmentTemplateConfig from "../src/dev/developmentTemplateConfig.cjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const userlandRoot = developmentTemplateConfig.requireDevelopmentTemplateCheckout(repoRoot, "base");

/**
 * Load a runtime-surface manifest by bundling it with esbuild (which resolves
 * the cross-file imports — panel → core → portable — and strips TS types), then
 * evaluating the resulting CJS. The manifests are no longer self-contained, so a
 * regex/`vm` strip can't evaluate them.
 */
function loadRuntimeSurface(relativePath, exportName) {
  const filePath = path.join(repoRoot, relativePath);
  const result = esbuild.buildSync({
    entryPoints: [filePath],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require: createRequire(import.meta.url),
      TextEncoder,
      TextDecoder,
    },
    { filename: filePath }
  );
  const runtimeSurface = module.exports[exportName];
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
  const catalogPath = path.join(repoRoot, "packages/service-schemas/src/runtime/generated", catalogFile);
  const module = await tsImport(schemaPath, import.meta.url);
  const methods = module[exportName];
  if (!methods || typeof methods !== "object") {
    throw new Error(`Failed to load ${exportName} for runtime catalog generation`);
  }
  const catalog = Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      {
        ...(method.description ? { description: method.description } : {}),
        ...(method.access ? { access: method.access } : {}),
        argsSchema: convertZodToJsonSchema(method.args, { target: "openApi3" }),
        ...(method.returns
          ? {
              returnsSchema: convertZodToJsonSchema(method.returns, {
                target: "openApi3",
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
await updateRuntimeCatalog("templates.ts", "templatesMethods", "templatesRuntimeCatalog.json", checkOnly);

const resolutionModule = await tsImport(
  path.join(repoRoot, "packages/workspace-contracts/src/workspaceConfigSchema.ts"), import.meta.url
);
writeRuntimeCatalog(
  path.join(repoRoot, "packages/service-schemas/src/runtime/generated/workspaceServiceResolution.json"),
  "workspaceServiceResolution.json",
  convertZodToJsonSchema(resolutionModule.ResolvedWorkspaceServiceSchema, { target: "openApi3" }),
  checkOnly
);

// The authoritative schema-derived surfaces live in @vibestudio/service-schemas.
const panelSurface = loadRuntimeSurface(
  "packages/service-schemas/src/runtime/runtimeSurface.panel.ts",
  "panelRuntimeSurface"
);
const workerSurface = loadRuntimeSurface(
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
