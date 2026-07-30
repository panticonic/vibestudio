import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(
  root,
  "packages/shared/src/authority/hostAuthorityCatalog.generated.ts"
);
const check = process.argv.includes("--check");

const matrices = [
  "src/server/services/__serviceAuthorityMatrix.golden.json",
  "src/main/services/__serviceAuthorityMatrix.golden.json",
].map((relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")));

const methods = {};
for (const matrix of matrices) {
  for (const [service, entry] of Object.entries(matrix)) {
    for (const [method, declaration] of Object.entries(entry.methods)) {
      const qualified = `${service}.${method}`;
      if (!declaration.tier) throw new Error(`${qualified} has no schema-owned tier`);
      if (declaration.tier.tier !== "open" && !declaration.capability) {
        throw new Error(`${qualified} has no schema-owned semantic capability`);
      }
      if (declaration.tier.tier !== "open" && !declaration.presentation) {
        throw new Error(`${qualified} has no schema-owned approval presentation`);
      }
      const row = {
        tier: declaration.tier,
        capability: declaration.capability,
        presentation: declaration.presentation,
      };
      const previous = methods[qualified];
      if (previous && JSON.stringify(previous) !== JSON.stringify(row)) {
        throw new Error(`${qualified} differs between the server and main schemas`);
      }
      methods[qualified] = row;
    }
  }
}

const capabilities = {};
const capabilityPresentations = {};
for (const [method, row] of Object.entries(methods)) {
  if (!row.capability || !row.presentation) continue;
  const category = row.presentation.authorityCategory;
  if (!category) throw new Error(`${method} has no schema-owned authority category`);
  const previous = capabilities[row.capability];
  if (previous && JSON.stringify(previous) !== JSON.stringify(category)) {
    throw new Error(`${row.capability} has conflicting schema authority categories`);
  }
  capabilities[row.capability] = category;
  capabilityPresentations[row.capability] ??= row.presentation;
}

const sorted = (value) =>
  Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
const banner =
  "// Generated from live host service schemas by scripts/generate-host-authority-catalog.mjs.\n" +
  "// Do not edit: authority belongs on the MethodSchema declaration.\n";
const source = `${banner}
import type { CapabilityPresentation } from "../authorityPresentation.js";
import type { HostResidencyPolicy, MethodTierPolicy } from "../serviceAuthority.js";

export interface GeneratedHostAuthorityMethod {
  tier: MethodTierPolicy & HostResidencyPolicy;
  capability: string | null;
  presentation: CapabilityPresentation | null;
}

export const HOST_AUTHORITY_METHODS = ${JSON.stringify(sorted(methods), null, 2)} as const satisfies Record<string, GeneratedHostAuthorityMethod>;

export const HOST_CAPABILITY_CATEGORIES = ${JSON.stringify(sorted(capabilities), null, 2)} as const satisfies Record<
    string,
    NonNullable<CapabilityPresentation["authorityCategory"]>
  >;

export const HOST_SEMANTIC_PRESENTATIONS = ${JSON.stringify(sorted(capabilityPresentations), null, 2)} as const satisfies Record<string, CapabilityPresentation>;

export function generatedHostMethodAuthority(
  method: string
): GeneratedHostAuthorityMethod | null {
  return Object.prototype.hasOwnProperty.call(HOST_AUTHORITY_METHODS, method)
    ? HOST_AUTHORITY_METHODS[method as keyof typeof HOST_AUTHORITY_METHODS]
    : null;
}

export function generatedHostCapabilityCategory(
  capability: string
): NonNullable<CapabilityPresentation["authorityCategory"]> | null {
  return Object.prototype.hasOwnProperty.call(HOST_CAPABILITY_CATEGORIES, capability)
    ? HOST_CAPABILITY_CATEGORIES[capability as keyof typeof HOST_CAPABILITY_CATEGORIES]
    : null;
}

export function generatedHostCapabilityPresentation(
  capability: string
): CapabilityPresentation | null {
  return Object.prototype.hasOwnProperty.call(HOST_SEMANTIC_PRESENTATIONS, capability)
    ? HOST_SEMANTIC_PRESENTATIONS[capability as keyof typeof HOST_SEMANTIC_PRESENTATIONS]
    : null;
}

export function generatedHostCapabilityMethods(capability: string): readonly string[] {
  return Object.entries(HOST_AUTHORITY_METHODS)
    .filter(([, row]) => row.capability === capability)
    .map(([method]) => method);
}
`;
const prettierOptions = (await resolveConfig(outputPath)) ?? {};
let formatted;
try {
  formatted = await format(source, { ...prettierOptions, filepath: outputPath });
} catch (error) {
  throw new Error(`Could not format generated host authority catalog: ${error.message}`);
}
if (check) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== formatted) {
    throw new Error("Host authority catalog is stale; run pnpm generate:host-authority");
  }
} else {
  fs.writeFileSync(outputPath, formatted);
}
