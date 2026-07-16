import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import YAML from "yaml";

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
        evalAcquisition: additional.evalAcquisition,
      });
    }
    for (const leaf of declaration.prepared?.leaves ?? []) {
      authorityRows.push({
        id: `host:${service}.${method}#${leaf.capability}`,
        rpcPlane: "host-service",
        owner: service,
        method,
        capability: leaf.capability,
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
        evalAcquisition: leaf.evalAcquisition,
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
for (const file of directRoots.flatMap(walk).sort()) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(rpcPattern)) {
    const principals = [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]).sort();
    const method = match[2];
    const owner = path.relative(root, file).replaceAll(path.sep, "/");
    const sensitivity = match[0].match(
      /sensitivity:\s*["'](read|write|admin|destructive)["']/
    )?.[1];
    if (principals.includes("code") && !sensitivity) {
      throw new Error(`${owner}:${method} admits code but has no reviewed sensitivity`);
    }
    authorityRows.push({
      id: `direct:${owner}:${method}`,
      rpcPlane: "workspace-do",
      owner,
      source: directSource(file),
      method,
      resourceDerivation: { kind: "direct-target", owner },
      authorityPrincipals: principals,
      sensitivity: sensitivity ?? "unknown",
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
    const principals = [...declarationSource.matchAll(/methodCapability\(["']([^"']+)["']\)/g)]
      .map((item) => item[1])
      .sort();
    if (!sensitivity) {
      throw new Error(`${owner}:${method} uses ${declaration} without a reviewed sensitivity`);
    }
    authorityRows.push({
      id: `direct:${owner}:${method}`,
      rpcPlane: "workspace-do",
      owner,
      source: directSource(file),
      method,
      resourceDerivation: { kind: "direct-target", owner },
      authorityPrincipals: principals,
      sensitivity,
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
}
authorityRows.sort((a, b) => a.id.localeCompare(b.id));

const evalAcquisitionPolicy = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/eval-capability-acquisition.json"), "utf8")
);
if (
  evalAcquisitionPolicy.version !== 2 ||
  !evalAcquisitionPolicy.rows ||
  !Array.isArray(evalAcquisitionPolicy.kernelCapabilities) ||
  evalAcquisitionPolicy.kernelCapabilities.length === 0 ||
  !Array.isArray(evalAcquisitionPolicy.additionalLeaves) ||
  !Array.isArray(evalAcquisitionPolicy.directSurfaceReachability)
) {
  throw new Error("scripts/eval-capability-acquisition.json has an unsupported schema");
}
const directRows = authorityRows.filter((row) => row.rpcPlane === "workspace-do");
const directSurfaceReachability = {};
for (const group of evalAcquisitionPolicy.directSurfaceReachability) {
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
const userlandServiceNames = (workspaceManifest.services ?? [])
  .map((service) => service.name)
  .filter((name) => typeof name === "string" && name.length > 0)
  .sort();
const userlandEvalRows = userlandServiceNames.map((name) => ({
  id: `userland:${name}`,
  capability: `userland-service:${name}`,
  rpcPlane: "userland-service",
  authorityPrincipals: ["code"],
}));
const acquisitionSubjects = [
  ...authorityRows.map((row) =>
    Object.assign(row, {
      capability:
        row.capability ??
        (row.rpcPlane === "host-service"
          ? `service:${row.owner}.${row.method}`
          : `rpc:${row.method}`),
    })
  ),
  ...userlandEvalRows,
  ...evalAcquisitionPolicy.additionalLeaves.map((leaf) => ({
    ...leaf,
    evalAcquisition: leaf.acquisition,
  })),
];
const requiredAcquisitionIds = new Set(
  acquisitionSubjects.filter((row) => row.evalAcquisition === undefined).map((row) => row.id)
);
const configuredAcquisitionIds = new Set(Object.keys(evalAcquisitionPolicy.rows));
const missingAcquisition = [...requiredAcquisitionIds].filter(
  (id) => !configuredAcquisitionIds.has(id)
);
const staleAcquisition = [...configuredAcquisitionIds].filter(
  (id) => !requiredAcquisitionIds.has(id)
);
if (missingAcquisition.length || staleAcquisition.length) {
  throw new Error(
    [
      missingAcquisition.length
        ? `Unclassified eval capability leaves: ${missingAcquisition.join(", ")}`
        : "",
      staleAcquisition.length ? `Stale eval capability leaves: ${staleAcquisition.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
}
for (const row of acquisitionSubjects) {
  const acquisition = row.evalAcquisition ?? evalAcquisitionPolicy.rows[row.id];
  if (!["baseline", "approval", "closed"].includes(acquisition.kind)) {
    throw new Error(`Invalid eval acquisition for ${row.id}: ${JSON.stringify(acquisition)}`);
  }
  const codeAdmitted = row.authorityPrincipals.includes("code");
  if (!codeAdmitted && acquisition.kind !== "closed") {
    throw new Error(`${row.id} does not admit code and must be eval-closed`);
  }
  if (acquisition.kind === "closed" && !acquisition.reason) {
    throw new Error(`${row.id} is eval-closed without a reason`);
  }
  if (
    acquisition.kind === "approval" &&
    (!acquisition.title ||
      !acquisition.description ||
      !acquisition.operation?.kind ||
      !acquisition.operation?.verb ||
      !Array.isArray(acquisition.grantScopes) ||
      acquisition.grantScopes.some((scope) => !["run", "session", "version"].includes(scope)))
  ) {
    throw new Error(`${row.id} has an incomplete eval approval declaration`);
  }
  row.evalAcquisition = acquisition;
}
for (const [capability, rows] of Map.groupBy(acquisitionSubjects, (row) => row.capability)) {
  const kinds = new Set(rows.map((row) => row.evalAcquisition.kind));
  if (rows.some((row) => row.rpcPlane === "workspace-do") && kinds.size > 1) {
    throw new Error(
      `Direct eval capability ${capability} has inconsistent acquisition: ${rows
        .map((row) => `${row.id}=${row.evalAcquisition.kind}`)
        .join(", ")}`
    );
  }
}
const evalBaselineCapabilities = [
  ...new Set(
    acquisitionSubjects
      .filter(
        (row) =>
          row.authorityPrincipals.includes("code") &&
          row.evalAcquisition.kind === "baseline" &&
          !row.capability.endsWith("*")
      )
      .map((row) => row.capability)
  ),
].sort();

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

const directCapabilities = [
  ...new Set(
    authorityRows.filter((row) => row.rpcPlane === "workspace-do").map((row) => `rpc:${row.method}`)
  ),
].sort();
const directCapabilitiesPath = path.join(
  root,
  "src",
  "server",
  "services",
  "productDirectAuthorityCapabilities.generated.ts"
);
const directCapabilitiesSource = await formatTypeScript(
  `/* Generated by scripts/generate-runtime-foundation-ledgers.mjs. */\n\nexport const PRODUCT_DIRECT_AUTHORITY_CAPABILITIES = ${JSON.stringify(directCapabilities, null, 2)} as const;\n`,
  directCapabilitiesPath
);
if (check) {
  if (fs.readFileSync(directCapabilitiesPath, "utf8") !== directCapabilitiesSource) {
    throw new Error(
      `${path.relative(root, directCapabilitiesPath)} is stale; run pnpm generate:runtime-foundations`
    );
  }
} else {
  fs.writeFileSync(directCapabilitiesPath, directCapabilitiesSource);
}

// `walk` above intentionally selects TypeScript for the direct-RPC census.
// Package manifests need their own traversal.
const manifestFiles = [];
const walkManifests = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkManifests(absolute);
    else if (entry.name === "package.json") manifestFiles.push(absolute);
  }
};
walkManifests(path.join(root, "workspace"));

const codeCapabilitiesBySource = {};
for (const file of manifestFiles.sort()) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const requests = manifest.vibestudio?.authority?.requests;
  if (!requests) continue;
  const source = path
    .relative(path.join(root, "workspace"), path.dirname(file))
    .replaceAll(path.sep, "/");
  const capabilities = [
    ...new Set([
      ...requests.map((request) => request.capability),
      // A delegation declaration is not itself a grant. First-class product
      // agents receive the reviewed baseline portion as an explicit product seed
      // so dynamic eval works without prompting, while approval leaves remain
      // absent until the user grants them.
      ...(manifest.vibestudio?.agent ? evalBaselineCapabilities : []),
    ]),
  ].sort();
  for (const capability of capabilities) {
    if (capability.endsWith("*")) {
      throw new Error(`${source} retains wildcard authority request ${capability}`);
    }
  }
  codeCapabilitiesBySource[source] = capabilities;
}
codeCapabilitiesBySource["product/eval"] = [...evalAcquisitionPolicy.kernelCapabilities].sort();

const productCodeCapabilities = authorityRows
  .filter(
    (row) => row.authorityPrincipals.includes("code") && row.evalAcquisition.kind !== "closed"
  )
  .map(
    (row) =>
      row.capability ??
      (row.rpcPlane === "host-service" ? `service:${row.owner}.${row.method}` : `rpc:${row.method}`)
  )
  .filter((capability) => !capability.endsWith("*"));
const productUserlandCapabilities = userlandServiceNames.map((name) => `userland-service:${name}`);
for (const source of ["product/bootstrap", "product/browser-data", "product/webhook-store"]) {
  codeCapabilitiesBySource[source] = [
    ...new Set([...productCodeCapabilities, ...productUserlandCapabilities]),
  ].sort();
}

const evalAcquisitionRows = acquisitionSubjects.map((row) => ({
  id: row.id,
  rpcPlane: row.rpcPlane,
  capability: row.capability,
  ...(row.owner ? { owner: row.owner } : {}),
  ...(row.source ? { source: row.source } : {}),
  ...(row.method ? { method: row.method } : {}),
  ...(row.sensitivity ? { sensitivity: row.sensitivity } : {}),
  ...(row.resourceDerivation ? { resourceDerivation: row.resourceDerivation } : {}),
  acquisition: row.evalAcquisition,
}));
const evalInvocationExposure = [
  ...new Set(
    evalAcquisitionRows
      .filter((row) => row.acquisition.kind !== "closed" && !row.capability.endsWith("*"))
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
  `/* Generated by scripts/generate-runtime-foundation-ledgers.mjs. This is an exposure ceiling, never a grant. */\n\nexport const EVAL_CAPABILITY_ACQUISITION_LEDGER = ${JSON.stringify(evalAcquisitionRows, null, 2)} as const;\n\n/** Every reviewed server-host method. Bootstrap verifies that this exact census is registered before accepting RPC. */\nexport const EVAL_SERVER_HOST_METHODS = ${JSON.stringify(evalServerHostMethods, null, 2)} as const;\n\n/** Reviewed runtime sources that may reach exact direct RPC methods defined by another workspace unit. */\nexport const EVAL_DIRECT_SURFACE_REACHABILITY = ${JSON.stringify(sortedDirectSurfaceReachability, null, 2)} as const;\n\nexport const EVAL_INVOCATION_EXPOSURE_CAPABILITIES = ${JSON.stringify(evalInvocationExposure, null, 2)} as const;\n`,
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

const principalCapabilities = {};
for (const principal of ["host", "user", "device", "entity"]) {
  principalCapabilities[principal] = [
    ...new Set(
      authorityRows
        .filter((row) => row.authorityPrincipals.includes(principal))
        .map(
          (row) =>
            row.capability ??
            (row.rpcPlane === "host-service"
              ? `service:${row.owner}.${row.method}`
              : `rpc:${row.method}`)
        )
        .filter((capability) => !capability.endsWith("*"))
    ),
  ].sort();
}
const productCatalogPath = path.join(
  root,
  "src",
  "server",
  "services",
  "productAuthorityGrantCatalog.generated.ts"
);
const productCatalogSource = await formatTypeScript(
  `/* Generated by scripts/generate-runtime-foundation-ledgers.mjs. Reviewed exact-source product grants. */\n\nexport const PRODUCT_AUTHORITY_GRANT_CATALOG = ${JSON.stringify(
    {
      version: 2,
      principalCapabilities,
      codeCapabilitiesBySource,
    },
    null,
    2
  )} as const;\n`,
  productCatalogPath
);
if (check) {
  if (fs.readFileSync(productCatalogPath, "utf8") !== productCatalogSource) {
    throw new Error(
      `${path.relative(root, productCatalogPath)} is stale; run pnpm generate:runtime-foundations`
    );
  }
} else {
  fs.writeFileSync(productCatalogPath, productCatalogSource);
}
