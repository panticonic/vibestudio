import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runtimeFoundationEvidence } from "./runtime-foundation-evidence.mjs";
import {
  assertNoOrphanEvidence,
  generatedCensusEvidence,
  resolveLedgerEvidence,
  testEvidence,
  validateEvidenceRegistry,
} from "./lib/runtime-foundation-evidence.mjs";
import { buildHostResidencyCensus } from "./lib/host-residency-census.mjs";
import {
  PRODUCT_BUILTIN_CATALOG,
  productBuiltinByIdentity,
  productBuiltinMethodCapability,
} from "../packages/shared/src/productBuiltinCatalog.node.generated.mjs";
import { gadWireMethods } from "../packages/service-schemas/src/workspaceSource.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs", "runtime-foundations");
const check = process.argv.includes("--check");
if (!check) fs.mkdirSync(output, { recursive: true });
const evidenceRegistry = validateEvidenceRegistry({ root, registry: runtimeFoundationEvidence });
const usedEvidence = new Set();

const serverServiceAuthority = JSON.parse(
  fs.readFileSync(
    path.join(root, "src/server/services/__serviceAuthorityMatrix.golden.json"),
    "utf8"
  )
);
const mainServiceAuthority = JSON.parse(
  fs.readFileSync(path.join(root, "src/main/services/__serviceAuthorityMatrix.golden.json"), "utf8")
);
const serviceAuthority = structuredClone(serverServiceAuthority);
for (const [service, entry] of Object.entries(mainServiceAuthority)) {
  const existing = serviceAuthority[service];
  if (!existing) {
    serviceAuthority[service] = entry;
    continue;
  }
  const mergedService = {
    ...existing.service,
    principals: [
      ...new Set([...(existing.service?.principals ?? []), ...(entry.service?.principals ?? [])]),
    ].sort(),
  };
  serviceAuthority[service] = {
    service: mergedService,
    methods: { ...existing.methods, ...entry.methods },
  };
}
const { decisions: hostResidencyCensus } = buildHostResidencyCensus({
  matrices: [serverServiceAuthority, mainServiceAuthority],
});

const principalExpression = (principals, capability) => {
  const requirements = [];
  if (principals.includes("host")) requirements.push(`capability(host,${capability})`);
  if (principals.includes("user")) {
    requirements.push(`allOf(capability(user,${capability}),workspace-member)`);
  }
  if (principals.includes("code")) {
    requirements.push(`allOf(capability(code,${capability}),workspace-member)`);
  }
  if (principals.includes("entity")) {
    requirements.push(`allOf(capability(entity,${capability}),agent-binding,workspace-member)`);
  }
  if (principals.includes("device")) {
    requirements.push(
      `allOf(capability(device,${capability}),device-owned-by-user,workspace-member)`
    );
  }
  const unique = [...new Set(requirements)];
  return unique.length === 1 ? unique[0] : `anyOf(${unique.join(",")})`;
};

const requirementPrincipals = (requirement) => {
  if (!requirement || typeof requirement !== "object") return [];
  if (requirement.kind === "selected") return [...new Set(requirement.principals ?? [])].sort();
  const found = [];
  if (requirement.kind === "capability" && typeof requirement.principal === "string") {
    found.push(requirement.principal);
  }
  for (const child of requirement.requirements ?? []) found.push(...requirementPrincipals(child));
  if (requirement.requirement) found.push(...requirementPrincipals(requirement.requirement));
  return [...new Set(found)].sort();
};

const authorityRows = [];
for (const [service, entry] of Object.entries(serviceAuthority).sort(([a], [b]) =>
  a.localeCompare(b)
)) {
  for (const [method, methodCensus] of Object.entries(entry.methods).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const qualifiedMethod = `${service}.${method}`;
    const hostReview = methodCensus.tier;
    if (!hostReview) {
      throw new Error(`${qualifiedMethod} has no reviewed host residency decision`);
    }
    if (!hostReview.residency || !hostReview.family) {
      throw new Error(`${qualifiedMethod} has incomplete reviewed host residency metadata`);
    }
    const override = methodCensus.authority;
    const declaration = override?.inherits ? entry.service : override;
    const sensitivity = methodCensus.access?.sensitivity;
    const capability = `service:${service}.${method}`;
    const principals = declaration.principals ?? requirementPrincipals(declaration.requirement);
    if (principals.includes("code") && !sensitivity) {
      throw new Error(`${service}.${method} admits code but has no reviewed sensitivity`);
    }
    authorityRows.push({
      id: `host:${service}.${method}`,
      rpcPlane: "host-service",
      owner: service,
      method,
      tier: hostReview.tier,
      sessionAdmission: hostReview.session,
      residency: hostReview.residency,
      mechanismFamily: hostReview.family,
      reviewRationale: hostReview.rationale,
      resourceDerivation: declaration.resource ?? { kind: "literal", key: capability },
      authorityPrincipals: principals,
      sensitivity: sensitivity ?? "unknown",
      authenticatedFacts: [
        "session",
        "acting-user",
        "device",
        "runtime-entity",
        "exact-code-artifact-when-code-originated",
        "workspace-membership",
        "agent-binding-when-agent-originated",
      ],
      currentOutcomes: {
        allowed: "declared caller scenarios retain their existing allow/approval flow",
        denied: "undeclared or unauthenticated scenarios fail with EACCES",
      },
      predicates: ["live-session", "live-workspace-membership", "exact-resource-scope"],
      r3aRequirement: declaration.requirement
        ? JSON.stringify(declaration.requirement).replaceAll("$method", capability)
        : principalExpression(principals, capability),
      r3b: { review: "unchanged-parity", change: null },
      evidence: generatedCensusEvidence("host-authority"),
    });
    for (const additional of declaration.additional ?? []) {
      authorityRows.push({
        id: `host:${service}.${method}#${additional.capability}`,
        rpcPlane: "host-service",
        owner: service,
        method,
        tier: additional.tier ?? hostReview.tier,
        sessionAdmission: hostReview.session,
        residency: hostReview.residency,
        mechanismFamily: hostReview.family,
        reviewRationale: hostReview.rationale,
        capability: additional.capability,
        resourceDerivation: additional.resource,
        authorityPrincipals: requirementPrincipals(additional.requirement),
        sensitivity: sensitivity ?? "unknown",
        authenticatedFacts: [
          "session",
          "acting-user",
          "device",
          "runtime-entity",
          "exact-code-artifact-when-code-originated",
          "workspace-membership",
          "agent-binding-when-agent-originated",
        ],
        currentOutcomes: {
          allowed: "declared additional authority leaf satisfied",
          denied: "missing additional authority leaf fails with EACCES",
        },
        predicates: ["live-session", "exact-resource-scope"],
        r3aRequirement: JSON.stringify(additional.requirement),
        r3b: { review: "schema-owned-additional-leaf", change: null },
        evidence: generatedCensusEvidence("host-authority"),
      });
    }
    for (const leaf of declaration.prepared?.leaves ?? []) {
      const selector =
        leaf.capability !== undefined
          ? { kind: "capability", value: leaf.capability }
          : { kind: "capability-prefix", value: leaf.capabilityPrefix };
      if (
        typeof selector.value !== "string" ||
        selector.value.length === 0 ||
        (selector.kind === "capability-prefix" && !selector.value.endsWith(":"))
      ) {
        throw new Error(`${service}.${method} has an invalid prepared authority selector`);
      }
      authorityRows.push({
        id: `host:${service}.${method}#${selector.kind}:${selector.value}`,
        rpcPlane: "host-service",
        owner: service,
        method,
        tier:
          typeof leaf.tier === "string"
            ? leaf.tier
            : (leaf.tier?.selectedFrom?.join("|") ?? hostReview.tier),
        sessionAdmission: hostReview.session,
        residency: hostReview.residency,
        mechanismFamily: hostReview.family,
        reviewRationale: hostReview.rationale,
        ...(selector.kind === "capability"
          ? { capability: selector.value }
          : { capabilitySelector: selector }),
        resourceDerivation: {
          kind: "prepared",
          resolver: declaration.prepared.resolver,
        },
        authorityPrincipals: requirementPrincipals(leaf.requirement),
        sensitivity: sensitivity ?? "unknown",
        authenticatedFacts: [
          "session",
          "acting-user",
          "runtime-entity",
          "exact-code-artifact-when-code-originated",
          "schema-owned-authority-preparation",
        ],
        currentOutcomes: {
          allowed: "prepared authority leaf selected and satisfied",
          denied: "missing prepared authority leaf fails before handler entry",
        },
        predicates: ["live-session", "exact-prepared-resource", "registered-preparer"],
        r3aRequirement: JSON.stringify(leaf.requirement),
        r3b: { review: "schema-owned-prepared-leaf", change: null },
        evidence: generatedCensusEvidence("host-authority"),
      });
    }
  }
}

const directRoots = [
  path.join(root, "packages", "builtin"),
  path.join(root, "workspace", "workers"),
  path.join(root, "workspace", "packages"),
];
const schemaRpcCatalog = new Map([["vibestudio.gad.workspace.v1", gadWireMethods]]);
const directSource = (file) => {
  const sealedPackagesRoot = path.join(root, "packages");
  if (file.startsWith(sealedPackagesRoot)) {
    let directory = path.dirname(file);
    while (directory.startsWith(sealedPackagesRoot)) {
      if (fs.existsSync(path.join(directory, "package.json"))) {
        return path.relative(root, directory).replaceAll(path.sep, "/");
      }
      if (directory === sealedPackagesRoot) break;
      directory = path.dirname(directory);
    }
  }
  let directory = path.dirname(file);
  const workspaceRoot = path.join(root, "workspace");
  while (directory.startsWith(workspaceRoot)) {
    if (fs.existsSync(path.join(directory, "package.json"))) {
      return path.relative(workspaceRoot, directory).replaceAll(path.sep, "/");
    }
    if (directory === workspaceRoot) break;
    directory = path.dirname(directory);
  }
  throw new Error(`Direct RPC source ${path.relative(root, file)} has no owning package`);
};
const directCapability = (source, method, sensitivity, declaration = "") => {
  const declaredCapability = declaration.match(
    /effect:\s*\{\s*kind:\s*["'](?:userland-capability|host-capability)["']\s*,\s*capability:\s*["']([^"']+)["']/
  )?.[1];
  if (declaredCapability) return declaredCapability;
  if (/effect:\s*\{\s*kind:\s*["']open["']/.test(declaration)) {
    return null;
  }
  return null;
};
const builtinClassForFile = (file) => {
  if (!file.startsWith(path.join(root, "packages", "builtin"))) return null;
  for (const className of ["WorkspaceDO", "BrowserDataDO", "EvalDO", "WebhookStoreDO"]) {
    if (
      path.basename(file) === `${className}.ts` &&
      productBuiltinByIdentity("vibestudio/internal", className)
    ) {
      return className;
    }
  }
  return null;
};
const walk = (directory) => {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      files.push(absolute);
    }
  }
  return files;
};
const rpcPattern =
  /@rpc\(\{\s*principals:\s*\[([^\]]*)\][\s\S]*?\}\)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
const namedRpcPattern = /@rpc\(([A-Z][A-Z0-9_]*)\)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
const factoryRpcPattern =
  /@rpc\(([A-Za-z_$][\w$]*)\(["'](read|write|admin|destructive)["']\)\)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;

function functionDeclarationSource(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const brace = source.indexOf("{", start);
  if (brace < 0) return null;
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}
for (const file of directRoots.flatMap(walk).sort()) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(rpcPattern)) {
    const principals = [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]).sort();
    const method = match[2];
    const owner = path.relative(root, file).replaceAll(path.sep, "/");
    const sensitivity = match[0].match(
      /sensitivity:\s*["'](read|write|admin|destructive)["']/
    )?.[1];
    const tier = match[0].match(/tier:\s*["'](open|gated|critical)["']/)?.[1];
    if (!tier) throw new Error(`${owner}:${method} has no reviewed tier`);
    if (principals.includes("code") && !sensitivity) {
      throw new Error(`${owner}:${method} admits code but has no reviewed sensitivity`);
    }
    const sourceName = directSource(file);
    authorityRows.push({
      id: `direct:${owner}:${method}`,
      rpcPlane: "workspace-do",
      owner,
      source: sourceName,
      method,
      resourceDerivation: { kind: "direct-target", owner },
      authorityPrincipals: principals,
      sensitivity: sensitivity ?? "unknown",
      tier,
      capability:
        productBuiltinMethodCapability("vibestudio/internal", builtinClassForFile(file), method) ??
        directCapability(sourceName, method, sensitivity, match[0]),
      authenticatedFacts: [
        "session",
        "acting-user-relay",
        "runtime-entity",
        "exact-code-artifact",
        "owner-chain",
        "agent-binding",
        "audience-bound-delegation",
      ],
      currentOutcomes: {
        allowed: "declared direct-RPC scenarios retain their current behavior",
        denied: "missing attested facts or requirement failure is EACCES",
      },
      predicates: [
        "live-owner-service-relationship",
        "exact-resource-scope",
        "next-dispatch-revocation",
      ],
      r3aRequirement: principalExpression(principals, `rpc:${method}`),
      r3b: { review: "unchanged-parity", change: null },
      evidence: generatedCensusEvidence("direct-authority"),
    });
  }
  for (const match of source.matchAll(namedRpcPattern)) {
    const declaration = match[1];
    const method = match[2];
    const owner = path.relative(root, file).replaceAll(path.sep, "/");
    const declarationStart = source.indexOf(`const ${declaration} =`);
    const declarationEnd = source.indexOf("} as const;", declarationStart);
    const declarationSource = source.slice(
      declarationStart,
      declarationEnd < 0 ? declarationStart : declarationEnd
    );
    const sensitivity = declarationSource.match(
      /sensitivity:\s*["'](read|write|admin|destructive)["']/
    )?.[1];
    const tier = declarationSource.match(/tier:\s*["'](open|gated|critical)["']/)?.[1];
    const principals = [...declarationSource.matchAll(/methodCapability\(["']([^"']+)["']\)/g)]
      .map((item) => item[1])
      .sort();
    if (!sensitivity || !tier) {
      throw new Error(`${owner}:${method} uses ${declaration} without a reviewed tier/sensitivity`);
    }
    const sourceName = directSource(file);
    authorityRows.push({
      id: `direct:${owner}:${method}`,
      rpcPlane: "workspace-do",
      owner,
      source: sourceName,
      method,
      resourceDerivation: { kind: "direct-target", owner },
      authorityPrincipals: principals,
      sensitivity,
      tier,
      capability:
        productBuiltinMethodCapability("vibestudio/internal", builtinClassForFile(file), method) ??
        directCapability(sourceName, method, sensitivity, declarationSource),
      authenticatedFacts: [
        "session",
        "acting-user-relay",
        "runtime-entity",
        "exact-code-artifact",
        "owner-chain",
        "agent-binding",
        "audience-bound-delegation",
      ],
      currentOutcomes: {
        allowed: "structured direct-RPC requirement satisfied",
        denied: "missing attested facts or requirement failure is EACCES",
      },
      predicates: [
        "live-owner-service-relationship",
        "exact-resource-scope",
        "next-dispatch-revocation",
      ],
      r3aRequirement: `declared:${declaration}`,
      r3b: { review: "unchanged-parity", change: null },
      evidence: generatedCensusEvidence("direct-authority"),
    });
  }
  for (const match of source.matchAll(factoryRpcPattern)) {
    const factory = match[1];
    const sensitivity = match[2];
    const method = match[3];
    const owner = path.relative(root, file).replaceAll(path.sep, "/");
    const declarationSource = functionDeclarationSource(source, factory);
    if (!declarationSource) {
      throw new Error(`${owner}:${method} uses unresolved RPC authority factory ${factory}`);
    }
    const principals = [
      ...declarationSource.matchAll(/capability\(["'](host|user|code|session|mission)["']\s*,/g),
    ]
      .map((item) => item[1])
      .filter((principal, index, all) => all.indexOf(principal) === index)
      .sort();
    const tier = declarationSource.match(/tier:\s*["'](open|gated|critical)["']/)?.[1];
    if (principals.length === 0) {
      throw new Error(
        `${owner}:${method} RPC authority factory ${factory} has no capability leaves`
      );
    }
    if (!tier) throw new Error(`${owner}:${method} RPC authority factory ${factory} has no tier`);
    const sourceName = directSource(file);
    authorityRows.push({
      id: `direct:${owner}:${method}`,
      rpcPlane: "workspace-do",
      owner,
      source: sourceName,
      method,
      resourceDerivation: { kind: "direct-target", owner },
      authorityPrincipals: principals,
      sensitivity,
      tier,
      capability:
        productBuiltinMethodCapability("vibestudio/internal", builtinClassForFile(file), method) ??
        directCapability(sourceName, method, sensitivity),
      authenticatedFacts: [
        "session",
        "acting-user-relay",
        "runtime-entity",
        "exact-code-artifact",
        "owner-chain",
        "agent-binding",
        "audience-bound-attestation",
      ],
      currentOutcomes: {
        allowed: "instance-resolved direct-RPC requirement satisfied",
        denied: "missing attested facts or requirement failure is EACCES",
      },
      predicates: [
        "live-owner-service-relationship",
        "exact-resource-scope",
        "next-dispatch-revocation",
      ],
      r3aRequirement: `factory:${factory}`,
      r3b: { review: "instance-resolved-parity", change: null },
      evidence: generatedCensusEvidence("direct-authority"),
    });
  }
}

const workspacePackageRoots = [
  path.join(root, "workspace", "workers"),
  path.join(root, "workspace", "packages"),
];
const walkPackageManifests = (directory) => {
  if (!fs.existsSync(directory)) return [];
  const manifests = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) manifests.push(...walkPackageManifests(absolute));
    else if (entry.isFile() && entry.name === "package.json") manifests.push(absolute);
  }
  return manifests;
};
const workspacePackageManifests = workspacePackageRoots.flatMap(walkPackageManifests);
for (const manifestPath of workspacePackageManifests.sort()) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const packageDirectory = path.dirname(manifestPath);
  const entry = manifest.vibestudio?.entry;
  const durableClasses = manifest.vibestudio?.durable?.classes ?? [];
  if (typeof entry !== "string" || durableClasses.length === 0) continue;
  const sourceFile = path.join(packageDirectory, entry);
  const source = fs.readFileSync(sourceFile, "utf8");
  const exposed = [
    ...source.matchAll(
      /@schemaRpc\(\)\s+(?:async\s+)?(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*\(/g
    ),
  ].map((match) => match[1] ?? match[2]);
  for (const durableClass of durableClasses) {
    const schemaId = durableClass.rpcSchema;
    if (typeof schemaId !== "string") continue;
    const methods = schemaRpcCatalog.get(schemaId);
    if (!methods) throw new Error(`Unknown workspace RPC schema ${schemaId} in ${manifestPath}`);
    if (!source.includes(`class ${durableClass.className}`)) {
      throw new Error(`${manifestPath} declares missing durable class ${durableClass.className}`);
    }
    const declared = Object.keys(methods);
    const missing = declared.filter((method) => !exposed.includes(method));
    const undeclared = exposed.filter((method) => !declared.includes(method));
    if (missing.length > 0 || undeclared.length > 0) {
      throw new Error(
        `${durableClass.className} schema RPC exposure differs from ${schemaId}: ` +
          `missing=[${missing.join(",")}], undeclared=[${undeclared.join(",")}]`
      );
    }
    const owner = path.relative(root, sourceFile).replaceAll(path.sep, "/");
    const sourceName = path
      .relative(path.join(root, "workspace"), packageDirectory)
      .replaceAll(path.sep, "/");
    for (const method of declared) {
      const policy = methods[method];
      const principals = [...(policy.authority?.principals ?? [])].sort();
      const sensitivity = policy.access?.sensitivity;
      const tier = policy.tier?.tier;
      if (!sensitivity || !tier || principals.length === 0 || !policy.capability) {
        throw new Error(`${schemaId}.${method} has incomplete schema-owned authority`);
      }
      authorityRows.push({
        id: `direct:${owner}:${method}`,
        rpcPlane: "workspace-do",
        owner,
        source: sourceName,
        method,
        resourceDerivation: { kind: "direct-target", owner },
        authorityPrincipals: principals,
        sensitivity,
        tier,
        sessionAdmission: policy.tier.session,
        capability: policy.capability,
        authenticatedFacts: [
          "session",
          "acting-user-relay",
          "runtime-entity",
          "exact-code-artifact",
          "owner-chain",
          "agent-binding",
          "audience-bound-attestation",
        ],
        currentOutcomes: {
          allowed: "schema-declared direct-RPC requirement satisfied",
          denied: "missing attested facts or requirement failure is EACCES",
        },
        predicates: [
          "live-owner-service-relationship",
          "exact-resource-scope",
          "next-dispatch-revocation",
        ],
        r3aRequirement:
          policy.directEffect?.kind === "open"
            ? "schema-open"
            : principalExpression(principals, policy.capability),
        r3b: { review: "schema-authority", change: null },
        evidence: generatedCensusEvidence("direct-authority"),
      });
    }
  }
}

for (const builtin of PRODUCT_BUILTIN_CATALOG) {
  if (!builtin.directMethods) continue;
  const file = path.join(root, builtin.sourceFile);
  const source = fs.readFileSync(file, "utf8");
  const exposed = [
    ...source.matchAll(
      /@schemaRpc\(\)\s+(?:async\s+)?(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*\(/g
    ),
  ].map((match) => match[1] ?? match[2]);
  if (exposed.length === 0) continue;
  const declared = Object.keys(builtin.directMethods);
  const missing = declared.filter((method) => !exposed.includes(method));
  const undeclared = exposed.filter((method) => !declared.includes(method));
  if (missing.length > 0 || undeclared.length > 0) {
    throw new Error(
      `${builtin.className} schema RPC exposure differs from its catalog: ` +
        `missing=[${missing.join(",")}], undeclared=[${undeclared.join(",")}]`
    );
  }
  for (const method of declared) {
    const policy = builtin.directMethods[method];
    authorityRows.push({
      id: `direct:${builtin.sourceFile}:${method}`,
      rpcPlane: "workspace-do",
      owner: builtin.sourceFile,
      source: "vibestudio/internal",
      method,
      resourceDerivation: { kind: "direct-target", owner: builtin.sourceFile },
      authorityPrincipals: [...policy.principals].sort(),
      sensitivity: policy.sensitivity,
      tier: policy.tier,
      sessionAdmission: policy.session,
      capability: policy.capability,
      authenticatedFacts: [
        "session",
        "acting-user-relay",
        "runtime-entity",
        "exact-code-artifact",
        "owner-chain",
        "agent-binding",
        "audience-bound-attestation",
      ],
      currentOutcomes: {
        allowed: "schema-declared direct-RPC requirement satisfied",
        denied: "missing attested facts or requirement failure is EACCES",
      },
      predicates: [
        "live-owner-service-relationship",
        "exact-resource-scope",
        "next-dispatch-revocation",
      ],
      r3aRequirement: "catalog-schema",
      r3b: { review: "schema-authority", change: null },
      evidence: generatedCensusEvidence("direct-authority"),
    });
  }
}
authorityRows.sort((a, b) => a.id.localeCompare(b.id));
for (const row of authorityRows) {
  if (row.rpcPlane === "workspace-do" && row.tier !== "open" && !row.capability) {
    throw new Error(`${row.owner}:${row.method} has no manifest-facing semantic capability`);
  }
}

/**
 * The generator may describe reviewed authority, but it must never approve a
 * changed census merely because code was added. This compact admission input is
 * edited only as part of authority review; ordinary generation checks its
 * digest and then renders the derived ledgers.
 */
const authorityReview = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/runtime-authority-review.json"), "utf8")
);
if (
  authorityReview.version !== 1 ||
  typeof authorityReview.censusDigest !== "string" ||
  !/^sha256:[0-9a-f]{64}$/.test(authorityReview.censusDigest) ||
  !authorityReview.decisions ||
  typeof authorityReview.decisions !== "object" ||
  Array.isArray(authorityReview.decisions)
) {
  throw new Error("scripts/runtime-authority-review.json has an unsupported schema");
}
const reviewProjection = authorityRows.map((row) => ({
  id: row.id,
  rpcPlane: row.rpcPlane,
  owner: row.owner,
  ...(row.source ? { source: row.source } : {}),
  method: row.method,
  resourceDerivation: row.resourceDerivation,
  authorityPrincipals: row.authorityPrincipals,
  sensitivity: row.sensitivity,
  ...(row.tier ? { tier: row.tier } : {}),
  ...(row.sessionAdmission ? { sessionAdmission: row.sessionAdmission } : {}),
  ...(row.residency ? { residency: row.residency } : {}),
  ...(row.mechanismFamily ? { mechanismFamily: row.mechanismFamily } : {}),
  ...(row.capability ? { capability: row.capability } : {}),
  ...(row.capabilitySelector ? { capabilitySelector: row.capabilitySelector } : {}),
  r3aRequirement: row.r3aRequirement,
}));
const censusDigest = `sha256:${createHash("sha256")
  .update(JSON.stringify(reviewProjection))
  .digest("hex")}`;
if (authorityReview.censusDigest !== censusDigest) {
  throw new Error(
    `Runtime authority census is not reviewed: expected ${authorityReview.censusDigest}, observed ${censusDigest}. ` +
      "Review the authority projection and update scripts/runtime-authority-review.json explicitly."
  );
}
const rowsById = new Map(authorityRows.map((row) => [row.id, row]));
const unknownReviewRows = Object.keys(authorityReview.decisions).filter((id) => !rowsById.has(id));
if (unknownReviewRows.length > 0) {
  throw new Error(`Runtime authority review names unknown rows: ${unknownReviewRows.join(", ")}`);
}
for (const [id, decision] of Object.entries(authorityReview.decisions)) {
  if (
    !decision ||
    typeof decision !== "object" ||
    Object.keys(decision).sort().join(",") !== "change,review" ||
    typeof decision.review !== "string" ||
    decision.review.length === 0 ||
    typeof decision.change !== "string" ||
    decision.change.length === 0
  ) {
    throw new Error(`Runtime authority review for ${id} is invalid`);
  }
}
for (const row of authorityRows) {
  const decision = authorityReview.decisions[row.id];
  if (decision) row.r3b = decision;
  if (!row.capabilitySelector && !row.capability) {
    row.capability =
      row.rpcPlane === "host-service" ? `service:${row.owner}.${row.method}` : `rpc:${row.method}`;
  }
}

const executionRows = [
  [
    "runtime.createEntity",
    "head/state/artifact",
    "surface-adapter",
    "execution.runtime-create-entity",
  ],
  [
    "ensureDurableObjectEntity",
    "head/state/artifact",
    "next-request",
    "execution.ensure-durable-object",
  ],
  ["workerd.startWorker", "head/state/artifact", "next-request", "execution.workerd-start-worker"],
  ["worker-push-rebuild", "matching-head", "next-request", "execution.worker-push-rebuild"],
  [
    "durable-object-push-rebuild",
    "matching-head",
    "next-request",
    "execution.durable-object-push-rebuild",
  ],
  ["eval-do", "exact-product-seed", "new-eval-incarnation", "execution.eval-do"],
  ["vcs-store", "exact-product-seed", "bootstrap-manifest", "execution.vcs-store"],
  ["agent-spawn", "resolved-exact-artifact", "launch", "execution.agent-spawn"],
  ["panel", "selected-source-ref", "explicit-reload-or-navigation", "execution.panel"],
  ["electron-app", "resolved-exact-artifact", "load-update", "execution.electron-app"],
  ["react-native-app", "resolved-exact-artifact", "mobile-install", "execution.react-native-app"],
  ["terminal-app", "resolved-exact-artifact", "process-restart", "execution.terminal-app"],
  ["extension", "resolved-exact-artifact", "supervised-restart", "execution.extension"],
  [
    "claude-code",
    "host-plugin-plus-context-state",
    "managed-process-launch",
    "execution.claude-code",
  ],
].map(([surface, selector, adoption, testId]) => ({
  surface,
  selector,
  executableIdentity: "full-execution-digest",
  adoption,
  rollback: "last-good-remains-authoritative",
  inFlightWork: "preserved-until-surface-boundary",
  durableStorage: "stable-logical-entity-namespace",
  visibleProgress: "surface-specific-existing-loading-or-status",
  provenance: ["source-state", "recipe", "build-key", "artifact-digest", "execution-digest"],
  evidence: testEvidence(testId),
}));

const channelRows = [
  [
    "ordinary-subscribe",
    "workspace-authorized identity may atomically initialize ordinary channel context and config; invitation membership is not an ACL",
    "channel.ordinary.authenticated-admission",
  ],
  [
    "invitation",
    "durable per-user discovery metadata for explicitly invited workspace members; no fabricated presence",
    "channel.invitation.discovery-metadata",
  ],
  [
    "presence",
    "one authenticated human identity may own multiple live delivery sessions without duplicating roster presence",
    "channel.presence.canonical-human",
  ],
  [
    "fork-clone",
    "a fork gets a fresh context and retains the parent log prefix as explicit origin",
    "channel.fork.context-and-log-origin",
  ],
  [
    "reconnect",
    "transport reconnection re-establishes the authenticated subscription and does not create authority",
    "channel.reconnect.authority-neutral",
  ],
  [
    "locked-admission",
    "host initializes one immutable exact-principal policy; subscribe verifies canonical participant identity and active durable-object incarnation",
    "channel.locked.exact-admission",
  ],
].map(([behavior, contract, testId]) => ({
  behavior,
  contract,
  policyChange: null,
  evidence: testEvidence(testId),
}));

const bootstrap = {
  version: 1,
  productPrincipal: "host:<full-product-build-digest>",
  root: "verified-product-boot-manifest",
  nodes: [
    { id: "boot-manifest", trust: "sealed-host-root", artifact: "content-addressed" },
    { id: "content-store", trust: "bootstrap", artifact: "manifest-entry" },
    { id: "execution-artifact-store", trust: "bootstrap", artifact: "manifest-entry" },
    { id: "workspace-do-substrate", trust: "bootstrap", artifact: "manifest-entry" },
    { id: "authority-grant-store", trust: "bootstrap", artifact: "manifest-entry" },
    { id: "context-binding", trust: "bootstrap", artifact: "manifest-entry" },
    { id: "ordinary-product-seeds", trust: "ordinary-runtime", artifact: "exact-artifacts" },
  ],
  edges: [
    ["boot-manifest", "content-store"],
    ["content-store", "execution-artifact-store"],
    ["execution-artifact-store", "workspace-do-substrate"],
    ["workspace-do-substrate", "authority-grant-store"],
    ["authority-grant-store", "context-binding"],
    ["context-binding", "ordinary-product-seeds"],
  ],
  forbiddenAboveRoot: [
    "EvalDO",
    "VCS product service",
    "browser data",
    "webhook handlers",
    "System Agent",
  ],
  evidence: generatedCensusEvidence("bootstrap"),
};

const hostCensusIds = Object.entries(serviceAuthority)
  .flatMap(([service, entry]) =>
    Object.keys(entry.methods).map((method) => `host:${service}.${method}`)
  )
  .sort();
const actualHostCensusIds = authorityRows
  .filter((row) => row.rpcPlane === "host-service" && !row.id.includes("#"))
  .map((row) => row.id)
  .sort();
if (JSON.stringify(actualHostCensusIds) !== JSON.stringify(hostCensusIds)) {
  throw new Error("Host authority generated census is incomplete or duplicated");
}
const directCensusIds = authorityRows
  .filter((row) => row.rpcPlane === "workspace-do")
  .map((row) => row.id);
if (new Set(directCensusIds).size !== directCensusIds.length) {
  throw new Error("Direct authority generated census contains duplicate methods");
}
const bootstrapNodeIds = new Set(bootstrap.nodes.map((node) => node.id));
const incoming = new Map([...bootstrapNodeIds].map((id) => [id, 0]));
const outgoing = new Map([...bootstrapNodeIds].map((id) => [id, []]));
for (const [from, to] of bootstrap.edges) {
  if (!bootstrapNodeIds.has(from) || !bootstrapNodeIds.has(to)) {
    throw new Error(`Bootstrap generated census has unknown edge ${from} -> ${to}`);
  }
  outgoing.get(from).push(to);
  incoming.set(to, incoming.get(to) + 1);
}
const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
let visited = 0;
while (queue.length > 0) {
  const id = queue.shift();
  visited += 1;
  for (const next of outgoing.get(id)) {
    incoming.set(next, incoming.get(next) - 1);
    if (incoming.get(next) === 0) queue.push(next);
  }
}
if (visited !== bootstrapNodeIds.size || queue.length > 0) {
  throw new Error("Bootstrap generated census contains a dependency cycle");
}

const materializeEvidence = (ledger, subject, row) => {
  const { evidence, ...value } = row;
  return {
    ...value,
    parityAssertion: resolveLedgerEvidence({
      ledger,
      subject,
      evidence,
      registry: evidenceRegistry,
      used: usedEvidence,
    }),
  };
};
const serializedAuthorityRows = authorityRows.map((row) =>
  materializeEvidence("authority-ledger", `row ${JSON.stringify(row.id)}`, row)
);
const serializedExecutionRows = executionRows.map((row) =>
  materializeEvidence("execution-update-ledger", `surface ${JSON.stringify(row.surface)}`, row)
);
const serializedChannelRows = channelRows.map((row) =>
  materializeEvidence("channel-behavior-ledger", `behavior ${JSON.stringify(row.behavior)}`, row)
);
const serializedBootstrap = materializeEvidence("bootstrap-dependency-graph", "graph", bootstrap);
assertNoOrphanEvidence(evidenceRegistry, usedEvidence);

const write = (name, value) => {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  const target = path.join(output, name);
  if (check) {
    const actual = fs.readFileSync(target, "utf8");
    if (actual !== expected) {
      throw new Error(
        `${path.relative(root, target)} is stale; run pnpm generate:runtime-foundations`
      );
    }
    return;
  }
  fs.writeFileSync(target, expected);
};
write("execution-update-ledger.json", { version: 1, rows: serializedExecutionRows });
write("authority-ledger.json", { version: 1, rows: serializedAuthorityRows });
write("channel-behavior-ledger.json", { version: 1, rows: serializedChannelRows });
write("bootstrap-dependency-graph.json", serializedBootstrap);
