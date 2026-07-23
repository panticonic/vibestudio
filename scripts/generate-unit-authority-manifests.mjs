import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import ts from "typescript";
import { PRODUCT_WORKSPACE_SERVICES } from "../packages/shared/src/productWorkspaceServices.mjs";
import {
  declaredMethodCapabilityDependencies,
  expandCapabilityDependencies,
  inferEventsClientCapabilities,
  inferExtensionContextCapabilities,
  inferHostedRuntimeCapabilities,
  inferTypedServiceClientCapabilities,
  inferTypedWorkspaceEffects,
  inferWorkspacePackageReferences,
} from "./lib/unit-authority-inference.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.join(root, "workspace");
const methodTiers = loadReviewedMethodTiers(
  path.join(root, "packages/shared/src/authority/tierTable.ts")
);
const methodCapabilities = loadReviewedMethodCapabilities(
  path.join(root, "packages/shared/src/authority/hostMethodCapabilities.ts")
);
const serverMatrix = JSON.parse(
  fs.readFileSync(
    path.join(root, "src/server/services/__serviceAuthorityMatrix.golden.json"),
    "utf8"
  )
);
const mainMatrix = JSON.parse(
  fs.readFileSync(path.join(root, "src/main/services/__serviceAuthorityMatrix.golden.json"), "utf8")
);
const matrix = { ...serverMatrix, ...mainMatrix };
for (const [service, entry] of Object.entries(serverMatrix)) {
  if (mainMatrix[service]) {
    matrix[service] = {
      service: entry.service,
      methods: { ...entry.methods, ...mainMatrix[service].methods },
    };
  }
}
const authorityLedger = JSON.parse(
  fs.readFileSync(path.join(root, "docs/runtime-foundations/authority-ledger.json"), "utf8")
);
const capabilityTiers = new Map();
const recordCapabilityTier = (capability, tier, source) => {
  if (!["open", "gated", "critical"].includes(tier)) {
    throw new Error(`${source} has no reviewed capability tier`);
  }
  if (tier === "open") return;
  const existing = capabilityTiers.get(capability);
  // A semantic capability may cover gated and critical wire operations that
  // express one user intent (for example, configure/delete provider settings).
  // The manifest advertises the strongest possible effect; the exact method's
  // reviewed tier still controls each invocation at runtime.
  capabilityTiers.set(
    capability,
    existing === "critical" || tier === "critical" ? "critical" : "gated"
  );
};
const strongestPreparedTier = (tier, source) => {
  if (typeof tier === "string") return tier;
  if (
    tier &&
    typeof tier === "object" &&
    Array.isArray(tier.selectedFrom) &&
    tier.selectedFrom.length > 0 &&
    tier.selectedFrom.every((candidate) => ["open", "gated", "critical"].includes(candidate))
  ) {
    return tier.selectedFrom.includes("critical")
      ? "critical"
      : tier.selectedFrom.includes("gated")
        ? "gated"
        : "open";
  }
  throw new Error(`${source} has no reviewed literal or bounded dynamic tier`);
};
for (const [method, capability] of methodCapabilities) {
  recordCapabilityTier(capability, methodTiers.get(method), method);
}
for (const [serviceName, service] of Object.entries(matrix)) {
  for (const [methodName, method] of Object.entries(service.methods)) {
    for (const leaf of method.authority?.prepared?.leaves ?? []) {
      if (typeof leaf.capability !== "string" || leaf.capability.length === 0) {
        throw new Error(
          `${serviceName}.${methodName} has a prepared authority leaf without a semantic capability`
        );
      }
      recordCapabilityTier(
        leaf.capability,
        strongestPreparedTier(
          leaf.tier ?? methodTiers.get(`${serviceName}.${methodName}`),
          `${serviceName}.${methodName} prepared ${leaf.capability} leaf`
        ),
        `${serviceName}.${methodName} prepared ${leaf.capability} leaf`
      );
    }
  }
}
for (const row of authorityLedger.rows) {
  if (row.rpcPlane === "workspace-do" && row.capability) {
    recordCapabilityTier(row.capability, row.tier, `${row.owner}:${row.method}`);
  }
}
for (const capability of [
  "context.boundary",
  "clipboard",
  "external-browser-open",
  "external-network-fetch",
  "incoming-pair-links",
  "internal-model-runtime.use",
  "keychain",
  "native-menus",
  "notifications",
  "open-external",
  "panel-hosting",
  "window-management",
  "workspace-main-advance",
  "workspace-repo-delete",
])
  recordCapabilityTier(capability, "gated", "reviewed intrinsic capability");

function reviewedCapabilityTier(capability) {
  if (capability.startsWith("workspace-service:")) return "gated";
  const tier = capabilityTiers.get(capability);
  if (!tier) throw new Error(`Capability ${capability} has no reviewed manifest tier`);
  return tier;
}

function evidenceForResource(resource) {
  if (resource?.kind === "exact") return "exact";
  if (resource?.kind === "prefix" && resource.prefix !== "") return "bounded-dynamic";
  if (resource?.kind === "origin" || resource?.kind === "domain") return "bounded-dynamic";
  return "intentional-broad";
}

function normalizeManifestEntry(entry) {
  return {
    capability: entry.capability,
    resource: entry.resource,
    tier: reviewedCapabilityTier(entry.capability),
    evidence: evidenceForResource(entry.resource),
    ...(Array.isArray(entry.packages) ? { packages: [...new Set(entry.packages)].sort() } : {}),
  };
}
const workspaceManifest = YAML.parse(
  fs.readFileSync(path.join(workspaceRoot, "meta/vibestudio.yml"), "utf8")
);
const userlandServiceByProtocol = new Map(
  [...(workspaceManifest.services ?? []), ...PRODUCT_WORKSPACE_SERVICES].flatMap((service) =>
    (service.protocols ?? []).map((protocol) => [protocol, service.name])
  )
);

const serviceMethods = new Map(
  Object.entries(matrix).map(([service, entry]) => [service, Object.keys(entry.methods)])
);
const hostCapabilities = new Set(
  [...serviceMethods].flatMap(([service, methods]) =>
    methods.map((method) => `service:${service}.${method}`)
  )
);
const methodCapabilityDependencies = declaredMethodCapabilityDependencies(matrix);
const directCapabilityMap = new Map();
for (const row of authorityLedger.rows.filter(
  (candidate) => candidate.rpcPlane === "workspace-do" && candidate.tier !== "open"
)) {
  if (typeof row.capability !== "string" || row.capability.startsWith("rpc:")) {
    throw new Error(`${row.owner}:${row.method} has no semantic direct capability`);
  }
  const transport = `rpc:${row.method}`;
  const existing = directCapabilityMap.get(transport);
  if (existing && existing !== row.capability) {
    throw new Error(`${transport} aliases multiple semantic direct capabilities`);
  }
  directCapabilityMap.set(transport, row.capability);
}
const evalCeilingCapabilities = [
  ...new Set([
    ...authorityLedger.rows
      .filter(
        (row) =>
          row.authorityPrincipals.includes("code") &&
          !(row.rpcPlane === "workspace-do" && row.tier === "open")
      )
      .map(
        (row) =>
          row.capability ??
          (row.rpcPlane === "host-service"
            ? `service:${row.owner}.${row.method}`
            : `rpc:${row.method}`)
      )
      .map(toManifestCapability)
      .filter((capability) => capability !== null && !capability.endsWith("*")),
    // Agentic eval is intentionally able to encounter services authored after
    // this checkout was built. This is a reachability ceiling, never a grant:
    // the live declaration, exact provider EV, session/mission envelope, and
    // acquisition decision are still checked for every resolved service.
    // Enumerating today's workspace services here would turn a dynamic
    // semantic-context feature into a static source-census dependency.
    "workspace-service:*",
  ]),
].sort();

/**
 * Read the reviewed TypeScript tier table as data without executing repository
 * source. The table remains the authority input; this checker merely consumes
 * its string-literal decisions and fails closed on any shape it cannot prove.
 */
function loadReviewedMethodTiers(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let initializer;
  const unwrap = (node) => {
    let current = node;
    while (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const visit = (node) => {
    const value =
      ts.isVariableDeclaration(node) && node.initializer ? unwrap(node.initializer) : undefined;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "METHOD_TIERS" &&
      value &&
      ts.isObjectLiteralExpression(value)
    ) {
      initializer = value;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!initializer) throw new Error("METHOD_TIERS must be a literal reviewed table");

  const result = new Map();
  for (const decision of initializer.properties) {
    if (!ts.isPropertyAssignment(decision) || !ts.isStringLiteralLike(decision.name)) {
      throw new Error("METHOD_TIERS contains a non-literal method decision");
    }
    if (!ts.isObjectLiteralExpression(decision.initializer)) {
      throw new Error(`METHOD_TIERS.${decision.name.text} must be a literal decision`);
    }
    const tierProperty = decision.initializer.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "tier"
    );
    if (
      !tierProperty ||
      !ts.isPropertyAssignment(tierProperty) ||
      !ts.isStringLiteralLike(tierProperty.initializer) ||
      !["open", "gated", "critical"].includes(tierProperty.initializer.text)
    ) {
      throw new Error(`METHOD_TIERS.${decision.name.text} has no literal reviewed tier`);
    }
    result.set(decision.name.text, tierProperty.initializer.text);
  }
  return result;
}

function loadReviewedMethodCapabilities(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const unwrap = (node) => {
    let current = node;
    while (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    )
      current = current.expression;
    return current;
  };
  let initializer;
  const visit = (node) => {
    const value =
      ts.isVariableDeclaration(node) && node.initializer ? unwrap(node.initializer) : undefined;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "GROUPS" &&
      value &&
      ts.isObjectLiteralExpression(value)
    )
      initializer = value;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!initializer) throw new Error("Host semantic capability GROUPS must be a literal table");
  const result = new Map();
  for (const group of initializer.properties) {
    if (
      !ts.isPropertyAssignment(group) ||
      !ts.isStringLiteralLike(group.name) ||
      !ts.isArrayLiteralExpression(group.initializer)
    )
      throw new Error("Host semantic capability GROUPS contains a non-literal entry");
    for (const methodNode of group.initializer.elements) {
      if (!ts.isStringLiteralLike(methodNode)) {
        throw new Error(`Host semantic capability ${group.name.text} has a non-literal method`);
      }
      if (result.has(methodNode.text)) {
        throw new Error(`Host method ${methodNode.text} has multiple semantic capabilities`);
      }
      result.set(methodNode.text, group.name.text);
    }
  }
  return result;
}

function toManifestCapability(capability) {
  if (capability.startsWith("rpc:")) {
    const semantic = directCapabilityMap.get(capability);
    if (!semantic)
      throw new Error(`Direct capability ${capability} has no reviewed semantic effect`);
    return semantic;
  }
  if (!capability.startsWith("service:")) return capability;
  const method = capability.slice("service:".length);
  const tier = methodTiers.get(method);
  if (!tier) throw new Error(`Host capability ${capability} has no reviewed tier`);
  if (tier === "open") return null;
  const semantic = methodCapabilities.get(method);
  if (!semantic) throw new Error(`Host method ${method} has no reviewed semantic capability`);
  return semantic;
}

function requiresManifestRequest(capability) {
  if (capability === null) return false;
  if (capability.startsWith("service:")) {
    throw new Error(`Transport capability survived semantic conversion: ${capability}`);
  }
  if (capability.startsWith("rpc:")) {
    throw new Error(`Transport capability survived semantic conversion: ${capability}`);
  }
  return true;
}

const packageFiles = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.name === "package.json") packageFiles.push(absolute);
  }
};
walk(workspaceRoot);

const packages = new Map();
for (const file of packageFiles) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof manifest.name === "string") {
    packages.set(manifest.name, { file, directory: path.dirname(file), manifest });
  }
}

const EXECUTABLE_UNIT_ROOTS = new Set(["about", "apps", "extensions", "panels", "workers"]);

/**
 * Authority is part of every executable artifact's source contract. Requiring
 * an existing `vibestudio.authority` block made generation opt-in and allowed
 * newly added product code to execute with an empty sealed request set. The
 * workspace taxonomy is the source of truth for which package roots are
 * executable; libraries and skills do not receive runtime authority manifests.
 */
function isExecutableUnitPackage(pkg) {
  const relativeDirectory = path.relative(workspaceRoot, pkg.directory).replaceAll(path.sep, "/");
  const [rootName, unitName, ...rest] = relativeDirectory.split("/");
  return (
    EXECUTABLE_UNIT_ROOTS.has(rootName) &&
    typeof unitName === "string" &&
    unitName.length > 0 &&
    rest.length === 0 &&
    pkg.manifest.vibestudio !== undefined
  );
}

function productionSource(directory) {
  const chunks = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (
        /\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name) &&
        !/\.(?:test|spec|stories)\./.test(entry.name)
      ) {
        chunks.push(fs.readFileSync(absolute, "utf8"));
      }
    }
  };
  visit(directory);
  return chunks.join("\n");
}

const SOURCE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
];

function resolveSourceModule(candidate) {
  for (const suffix of SOURCE_SUFFIXES) {
    const file = `${candidate}${suffix}`;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  if (/\.js$/.test(candidate)) {
    for (const replacement of [
      candidate.replace(/\.js$/, ".ts"),
      candidate.replace(/\.js$/, ".tsx"),
    ]) {
      if (fs.existsSync(replacement)) return replacement;
    }
  }
  return null;
}

function packageEntry(pkg, subpath = ".") {
  const exports = pkg.manifest.exports;
  const exported =
    typeof exports === "string"
      ? subpath === "."
        ? exports
        : null
      : exports && typeof exports === "object"
        ? exports[subpath]
        : null;
  const exportPath =
    typeof exported === "string"
      ? exported
      : exported && typeof exported === "object"
        ? (exported.import ?? exported.default ?? null)
        : null;
  const configured =
    exportPath ??
    (subpath !== "."
      ? subpath.slice(2)
      : (pkg.manifest.vibestudio?.entry ??
        pkg.manifest.vibestudio?.app?.renderer ??
        pkg.manifest.vibestudio?.app?.entry ??
        pkg.manifest.module ??
        pkg.manifest.main ??
        "index"));
  return resolveSourceModule(path.resolve(pkg.directory, configured));
}

function workspacePackageForSpecifier(specifier) {
  return (
    [...packages.entries()]
      .filter(([name]) => specifier === name || specifier.startsWith(`${name}/`))
      .sort(([left], [right]) => right.length - left.length)[0] ?? null
  );
}

function reachablePackageModules(pkg) {
  const entry = packageEntry(pkg);
  if (!entry)
    throw new Error(`${path.relative(root, pkg.file)} has no resolvable executable entry`);
  const files = [];
  const seen = new Set();
  const visit = (file) => {
    const absolute = path.resolve(file);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const source = fs.readFileSync(absolute, "utf8");
    files.push({ file: absolute, source });
    const parsed = ts.createSourceFile(
      absolute,
      source,
      ts.ScriptTarget.Latest,
      false,
      absolute.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const specifiers = [];
    const inspect = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly !== true) {
          specifiers.push(node.moduleSpecifier.text);
        }
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        specifiers.push(node.arguments[0].text);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(parsed);
    for (const specifier of specifiers) {
      let resolved = null;
      if (specifier.startsWith(".")) {
        resolved = resolveSourceModule(path.resolve(path.dirname(absolute), specifier));
        if (!resolved) {
          throw new Error(
            `${path.relative(root, absolute)} has an unresolved local import ${specifier}`
          );
        }
      } else {
        const matched = workspacePackageForSpecifier(specifier);
        if (!matched) continue;
        const [name, dependency] = matched;
        const suffix = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
        resolved = packageEntry(dependency, suffix);
        if (!resolved) {
          throw new Error(
            `${path.relative(root, absolute)} has an unresolved workspace import ${specifier}`
          );
        }
      }
      visit(resolved);
    }
  };
  visit(entry);
  return files;
}

const EFFECT_IMPLEMENTATION_PACKAGES = new Set([
  "@workspace/runtime",
  "@vibestudio/rpc",
  "@vibestudio/service-schemas",
  "@vibestudio/shared",
  "@vibestudio/extension",
  "@vibestudio/credential-client",
  "@vibestudio/browser-data",
  "@vibestudio/git",
  "@workspace/react",
  "@workspace/svelte",
  "@workspace/about-shared",
]);

function ownerPackageForFile(file) {
  return (
    [...packages.values()]
      .filter(
        (candidate) =>
          file === candidate.file || file.startsWith(`${candidate.directory}${path.sep}`)
      )
      .sort((left, right) => right.directory.length - left.directory.length)[0] ?? null
  );
}

function inferCapabilities(pkg) {
  const modules = reachablePackageModules(pkg);
  const source = modules
    .filter(({ file }) => {
      const owner = ownerPackageForFile(file);
      return !owner || !EFFECT_IMPLEMENTATION_PACKAGES.has(owner.manifest.name);
    })
    .map(({ source: moduleSource }) => moduleSource)
    .join("\n");
  const capabilities = new Set();
  capabilities.add("context.boundary");

  for (const capability of inferExtensionContextCapabilities(source, hostCapabilities)) {
    capabilities.add(capability);
  }
  for (const capability of inferHostedRuntimeCapabilities(source, hostCapabilities)) {
    capabilities.add(capability);
  }

  // Literal host/direct method names are the common RPC form. Filtering
  // against the generated method census prevents ordinary prose from becoming
  // authority.
  for (const capability of hostCapabilities) {
    const method = capability.slice("service:".length);
    if (
      source.includes(`"${method}"`) ||
      source.includes(`'${method}'`) ||
      source.includes(`\`${method}\``)
    ) {
      capabilities.add(capability);
    }
  }
  for (const capability of inferTypedWorkspaceEffects(source)) {
    capabilities.add(capability);
  }
  for (const capability of inferEventsClientCapabilities(source, serviceMethods)) {
    capabilities.add(capability);
  }
  for (const capability of inferTypedServiceClientCapabilities(source, hostCapabilities)) {
    capabilities.add(capability);
  }

  // Property-based hosted-runtime clients remain statically reviewable.
  for (const match of source.matchAll(
    /(?:services|runtime\.services)\.([A-Za-z][\w-]*)\.([A-Za-z_$][\w$]*)/g
  )) {
    const capability = `service:${match[1]}.${match[2]}`;
    if (hostCapabilities.has(capability)) capabilities.add(capability);
  }

  const userland = [
    ["createVcsUserlandClient", "vcs"],
    ["createGadServiceClient", "gad.workspace"],
    ["createChannelServiceClient", "channel"],
    ["testkit-driver", "testkit-driver"],
    ["vibestudio.models.v1", "models"],
  ];
  let resolvesUserlandService = false;
  for (const [needle, name] of userland) {
    if (!source.includes(needle)) continue;
    resolvesUserlandService = true;
    capabilities.add(`workspace-service:${name}`);
  }
  for (const [protocol, name] of userlandServiceByProtocol) {
    if (
      source.includes(`"${protocol}"`) ||
      source.includes(`'${protocol}'`) ||
      source.includes(`\`${protocol}\``)
    ) {
      resolvesUserlandService = true;
      capabilities.add(`workspace-service:${name}`);
    }
  }
  if (resolvesUserlandService) {
    capabilities.add("service:workers.resolveService");
  }

  for (const capability of pkg.manifest.vibestudio?.app?.capabilities ?? []) {
    if (typeof capability === "string") capabilities.add(capability);
  }
  expandCapabilityDependencies(capabilities, methodCapabilityDependencies);
  return [...new Set([...capabilities].map(toManifestCapability))]
    .filter(requiresManifestRequest)
    .sort();
}

let invalid = false;
const applySuggestions = process.argv.includes("--apply");
for (const pkg of [...packages.values()].sort((a, b) => a.file.localeCompare(b.file))) {
  if (!isExecutableUnitPackage(pkg)) continue;
  const capabilities = inferCapabilities(pkg);
  const authority = pkg.manifest.vibestudio?.authority;
  if (
    !authority ||
    Object.keys(authority).sort().join(",") !== "evalCeilings,requests" ||
    !Array.isArray(authority.requests) ||
    !Array.isArray(authority.evalCeilings)
  ) {
    console.error(
      `${path.relative(root, pkg.file)} must explicitly contain exactly authority.requests and authority.evalCeilings`
    );
    invalid = true;
    continue;
  }
  if (applySuggestions) {
    const existingCapabilities = new Set(authority.requests.map((request) => request.capability));
    authority.requests = [
      ...authority.requests,
      ...capabilities
        .filter((capability) => !existingCapabilities.has(capability))
        .map((capability) => ({ capability, resource: { kind: "prefix", prefix: "" } })),
    ]
      .map(normalizeManifestEntry)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    authority.evalCeilings = authority.evalCeilings.map((ceiling) => ({
      ...ceiling,
      capabilities: Array.isArray(ceiling.capabilities)
        ? ceiling.capabilities
            .map(normalizeManifestEntry)
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
        : ceiling.capabilities,
    }));
    fs.writeFileSync(pkg.file, `${JSON.stringify(pkg.manifest, null, 2)}\n`);
  }
  for (const [index, request] of authority.requests.entries()) {
    let normalized;
    try {
      normalized = normalizeManifestEntry(request);
    } catch (error) {
      console.error(
        `${path.relative(root, pkg.file)} authority request ${index}: ${error.message}`
      );
      invalid = true;
      continue;
    }
    if (JSON.stringify(request) !== JSON.stringify(normalized)) {
      console.error(
        `${path.relative(root, pkg.file)} authority request ${index} has stale tier/evidence metadata`
      );
      invalid = true;
    }
  }
  const requested = [...new Set(authority.requests.map((request) => request?.capability))].sort();
  const missing = capabilities.filter((capability) => !requested.includes(capability));
  // Static analysis can prove a visible effect is missing from the explicit
  // ceiling, but it cannot prove an author-reviewed request unused: dynamic
  // module selection, workspace services, and userland dispatch are all valid
  // runtime behavior. The explicit manifest remains the authority source; the
  // analyzer is a monotonic admission check and suggestion tool, never an
  // automatic capability revoker or approver.
  if (missing.length) {
    console.error(`${path.relative(root, pkg.file)} authority request mismatch`);
    for (const capability of missing) console.error(`  missing explicit request: ${capability}`);
    invalid = true;
  }
  const ceilingCapabilities = authority.evalCeilings.flatMap((ceiling) =>
    Array.isArray(ceiling?.capabilities)
      ? ceiling.capabilities.map((entry) => entry?.capability)
      : [undefined]
  );
  for (const [ceilingIndex, ceiling] of authority.evalCeilings.entries()) {
    for (const [capabilityIndex, capability] of (ceiling?.capabilities ?? []).entries()) {
      let normalized;
      try {
        normalized = normalizeManifestEntry(capability);
      } catch (error) {
        console.error(
          `${path.relative(root, pkg.file)} eval ceiling ${ceilingIndex} capability ${capabilityIndex}: ${error.message}`
        );
        invalid = true;
        continue;
      }
      if (JSON.stringify(capability) !== JSON.stringify(normalized)) {
        console.error(
          `${path.relative(root, pkg.file)} eval ceiling ${ceilingIndex} capability ${capabilityIndex} has stale tier/evidence metadata`
        );
        invalid = true;
      }
    }
  }
  const unknownCeilings = ceilingCapabilities.filter(
    (capability) =>
      typeof capability !== "string" ||
      !requiresManifestRequest(capability) ||
      !evalCeilingCapabilities.some((allowed) =>
        allowed.endsWith("*") ? capability.startsWith(allowed.slice(0, -1)) : allowed === capability
      )
  );
  if (
    (pkg.manifest.vibestudio?.agent && ceilingCapabilities.length === 0) ||
    unknownCeilings.length
  ) {
    console.error(`${path.relative(root, pkg.file)} has an invalid explicit eval ceiling`);
    for (const capability of unknownCeilings)
      console.error(`  unknown ceiling capability: ${String(capability)}`);
    invalid = true;
  }
}
if (invalid) {
  console.error(
    "Authority manifests are author-reviewed source. Edit them explicitly; validation never rewrites them."
  );
  process.exitCode = 1;
}
