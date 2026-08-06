import type { CapabilityPresentation } from "../authorityPresentation.js";
import { PRODUCT_BUILTIN_CATALOG } from "../productBuiltinCatalog.generated.js";

/**
 * Product capability metadata is generated, but catalog reads are frequent.
 * Index exact capability presentations once so authority projection does not
 * scan every builtin and method for every requested row.
 */
const presentations = new Map<string, CapabilityPresentation>();
const categories = new Map<string, NonNullable<CapabilityPresentation["authorityCategory"]>>();

for (const entry of PRODUCT_BUILTIN_CATALOG) {
  for (const method of Object.values(entry.directMethods)) {
    if (!method.presentation) continue;
    presentations.set(method.capability, method.presentation);
    if (method.presentation.authorityCategory) {
      categories.set(method.capability, method.presentation.authorityCategory);
    }
  }
}

export function productBuiltinPresentation(capability: string): CapabilityPresentation | null {
  return presentations.get(capability) ?? null;
}

export function productBuiltinCategory(
  capability: string
): NonNullable<CapabilityPresentation["authorityCategory"]> | null {
  return categories.get(capability) ?? null;
}
