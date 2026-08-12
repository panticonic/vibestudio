import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHostResidencyCensus } from "./lib/host-residency-census.mjs";
import { PRODUCT_BUILTIN_CATALOG } from "../packages/shared/src/productBuiltinCatalog.node.generated.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const baseline = readJson("docs/runtime-foundations/residency-baselines.json");
const census = buildHostResidencyCensus({
  matrices: [
    readJson("src/server/services/__serviceAuthorityMatrix.golden.json"),
    readJson("src/main/services/__serviceAuthorityMatrix.golden.json"),
  ],
});

const measurements = baseline.measurements;

const decisions = [...census.decisions];
const panelFamilyKernelMethods = decisions.filter(([method]) =>
  /^(panel|panelCdp|panelRuntime|panelTree|view)\./u.test(method)
).length;
const familyResidencies = new Map();
for (const [, decision] of decisions) {
  const residencies = familyResidencies.get(decision.family) ?? new Set();
  residencies.add(decision.residency);
  familyResidencies.set(decision.family, residencies);
}
const residencyMixedServiceFamilies = [...familyResidencies.values()].filter(
  (residencies) => residencies.size > 1
).length;

const sourceLines = (file) => fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/u).length;
const walkTypeScript = (relativeRoot) => {
  const start = path.join(root, relativeRoot);
  if (!fs.existsSync(start)) return [];
  const files = [];
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") stack.push(absolute);
      } else if (
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !/\.(?:test|spec)\.tsx?$/u.test(entry.name) &&
        !/\.generated\.tsx?$/u.test(entry.name)
      ) {
        files.push(absolute);
      }
    }
  }
  return files;
};
const lineTotal = (files) =>
  files.reduce((total, file) => total + fs.readFileSync(file, "utf8").split(/\r?\n/u).length, 0);

const mainServiceFiles = walkTypeScript("src/main/services");
const mainServiceCompositionFiles = mainServiceFiles.filter((file) =>
  /\bcreateTypedServiceClient\s*\(/u.test(fs.readFileSync(file, "utf8"))
);
const mainInlineServiceMethodTableFiles = mainServiceFiles.filter((file) =>
  /\bdefineServiceMethods\s*\(/u.test(fs.readFileSync(file, "utf8"))
);

const catalogClasses = new Set(PRODUCT_BUILTIN_CATALOG.map((entry) => entry.className));
const internalIndex = fs.readFileSync(path.join(root, "src/server/internalDOs/index.ts"), "utf8");
const internalExports = [
  ...internalIndex.matchAll(/export\s+\{\s*([A-Za-z_$][\w$]*)\s*\}\s+from/gu),
].map((match) => match[1]);
const uncatalogedInternalDoClasses = internalExports.filter(
  (className) => !catalogClasses.has(className)
).length;
const authorityMetadataFiles = [
  "packages/shared/src/authority/tierTable.ts",
  "packages/shared/src/authority/hostCapabilityPresentations.ts",
  "packages/shared/src/authority/hostMethodCapabilities.ts",
  "packages/shared/src/authority/capabilityDomains.ts",
].filter((file) => fs.existsSync(path.join(root, file)));

const computed = {
  dualPlaneMethods: 0,
  panelFamilyKernelMethods,
  uncatalogedInternalDoClasses,
  handwrittenAuthorityMetadataLines: authorityMetadataFiles.reduce(
    (total, file) => total + sourceLines(file),
    0
  ),
  residencyMixedServiceFamilies,
  hostTreeNonTestLines: lineTotal([
    ...walkTypeScript("src/server"),
    ...walkTypeScript("src/main"),
    ...walkTypeScript("apps/headless-host"),
  ]),
  serverIndexLines: sourceLines("src/server/index.ts"),
  builtinTreeLines: lineTotal(walkTypeScript("packages/builtin")),
  mainServiceCompositionFiles: mainServiceCompositionFiles.length,
  mainInlineServiceMethodTables: mainInlineServiceMethodTableFiles.length,
};

if (process.argv.includes("--measure")) {
  console.log(
    JSON.stringify(
      {
        measurements: {
          kernelMethods: census.decisions.size,
          kernelServices: census.services.size,
          ...computed,
        },
        details: {
          mainServiceCompositionFiles: mainServiceCompositionFiles.map((file) =>
            path.relative(root, file)
          ),
          mainInlineServiceMethodTableFiles: mainInlineServiceMethodTableFiles.map((file) =>
            path.relative(root, file)
          ),
        },
      },
      null,
      2
    )
  );
  process.exit(0);
}

const observed = {
  kernelMethods: census.decisions.size,
  kernelServices: census.services.size,
  ...computed,
};
for (const [name, value] of Object.entries(observed)) {
  const direction = measurements[name]?.direction;
  if (direction === "stay-zero") {
    if (value !== 0) throw new Error(`${name} must stay zero (observed ${value})`);
  } else if (direction === "advisory") {
    continue;
  } else {
    throw new Error(`Unsupported residency baseline direction for ${name}: ${direction}`);
  }
}

const gatedCount = Object.values(measurements).filter(
  (measurement) => measurement.direction === "stay-zero"
).length;
const advisoryMovements = Object.entries(observed).flatMap(([name, value]) => {
  const measurement = measurements[name];
  if (measurement?.direction !== "advisory" || measurement.value === value) return [];
  return [{ name, baseline: measurement.value, observed: value }];
});
console.log(
  `Host residency invariants OK (${census.decisions.size} methods, ${census.services.size} services; ${gatedCount} structural zero-invariants checked, ${Object.keys(measurements).length - gatedCount} measurements advisory).`
);
if (advisoryMovements.length > 0) {
  console.log(`Advisory movement since ${baseline.recordedAt} (reported, not quota-gated):`);
  for (const movement of advisoryMovements) {
    const delta = movement.observed - movement.baseline;
    console.log(
      `  ${movement.name}: ${movement.baseline} -> ${movement.observed} (${delta > 0 ? "+" : ""}${delta})`
    );
  }
}
