import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { tsImport } from "tsx/esm/api";
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const gadCatalogPath = path.join(
  repoRoot,
  "packages/service-schemas/src/runtime/generated/gadRuntimeCatalog.json"
);

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

function updateDoc(relativePath, replacements, checkOnly) {
  const filePath = path.join(repoRoot, relativePath);
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

async function updateGadRuntimeCatalog(checkOnly) {
  const schemaPath = path.join(repoRoot, "workspace/packages/runtime/src/shared/gad-schema.ts");
  const module = await tsImport(schemaPath, import.meta.url);
  const methods = module.gadMethods;
  if (!methods || typeof methods !== "object") {
    throw new Error("Failed to load gadMethods for runtime catalog generation");
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
  const next = `${JSON.stringify(catalog, null, 2)}\n`;
  const current = fs.existsSync(gadCatalogPath) ? fs.readFileSync(gadCatalogPath, "utf8") : null;
  if (checkOnly) {
    if (next !== current) {
      throw new Error(
        "packages/service-schemas/src/runtime/generated/gadRuntimeCatalog.json is out of date. " +
          "Run: pnpm run generate:runtime-docs"
      );
    }
    return;
  }
  if (next !== current) {
    fs.mkdirSync(path.dirname(gadCatalogPath), { recursive: true });
    fs.writeFileSync(gadCatalogPath, next);
  }
}

const checkOnly = process.argv.includes("--check");

await updateGadRuntimeCatalog(checkOnly);

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
  "workspace/skills/sandbox/RUNTIME_API.md",
  [["panel-runtime-surface", renderSurfaceTable(panelSurface)]],
  checkOnly
);

updateDoc(
  "workspace/skills/workspace-dev/WORKERS.md",
  [["worker-runtime-surface", renderSurfaceTable(workerSurface)]],
  checkOnly
);
