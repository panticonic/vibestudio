import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs", "runtime-foundations");
const check = process.argv.includes("--check");
if (!check) fs.mkdirSync(output, { recursive: true });

const serverServiceAuthority = JSON.parse(
  fs.readFileSync(path.join(root, "src/server/services/__serviceAuthorityMatrix.golden.json"), "utf8")
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
    principals: [...new Set([
      ...(existing.service?.principals ?? []),
      ...(entry.service?.principals ?? []),
    ])].sort(),
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
    requirements.push(
      `allOf(capability(entity,${capability}),agent-binding,workspace-member)`
    );
  }
  if (principals.includes("device")) {
    requirements.push(
      `allOf(capability(device,${capability}),device-owned-by-user,workspace-member)`
    );
  }
  const unique = [...new Set(requirements)];
  return unique.length === 1 ? unique[0] : `anyOf(${unique.join(",")})`;
};

const authorityRows = [];
for (const [service, entry] of Object.entries(serviceAuthority).sort(([a], [b]) => a.localeCompare(b))) {
  for (const [method, override] of Object.entries(entry.methods).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const declaration = override?.inherits ? entry.service : override;
    const capability = `service:${service}.${method}`;
    const principals = declaration.principals ?? [];
    authorityRows.push({
      id: `host:${service}.${method}`,
      rpcPlane: "host-service",
      owner: service,
      method,
      resourceDerivation: declaration.resource ?? { kind: "literal", key: capability },
      authorityPrincipals: principals,
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
  }
}

const directRoots = [
  path.join(root, "src", "server", "internalDOs"),
  path.join(root, "workspace", "workers"),
  path.join(root, "workspace", "packages"),
];
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
const rpcPattern = /@rpc\(\{\s*principals:\s*\[([^\]]*)\][\s\S]*?\}\)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
const namedRpcPattern = /@rpc\(([A-Z][A-Z0-9_]*)\)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
for (const file of directRoots.flatMap(walk).sort()) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(rpcPattern)) {
    const principals = [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]).sort();
    const method = match[2];
    const owner = path.relative(root, file).replaceAll(path.sep, "/");
    authorityRows.push({
      id: `direct:${owner}:${method}`,
      rpcPlane: "workspace-do",
      owner,
      method,
      resourceDerivation: { kind: "direct-target", owner },
      authorityPrincipals: principals,
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
      predicates: ["live-owner-service-relationship", "exact-resource-scope", "next-dispatch-revocation"],
      r3aRequirement: principalExpression(principals, `rpc:${method}`),
      r3b: { review: "unchanged-parity", change: null },
      parityAssertion: "src/server/services/runtimeFoundationLedgers.test.ts#direct-authority-census",
    });
  }
  for (const match of source.matchAll(namedRpcPattern)) {
    const declaration = match[1];
    const method = match[2];
    const owner = path.relative(root, file).replaceAll(path.sep, "/");
    authorityRows.push({
      id: `direct:${owner}:${method}`,
      rpcPlane: "workspace-do",
      owner,
      method,
      resourceDerivation: { kind: "direct-target", owner },
      authorityPrincipals: [],
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
      predicates: ["live-owner-service-relationship", "exact-resource-scope", "next-dispatch-revocation"],
      r3aRequirement: `declared:${declaration}`,
      r3b: { review: "unchanged-parity", change: null },
      parityAssertion: "src/server/services/runtimeFoundationLedgers.test.ts#direct-authority-census",
    });
  }
}
authorityRows.sort((a, b) => a.id.localeCompare(b.id));

const executionRows = [
  ["runtime.createEntity", "head/state/artifact", "surface-adapter", "src/server/services/runtimeService.test.ts"],
  ["ensureDurableObjectEntity", "head/state/artifact", "next-request", "src/server/universalDoHost.test.ts"],
  ["workerd.startWorker", "head/state/artifact", "next-request", "src/server/workerdManager.test.ts"],
  ["worker-push-rebuild", "matching-head", "next-request", "src/server/workerdManager.test.ts"],
  ["durable-object-push-rebuild", "matching-head", "next-request", "src/server/dynamicWorkerHost.test.ts"],
  ["eval-do", "exact-product-seed", "new-eval-incarnation", "src/server/services/evalService.test.ts"],
  ["vcs-store", "exact-product-seed", "bootstrap-manifest", "src/server/internalDOs/workspaceDO.test.ts"],
  ["agent-spawn", "resolved-exact-artifact", "launch", "workspace/packages/agentic-do/src/agent-loop-driver.test.ts"],
  ["panel", "selected-source-ref", "explicit-reload-or-navigation", "src/server/panelRuntimeRegistration.ts"],
  ["electron-app", "resolved-exact-artifact", "load-update", "src/server/appHost.test.ts"],
  ["react-native-app", "resolved-exact-artifact", "mobile-install", "src/server/appHost.test.ts"],
  ["terminal-app", "resolved-exact-artifact", "process-restart", "src/server/terminalAppRunner.test.ts"],
  ["extension", "resolved-exact-artifact", "supervised-restart", "packages/extension-host/src/service.test.ts"],
  ["dev-host-current-client", "exact-context-snapshot", "validated-client-ready", "src/server/services/devHostService.test.ts"],
  ["dev-host-isolated", "exact-context-snapshot", "candidate-promotion", "workspace/extensions/dev-host/lifecycle.test.ts"],
  ["claude-code", "host-plugin-plus-context-state", "managed-process-launch", "workspace/extensions/claude-code/index.test.ts"],
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
  ["creation", "explicit atomic structure; subscribe cannot create", "workspace/workers/pubsub-channel/channel-do.test.ts"],
  ["first-subscribe", "admission only; never freezes structure", "workspace/workers/pubsub-channel/channel-do.test.ts"],
  ["subsequent-subscribe", "live admission policy", "workspace/workers/pubsub-channel/channel-do.test.ts"],
  ["invitation", "discovery metadata for ordinary workspace channels", "workspace/workers/pubsub-channel/channel-do.test.ts"],
  ["visibility", "workspace discovery plus explicit channel policy", "workspace/workers/gad-store/gadStore.test.ts"],
  ["presence", "multi-human presence retained", "workspace/workers/pubsub-channel/channel-do.test.ts"],
  ["presentation-mutation", "immutable structure revision plus authorized presentation revision", "workspace/workers/pubsub-channel/channel-do.test.ts"],
  ["fork-clone", "new structure revision with explicit origin and context rewrite", "workspace/workers/pubsub-channel/channel-do.test.ts"],
  ["owner-loss", "structure retained; explicit administrative recovery", "workspace/workers/pubsub-channel/channel-do.test.ts"],
  ["deletion", "tombstoned and reconnect fails deterministically", "workspace/workers/pubsub-channel/channel-do.test.ts"],
  ["reconnect", "same structure/admission; no authority creation", "workspace/packages/pubsub/src/rpc-client.test.ts"],
  ["system-agent", "exact-principal locked admission expressible without host special case", "packages/shared/src/channelStructure.ts"],
].map(([behavior, contract, assertion]) => ({ behavior, contract, policyChange: null, parityAssertion: assertion }));

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
      throw new Error(`${path.relative(root, target)} is stale; run pnpm generate:runtime-foundations`);
    }
    return;
  }
  fs.writeFileSync(target, expected);
};
write("execution-update-ledger.json", { version: 1, rows: executionRows });
write("authority-ledger.json", { version: 1, rows: authorityRows });
write("channel-behavior-ledger.json", { version: 1, rows: channelRows });
write("bootstrap-dependency-graph.json", bootstrap);

const directCapabilities = [...new Set(
  authorityRows
    .filter((row) => row.rpcPlane === "workspace-do")
    .map((row) => `rpc:${row.method}`)
)].sort();
const directCapabilitiesSource = `/* Generated by scripts/generate-runtime-foundation-ledgers.mjs. */\n\nexport const PRODUCT_DIRECT_AUTHORITY_CAPABILITIES = ${JSON.stringify(directCapabilities, null, 2)} as const;\n`;
const directCapabilitiesPath = path.join(
  root,
  "src",
  "server",
  "services",
  "productDirectAuthorityCapabilities.generated.ts"
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
  const source = path.relative(path.join(root, "workspace"), path.dirname(file)).replaceAll(path.sep, "/");
  const capabilities = [...new Set(requests.map((request) => request.capability))].sort();
  for (const capability of capabilities) {
    if (capability.endsWith("*")) {
      throw new Error(`${source} retains wildcard authority request ${capability}`);
    }
  }
  codeCapabilitiesBySource[source] = capabilities;
}

const productCodeCapabilities = authorityRows
  .filter((row) => row.authorityPrincipals.includes("code"))
  .map((row) => row.rpcPlane === "host-service" ? `service:${row.owner}.${row.method}` : `rpc:${row.method}`);
const productUserlandCapabilities = [
  "userland-service:gad.workspace",
  "userland-service:vcs",
  "userland-service:channel",
  "userland-service:models",
  "userland-service:testkit-driver",
];
for (const source of ["product/bootstrap", "product/eval", "product/browser-data", "product/webhook-store"]) {
  codeCapabilitiesBySource[source] = [...new Set([
    ...productCodeCapabilities,
    ...productUserlandCapabilities,
  ])].sort();
}

const principalCapabilities = {};
for (const principal of ["host", "user", "device", "entity"]) {
  principalCapabilities[principal] = [...new Set(
    authorityRows
      .filter((row) => row.authorityPrincipals.includes(principal))
      .map((row) => row.rpcPlane === "host-service" ? `service:${row.owner}.${row.method}` : `rpc:${row.method}`)
  )].sort();
}
const productCatalogSource = `/* Generated by scripts/generate-runtime-foundation-ledgers.mjs. Reviewed exact-source product grants. */\n\nexport const PRODUCT_AUTHORITY_GRANT_CATALOG = ${JSON.stringify({
  version: 2,
  principalCapabilities,
  codeCapabilitiesBySource,
}, null, 2)} as const;\n`;
const productCatalogPath = path.join(
  root,
  "src",
  "server",
  "services",
  "productAuthorityGrantCatalog.generated.ts"
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
