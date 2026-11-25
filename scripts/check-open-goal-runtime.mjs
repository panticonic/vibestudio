import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { URL as NodeURL, fileURLToPath, pathToFileURL } from "node:url";
import { requireDevelopmentTemplateCheckouts } from "../src/dev/developmentTemplateConfig.cjs";

const host = fileURLToPath(new NodeURL("../", import.meta.url));
const { checkouts } = requireDevelopmentTemplateCheckouts(host);
const base = checkouts.base;
const profiles = [
  "base",
  "system",
  "examples",
  "personal",
  "google-workspace",
  "news",
  "spectrolite",
];
const composition = process.argv[2] ?? "all";
const withTesting = composition.endsWith("+system-testing");
const profile = withTesting ? composition.slice(0, -"+system-testing".length) : composition;
if (composition !== "all" && !profiles.includes(profile)) {
  throw new Error(`Unknown workspace composition: ${composition}`);
}
const templates =
  composition === "all"
    ? ["base", "system-testing", ...profiles.slice(1)]
    : [
        "base",
        ...(profile === "base" ? [] : [profile]),
        ...(withTesting ? ["system-testing"] : []),
      ];
const directories = templates.map((name) => checkouts[name]);
if (templates.includes("system-testing")) {
  const root = checkouts["system-testing"];
  const [runner, manifest] = await Promise.all([
    readFile(path.join(root, "workers/system-test-runner/index.ts"), "utf8"),
    readFile(path.join(root, "skills/system-testing/package.json"), "utf8").then(JSON.parse),
  ]);
  // The managed runner emits Eval code as template strings, outside TS import resolution.
  const subpaths = new Set(Array.from(
    runner.matchAll(/["']@workspace-skills\/system-testing\/([^"'$\s]+)["']/gu),
    ([, name]) => `./${name}`
  ));
  const missing = [...subpaths].filter(name => !Object.hasOwn(manifest.exports, name));
  if (missing.length) throw new Error(`Managed System tests import unexported bindings: ${missing.sort().join(", ")}`);
}
const serviceSource = pathToFileURL(
  path.join(base, "packages/natlang-services/src/serviceDeclarations.generated.ts")
);
const dependencyAnchor = pathToFileURL(path.join(host, "package.json")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@workspace/natlang-services") {
      const source = `export {generatedServiceDeclarations as serviceDeclarations} from ${JSON.stringify(serviceSource.href)};
        export function selectServices() { throw new Error("This check does not run services."); }`;
      return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
    }
    if (specifier === "yaml" || specifier.startsWith("@noble/hashes/")) {
      return next(specifier, { ...context, parentURL: dependencyAnchor });
    }
    return next(specifier, context);
  },
});

const { compileProgram, readProjectFiles } = await import(
  pathToFileURL(path.join(base, "packages/natlang/src/programs.ts"))
);
const { linkWorkspaceModules } = await import(
  pathToFileURL(path.join(base, "packages/natlang/src/workspaceModules.ts"))
);
const { TypeEnv, parseType, workerdPlatform } = await import(
  pathToFileURL(path.join(base, "packages/natlang/vendor/workerd/natlang-workerd.js"))
);

async function firstFile(relative, operation) {
  for (const directory of directories) {
    try {
      return await operation(path.join(directory, relative));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw Object.assign(new Error(`Workspace file missing: ${relative}`), { code: "ENOENT" });
}

const workspace = {
  readFile(relative, encoding) {
    return firstFile(relative, (absolute) => readFile(absolute, encoding));
  },
  stat(relative) {
    return firstFile(relative, stat);
  },
  async readdir(relative, options) {
    const entries = new Map();
    for (const directory of directories) {
      try {
        for (const entry of await readdir(path.join(directory, relative), options)) {
          if (!entries.has(entry.name)) entries.set(entry.name, entry);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return [...entries.values()];
  },
};

const directory = "skills/open-user-goal";
const files = await linkWorkspaceModules(
  workspace,
  directory,
  await readProjectFiles(workspace, directory),
  readProjectFiles
);
const platform = workerdPlatform({
  realm: {
    call() {
      throw new Error("This check does not run TypeScript tools.");
    },
  },
});
const program = compileProgram({ files, platform, entry: "runUserGoal.nl", label: directory });
const root = program.value[Symbol.for("natlang.callable")].definition;

const definitions = new Set([root]);
const qualifiedNames = new Set();
function notePath(parts) {
  for (let start = 0; start + 1 < parts.length; start++) {
    qualifiedNames.add(parts.slice(start).join("."));
  }
}
function walk(codebase, prefix = [], ancestors = new Set()) {
  for (const [name, record] of Object.entries(codebase)) {
    const parts = [...prefix, name];
    if (record.kind === "natlang") {
      definitions.add(record);
      notePath(parts);
    } else if (record.kind === "module") {
      for (const [exportName, item] of Object.entries(record.exports)) {
        if (item.kind === "function") notePath([...parts, exportName]);
      }
    }
    if (!ancestors.has(record)) walk(record.codebase, parts, new Set([...ancestors, record]));
  }
}
walk(root.codebase);

function resolvesCallable(codebase, reference) {
  const parts = reference.split(".");
  let item = codebase[parts[0]];
  for (let index = 1; index < parts.length && item; index++) {
    const part = parts[index];
    if (
      index === parts.length - 1 &&
      item.kind === "module" &&
      item.exports[part]?.kind === "function"
    ) {
      return true;
    }
    item = item.codebase[part];
  }
  return item?.kind === "natlang";
}

const checkedTypes = new Set();
const brokenTypes = [];
const scopes = [];
let references = 0;
for (const definition of definitions) {
  const { body, instructions, codebase, source, types } = definition;
  const text = instructions ?? body;
  const mentions = new Set(text.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/gu) ?? []);
  for (const mention of mentions) {
    if (!qualifiedNames.has(mention)) continue;
    references++;
    if (!resolvesCallable(codebase, mention)) scopes.push(`${source}: ${mention}`);
  }
  // The runtime checks every alias when it constructs a call, including aliases unused by its signature.
  const fingerprint = createHash("sha256").update(JSON.stringify(types)).digest("hex");
  if (!checkedTypes.has(fingerprint)) {
    checkedTypes.add(fingerprint);
    const errors = [];
    const parsed = {};
    for (const [name, type] of Object.entries(types)) {
      try {
        parsed[name] = parseType(type);
      } catch (error) {
        errors.push(`${name}: ${error.message}`);
      }
    }
    const environment = new TypeEnv(parsed);
    for (const [name, type] of Object.entries(parsed)) {
      try {
        environment.checkNames(type);
      } catch (error) {
        errors.push(`${name}: ${error.message}`);
      }
    }
    if (errors.length) brokenTypes.push({ source, errors });
  }
}

console.log(
  `${composition}: checked ${definitions.size} linked lambdas and ${references} explicit qualified references.`
);
for (const issue of scopes.sort()) console.error(`Unavailable callable ${issue}`);
for (const { source, errors } of brokenTypes)
  console.error(`Invalid type environment for ${source}: ${errors.join("; ")}`);
if (scopes.length || brokenTypes.length) process.exitCode = 1;
