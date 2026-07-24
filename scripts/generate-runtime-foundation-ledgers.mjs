import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import YAML from "yaml";
import { PRODUCT_WORKSPACE_SERVICES } from "../packages/shared/src/productWorkspaceServices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prettierOptions = (await resolveConfig(path.join(root, "src", "server", "index.ts"))) ?? {};

const formatTypeScript = async (source, filepath) => {
  const seen = new Set();
  let current = source;
  while (!seen.has(current)) {
    seen.add(current);
    const formatted = await format(current, { ...prettierOptions, filepath });
    if (formatted === current) return formatted;
    current = formatted;
  }
  throw new Error(`Prettier did not converge for ${path.relative(root, filepath)}`);
};
const output = path.join(root, "docs", "runtime-foundations");
const check = process.argv.includes("--check");
if (!check) fs.mkdirSync(output, { recursive: true });

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
      parityAssertion: "src/server/services/runtimeFoundationLedgers.test.ts#host-authority-census",
    });
    for (const additional of declaration.additional ?? []) {
      authorityRows.push({
        id: `host:${service}.${method}#${additional.capability}`,
        rpcPlane: "host-service",
        owner: service,
        method,
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
        parityAssertion:
          "src/server/services/runtimeFoundationLedgers.test.ts#host-authority-census",
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
        parityAssertion:
          "src/server/services/runtimeFoundationLedgers.test.ts#host-authority-census",
      });
    }
  }
}

const directRoots = [
  path.join(root, "src", "server", "internalDOs"),
  path.join(root, "workspace", "workers"),
  path.join(root, "workspace", "packages"),
];
const internalDirectSources = new Map([
  ["browserDataDO.ts", "product/browser-data"],
  ["evalDO.ts", "product/eval"],
  ["webhookStoreDO.ts", "product/webhook-store"],
  ["workspaceDO.ts", "product/bootstrap"],
]);
const directSource = (file) => {
  if (file.startsWith(path.join(root, "src/server/internalDOs"))) {
    return internalDirectSources.get(path.basename(file)) ?? "product/bootstrap";
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
  const semantic = declaration.match(
    /effect:\s*\{\s*kind:\s*["']semantic["']\s*,\s*capability:\s*["']([^"']+)["']/
  )?.[1];
  if (semantic) return semantic;
  if (/effect:\s*\{\s*kind:\s*["']workspace-service["']/.test(declaration)) {
    return "workspace-service:<live-declaration>";
  }
  if (/effect:\s*\{\s*kind:\s*["']runtime-intrinsic["']/.test(declaration)) {
    return null;
  }
  if (source === "product/browser-data") {
    return sensitivity === "read"
      ? "browser-data.read"
      : sensitivity === "destructive"
        ? "browser-data.delete"
        : "browser-data.write";
  }
  if (source === "product/eval") return "runtime.code-execution.manage";
  if (source === "product/webhook-store") return "webhooks.manage";
  if (source === "product/bootstrap") return "workspace.runtime-state.manage";
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
      capability: directCapability(sourceName, method, sensitivity, match[0]),
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
      parityAssertion:
        "src/server/services/runtimeFoundationLedgers.test.ts#direct-authority-census",
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
      capability: directCapability(sourceName, method, sensitivity, declarationSource),
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
      parityAssertion:
        "src/server/services/runtimeFoundationLedgers.test.ts#direct-authority-census",
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
      capability: directCapability(sourceName, method, sensitivity),
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
      parityAssertion:
        "src/server/services/runtimeFoundationLedgers.test.ts#direct-authority-census",
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
for (const [id, decision] of Object.entries(authorityReview.decisions)) {
  if (!rowsById.has(id)) {
    throw new Error(`Runtime authority review names unknown row ${id}`);
  }
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
}

const evalRuntimeBoundaries = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/eval-runtime-boundaries.json"), "utf8")
);
if (
  evalRuntimeBoundaries.version !== 1 ||
  !Array.isArray(evalRuntimeBoundaries.kernelCapabilities) ||
  evalRuntimeBoundaries.kernelCapabilities.length === 0 ||
  !Array.isArray(evalRuntimeBoundaries.directSurfaceReachability)
) {
  throw new Error("scripts/eval-runtime-boundaries.json has an unsupported schema");
}
const directRows = authorityRows.filter((row) => row.rpcPlane === "workspace-do");
const directSurfaceReachability = {};
for (const group of evalRuntimeBoundaries.directSurfaceReachability) {
  if (
    !group ||
    typeof group.definitionSource !== "string" ||
    !group.definitionSource ||
    !Array.isArray(group.runtimeSources) ||
    group.runtimeSources.length === 0 ||
    !Array.isArray(group.methods) ||
    group.methods.length === 0
  ) {
    throw new Error(`Invalid direct eval surface reachability group ${JSON.stringify(group)}`);
  }
  const runtimeSources = [...new Set(group.runtimeSources)].sort();
  const methods = [...new Set(group.methods)].sort();
  if (
    runtimeSources.length !== group.runtimeSources.length ||
    methods.length !== group.methods.length
  ) {
    throw new Error(`Duplicate direct eval reachability entry ${JSON.stringify(group)}`);
  }
  for (const method of methods) {
    if (
      typeof method !== "string" ||
      !directRows.some((row) => row.source === group.definitionSource && row.method === method)
    ) {
      throw new Error(`Unknown direct eval definition ${group.definitionSource}.${String(method)}`);
    }
  }
  for (const runtimeSource of runtimeSources) {
    if (
      typeof runtimeSource !== "string" ||
      !fs.existsSync(path.join(root, "workspace", runtimeSource, "package.json"))
    ) {
      throw new Error(`Unknown direct eval runtime source ${String(runtimeSource)}`);
    }
    if (runtimeSource === group.definitionSource) {
      throw new Error(`${runtimeSource} redundantly reaches its own direct definitions`);
    }
    const edges = (directSurfaceReachability[runtimeSource] ??= []);
    for (const method of methods) {
      const edge = { source: group.definitionSource, method };
      if (edges.some((existing) => existing.source === edge.source && existing.method === method)) {
        throw new Error(
          `Duplicate direct eval reachability for ${runtimeSource} -> ${edge.source}.${method}`
        );
      }
      edges.push(edge);
    }
    edges.sort((left, right) =>
      `${left.source}:${left.method}`.localeCompare(`${right.source}:${right.method}`)
    );
  }
}
const sortedDirectSurfaceReachability = Object.fromEntries(
  Object.entries(directSurfaceReachability).sort(([left], [right]) => left.localeCompare(right))
);
const workspaceManifest = YAML.parse(
  fs.readFileSync(path.join(root, "workspace", "meta", "vibestudio.yml"), "utf8")
);
const workspaceServices = [...(workspaceManifest.services ?? []), ...PRODUCT_WORKSPACE_SERVICES]
  .map((service) => ({
    name: service.name,
    principals: service.authority?.principals,
  }))
  .filter((service) => typeof service.name === "string" && service.name.length > 0)
  .sort((left, right) => left.name.localeCompare(right.name));
const duplicateWorkspaceServiceNames = workspaceServices
  .filter(
    (service, index) => workspaceServices.findIndex((row) => row.name === service.name) !== index
  )
  .map((service) => service.name);
if (duplicateWorkspaceServiceNames.length > 0) {
  throw new Error(
    `Workspace-authored services collide with product services: ${[
      ...new Set(duplicateWorkspaceServiceNames),
    ].join(", ")}`
  );
}
for (const service of workspaceServices) {
  if (!Array.isArray(service.principals) || service.principals.length === 0) {
    throw new Error(`Workspace service ${service.name} has no compositional authority principals`);
  }
}
const workspaceServiceEvalRows = workspaceServices.map((service) => ({
  id: `workspace-service:${service.name}`,
  capability: `workspace-service:${service.name}`,
  rpcPlane: "workspace-service",
  authorityPrincipals: service.principals,
}));
const invocationSubjects = [
  ...authorityRows
    .filter((row) => !row.capabilitySelector)
    .map((row) =>
      Object.assign(row, {
        capability:
          row.capability ??
          (row.rpcPlane === "host-service"
            ? `service:${row.owner}.${row.method}`
            : `rpc:${row.method}`),
      })
    ),
  ...workspaceServiceEvalRows,
];

const executionRows = [
  [
    "runtime.createEntity",
    "head/state/artifact",
    "surface-adapter",
    "src/server/services/runtimeService.test.ts",
  ],
  [
    "ensureDurableObjectEntity",
    "head/state/artifact",
    "next-request",
    "src/server/universalDoHost.test.ts",
  ],
  [
    "workerd.startWorker",
    "head/state/artifact",
    "next-request",
    "src/server/workerdManager.test.ts",
  ],
  ["worker-push-rebuild", "matching-head", "next-request", "src/server/workerdManager.test.ts"],
  [
    "durable-object-push-rebuild",
    "matching-head",
    "next-request",
    "src/server/dynamicWorkerHost.test.ts",
  ],
  [
    "eval-do",
    "exact-product-seed",
    "new-eval-incarnation",
    "src/server/services/evalService.test.ts",
  ],
  [
    "vcs-store",
    "exact-product-seed",
    "bootstrap-manifest",
    "src/server/internalDOs/workspaceDO.test.ts",
  ],
  [
    "agent-spawn",
    "resolved-exact-artifact",
    "launch",
    "workspace/packages/agentic-do/src/agent-loop-driver.test.ts",
  ],
  [
    "panel",
    "selected-source-ref",
    "explicit-reload-or-navigation",
    "src/server/panelRuntimeRegistration.ts",
  ],
  ["electron-app", "resolved-exact-artifact", "load-update", "src/server/appHost.test.ts"],
  ["react-native-app", "resolved-exact-artifact", "mobile-install", "src/server/appHost.test.ts"],
  [
    "terminal-app",
    "resolved-exact-artifact",
    "process-restart",
    "src/server/terminalAppRunner.test.ts",
  ],
  [
    "extension",
    "resolved-exact-artifact",
    "supervised-restart",
    "packages/extension-host/src/service.test.ts",
  ],
  [
    "dev-host-current-client",
    "exact-context-snapshot",
    "validated-client-ready",
    "src/server/services/devHostService.test.ts",
  ],
  [
    "dev-host-isolated",
    "exact-context-snapshot",
    "candidate-promotion",
    "workspace/extensions/dev-host/lifecycle.test.ts",
  ],
  [
    "claude-code",
    "host-plugin-plus-context-state",
    "managed-process-launch",
    "workspace/extensions/claude-code/index.test.ts",
  ],
].map(([surface, selector, adoption, assertion]) => ({
  surface,
  selector,
  executableIdentity: "full-execution-digest",
  adoption,
  rollback: "last-good-remains-authoritative",
  inFlightWork: "preserved-until-surface-boundary",
  durableStorage: "stable-logical-entity-namespace",
  visibleProgress: "surface-specific-existing-loading-or-status",
  provenance: ["source-state", "recipe", "build-key", "artifact-digest", "execution-digest"],
  parityAssertion: assertion,
}));

const channelRows = [
  [
    "creation",
    "explicit atomic structure; subscribe cannot create",
    "workspace/workers/pubsub-channel/channel-do.test.ts",
  ],
  [
    "first-subscribe",
    "admission only; never freezes structure",
    "workspace/workers/pubsub-channel/channel-do.test.ts",
  ],
  [
    "subsequent-subscribe",
    "live admission policy",
    "workspace/workers/pubsub-channel/channel-do.test.ts",
  ],
  [
    "invitation",
    "discovery metadata for ordinary workspace channels",
    "workspace/workers/pubsub-channel/channel-do.test.ts",
  ],
  [
    "visibility",
    "workspace discovery plus explicit channel policy",
    "workspace/workers/gad-store/gadStore.test.ts",
  ],
  [
    "presence",
    "multi-human presence retained",
    "workspace/workers/pubsub-channel/channel-do.test.ts",
  ],
  [
    "presentation-mutation",
    "immutable structure revision plus authorized presentation revision",
    "workspace/workers/pubsub-channel/channel-do.test.ts",
  ],
  [
    "fork-clone",
    "new structure revision with explicit origin and context rewrite",
    "workspace/workers/pubsub-channel/channel-do.test.ts",
  ],
  [
    "owner-loss",
    "structure retained; explicit administrative recovery",
    "workspace/workers/pubsub-channel/channel-do.test.ts",
  ],
  [
    "deletion",
    "tombstoned and reconnect fails deterministically",
    "workspace/workers/pubsub-channel/channel-do.test.ts",
  ],
  [
    "reconnect",
    "same structure/admission; no authority creation",
    "workspace/packages/pubsub/src/rpc-client.test.ts",
  ],
  [
    "system-agent",
    "exact-principal locked admission expressible without host special case",
    "packages/shared/src/channelStructure.ts",
  ],
].map(([behavior, contract, assertion]) => ({
  behavior,
  contract,
  policyChange: null,
  parityAssertion: assertion,
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
  parityAssertion: "src/server/services/runtimeFoundationLedgers.test.ts#bootstrap-acyclic",
};

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
write("execution-update-ledger.json", { version: 1, rows: executionRows });
write("authority-ledger.json", { version: 1, rows: authorityRows });
write("channel-behavior-ledger.json", { version: 1, rows: channelRows });
write("bootstrap-dependency-graph.json", bootstrap);

const evalSurfaceRows = invocationSubjects.map((row) => ({
  id: row.id,
  rpcPlane: row.rpcPlane,
  capability: row.capability,
  authorityPrincipals: row.authorityPrincipals,
  ...(row.owner ? { owner: row.owner } : {}),
  ...(row.source ? { source: row.source } : {}),
  ...(row.method ? { method: row.method } : {}),
  ...(row.sensitivity ? { sensitivity: row.sensitivity } : {}),
  ...(row.resourceDerivation ? { resourceDerivation: row.resourceDerivation } : {}),
}));
const evalInvocationExposure = [
  ...new Set(
    evalSurfaceRows
      .filter((row) => row.authorityPrincipals?.includes("code") && !row.capability.endsWith("*"))
      .map((row) => row.capability)
  ),
].sort();
const evalServerHostMethods = Object.entries(serverServiceAuthority)
  .flatMap(([service, entry]) => Object.keys(entry.methods).map((method) => ({ service, method })))
  .sort((left, right) =>
    left.service === right.service
      ? left.method.localeCompare(right.method)
      : left.service.localeCompare(right.service)
  );
const evalExposurePath = path.join(
  root,
  "src",
  "server",
  "services",
  "evalInvocationExposure.generated.ts"
);
const evalExposureSource = await formatTypeScript(
  `/* Generated by scripts/generate-runtime-foundation-ledgers.mjs. Admission census only; never a request or grant. */\n\nexport const EVAL_INVOCATION_SURFACE_CENSUS = ${JSON.stringify(evalSurfaceRows, null, 2)} as const;\n\n/** Every reviewed server-host method. Bootstrap verifies that this exact census is registered before accepting RPC. */\nexport const EVAL_SERVER_HOST_METHODS = ${JSON.stringify(evalServerHostMethods, null, 2)} as const;\n\n/** Reviewed runtime sources that may reach exact direct RPC methods defined by another workspace unit. */\nexport const EVAL_DIRECT_SURFACE_REACHABILITY = ${JSON.stringify(sortedDirectSurfaceReachability, null, 2)} as const;\n\nexport const EVAL_INVOCATION_EXPOSURE_CAPABILITIES = ${JSON.stringify(evalInvocationExposure, null, 2)} as const;\n`,
  evalExposurePath
);
if (check) {
  if (fs.readFileSync(evalExposurePath, "utf8") !== evalExposureSource) {
    throw new Error(
      `${path.relative(root, evalExposurePath)} is stale; run pnpm generate:runtime-foundations`
    );
  }
} else {
  fs.writeFileSync(evalExposurePath, evalExposureSource);
}
