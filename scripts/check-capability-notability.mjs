/**
 * Every capability a review can render must carry a reviewed notability value
 * (docs/template-install-unit-approval-ux-plan.md §10).
 *
 * Notability decides what a user reads first on every install, creation, and
 * launch-gate surface. A capability missing from the reviewed list falls back to
 * `headline`, which is safe but noisy — and silently accumulating fallbacks is
 * how a review turns back into the wall of identical rows this plan exists to
 * delete. So the classification is exhaustive by construction: this check fails
 * the build when the host, product, or semantic catalog names a capability the
 * reviewed list does not cover.
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { reviewedCapabilityNotability } = await import(
  path.join(root, "packages/shared/src/authority/capabilityNotability.ts")
);
const { HOST_CAPABILITY_CATEGORIES } = await import(
  path.join(root, "packages/shared/src/authority/hostAuthorityCatalog.generated.ts")
);
const { PRODUCT_BUILTIN_CATALOG } = await import(
  path.join(root, "packages/shared/src/productBuiltinCatalog.generated.ts")
);
const { HOST_SEMANTIC_CAPABILITY_COPY } = await import(
  path.join(root, "packages/shared/src/hostApprovalCopy.ts")
);

const capabilities = new Map();
const note = (capability, source) => {
  if (typeof capability !== "string" || !capability) return;
  // A prefix family is classified by its own key; the reviewed list matches by
  // prefix, so asking about the bare prefix is the right question.
  if (!capabilities.has(capability)) capabilities.set(capability, source);
};

for (const capability of Object.keys(HOST_CAPABILITY_CATEGORIES)) {
  note(capability, "host capability catalog");
}
for (const { prefix } of HOST_SEMANTIC_CAPABILITY_COPY) {
  note(prefix, "semantic capability copy");
}
for (const service of PRODUCT_BUILTIN_CATALOG) {
  for (const method of Object.values(service.methods ?? {})) {
    note(method.capability, `product builtin ${service.source}/${service.className}`);
  }
}

// The shipped workspace is part of the product review input too. Its checked-in
// manifests are where installed panels, workers, apps, and extensions declare
// their maximum authority; omitting them let common workspace-service envelopes
// fall through to the safe-but-noisy contextual default without failing CI.
function visitPackageManifests(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visitPackageManifests(absolute);
      continue;
    }
    if (entry.name !== "package.json") continue;
    const manifest = JSON.parse(fs.readFileSync(absolute, "utf8"));
    for (const request of manifest.vibestudio?.authority?.requests ?? []) {
      note(request.capability, path.relative(root, absolute));
    }
  }
}

visitPackageManifests(path.join(root, "workspace"));

const missing = [];
for (const [capability, source] of capabilities) {
  // A direct userland receiver reference is classified by its provider's
  // authority definition in the same reviewed install set. Workspace-service
  // envelopes are different: shipped consumers name them directly, so every
  // shipped name must receive an explicit platform review here.
  if (capability.startsWith("userland:") || capability === "workspace-service:") continue;
  if (reviewedCapabilityNotability(capability) === null) missing.push({ capability, source });
}

if (missing.length > 0) {
  missing.sort((left, right) => left.capability.localeCompare(right.capability));
  for (const { capability, source } of missing) {
    console.error(`${capability} — declared by ${source}, missing from the reviewed list`);
  }
  console.error(
    `\n${missing.length} capabilit${missing.length === 1 ? "y is" : "ies are"} unclassified. ` +
      "Add each to REVIEWED_NOTABILITY in packages/shared/src/authority/capabilityNotability.ts.\n" +
      "headline: a reasonable non-technical person, told a part can do this, would want to know " +
      "before adding it.\neveryday: the ordinary machinery of being a part here."
  );
  process.exitCode = 1;
} else {
  console.log(`Every one of ${capabilities.size} reviewed capabilities carries a notability value.`);
}
