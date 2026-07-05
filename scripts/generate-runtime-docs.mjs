import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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
    { module, exports: module.exports, require: createRequire(import.meta.url) },
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

// The authoritative surfaces live in @vibestudio/shared; the workspace runtime
// files are re-export shims this loader cannot evaluate.
const panelSurface = loadRuntimeSurface(
  "packages/shared/src/runtimeSurface.panel.ts",
  "panelRuntimeSurface"
);
const workerSurface = loadRuntimeSurface(
  "packages/shared/src/runtimeSurface.worker.ts",
  "workerRuntimeSurface"
);

const checkOnly = process.argv.includes("--check");

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
