import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { tsImport } from "tsx/esm/api";
const { analyzeModuleImports } = await tsImport(
  "../../packages/module-imports/src/index.ts",
  import.meta.url
);

const importCache = new Map();
export function compilerImports(file) {
  const source = fs.readFileSync(file, "utf8");
  const hash = createHash("sha256").update(source).digest("hex");
  const cached = importCache.get(file);
  if (cached?.hash === hash) return cached.imports;
  const imports = analyzeModuleImports(source, file);
  importCache.set(file, { hash, imports });
  return imports;
}

export function relativeCompilerInput(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  const extension = path.extname(base);
  const stem = base.slice(0, extension ? -extension.length : undefined);
  const substitutions = {
    ".js": [".ts", ".tsx", ".d.ts", ".js"],
    ".jsx": [".tsx", ".d.ts", ".jsx"],
    ".mjs": [".mts", ".d.mts", ".mjs"],
    ".cjs": [".cts", ".d.cts", ".cjs"],
    "": [".ts", ".tsx", ".d.ts", ".js", ".jsx"],
  };
  const candidates = substitutions[extension]?.map((suffix) => stem + suffix) ?? [base];
  if (!extension)
    candidates.push(
      ...[".ts", ".tsx", ".d.ts", ".js", ".jsx"].map((suffix) => path.join(base, "index" + suffix))
    );
  return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
}

// The compiler owns config inheritance, include/exclude, and root expansion.
// Follow relative imports too: excluded files can still be executable inputs.
export function compilerInputs(api, configFile) {
  const parsed = api.parseConfigFile(configFile);
  const files = new Set(parsed.fileNames);
  const pending = [...files];
  for (const file of pending) {
    if (!/\.[cm]?tsx?$/.test(file) || !fs.existsSync(file)) continue;
    for (const { specifier } of compilerImports(file)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = relativeCompilerInput(file, specifier);
      if (resolved && !files.has(resolved)) {
        files.add(resolved);
        pending.push(resolved);
      }
    }
  }
  return { files, options: parsed.options };
}

export function compilerOutputs(inputs) {
  const { rootDir, outDir, declaration, declarationMap, sourceMap, emitDeclarationOnly, jsx } =
    inputs.options;
  if (!rootDir || !outDir) throw new Error("Incremental packages must declare rootDir and outDir");
  const outputs = new Set();
  for (const file of inputs.files) {
    if (/\.d\.[cm]?ts$/.test(file)) continue;
    const relative = path.relative(rootDir, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const stem = path.resolve(outDir, relative.replace(/\.[cm]?tsx?$/, ""));
    if (file.endsWith(".json")) {
      outputs.add(path.resolve(outDir, relative));
      continue;
    }
    if (!/\.[cm]?tsx?$/.test(file)) continue;
    const suffix = file.endsWith(".mts")
      ? ".mjs"
      : file.endsWith(".cts")
        ? ".cjs"
        : file.endsWith(".tsx") && jsx === "preserve"
          ? ".jsx"
          : ".js";
    if (!emitDeclarationOnly) {
      outputs.add(stem + suffix);
      if (sourceMap) outputs.add(stem + suffix + ".map");
    }
    if (declaration) {
      const typeSuffix = suffix === ".mjs" ? ".d.mts" : suffix === ".cjs" ? ".d.cts" : ".d.ts";
      outputs.add(stem + typeSuffix);
      if (declarationMap) outputs.add(stem + typeSuffix + ".map");
    }
  }
  return outputs;
}
