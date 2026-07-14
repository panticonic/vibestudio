import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  EXTENSION_RUNTIME_BASE_CAPABILITIES,
  declaredMethodCapabilityDependencies,
  expandCapabilityDependencies,
  inferDirectRpcCapabilities,
  inferExtensionContextCapabilities,
  inferHostedRuntimeCapabilities,
  inferWorkspacePackageReferences,
} from "./lib/unit-authority-inference.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.join(root, "workspace");
const check = process.argv.includes("--check");
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
const workspaceManifest = YAML.parse(
  fs.readFileSync(path.join(workspaceRoot, "meta/vibestudio.yml"), "utf8")
);
const userlandServiceByProtocol = new Map(
  (workspaceManifest.services ?? []).flatMap((service) =>
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
const directCapabilities = new Set(
  authorityLedger.rows
    .filter((row) => row.rpcPlane === "workspace-do")
    .map((row) => `rpc:${row.method}`)
);

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

function packageSource(pkg, seen = new Set()) {
  if (seen.has(pkg.file)) return "";
  seen.add(pkg.file);
  const own = productionSource(pkg.directory);
  const contributions = [...inferWorkspacePackageReferences(own, packages.keys())]
    .map((name) => packages.get(name))
    .filter(Boolean)
    .map((dependency) => packageSource(dependency, seen));
  return [own, ...contributions].join("\n");
}

function inferCapabilities(pkg) {
  const source = packageSource(pkg);
  const capabilities = new Set();

  if (pkg.manifest.vibestudio?.extension) {
    for (const capability of EXTENSION_RUNTIME_BASE_CAPABILITIES) {
      capabilities.add(capability);
    }
  }

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
  for (const capability of inferDirectRpcCapabilities(source, directCapabilities)) {
    capabilities.add(capability);
  }

  // Typed clients seal a complete schema surface. Tree-shaken call sites can
  // still select any method on that constructed client, so request each exact
  // method instead of a service wildcard.
  for (const match of source.matchAll(/createTypedServiceClient\(\s*["']([^"']+)["']/g)) {
    const service = match[1];
    for (const method of serviceMethods.get(service) ?? []) {
      capabilities.add(`service:${service}.${method}`);
    }
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
    capabilities.add(`userland-service:${name}`);
  }
  for (const [protocol, name] of userlandServiceByProtocol) {
    if (
      source.includes(`"${protocol}"`) ||
      source.includes(`'${protocol}'`) ||
      source.includes(`\`${protocol}\``)
    ) {
      resolvesUserlandService = true;
      capabilities.add(`userland-service:${name}`);
    }
  }
  if (resolvesUserlandService) {
    capabilities.add("service:workers.resolveService");
  }

  for (const capability of pkg.manifest.vibestudio?.app?.capabilities ?? []) {
    if (typeof capability === "string") capabilities.add(capability);
  }
  expandCapabilityDependencies(capabilities, methodCapabilityDependencies);
  return [...capabilities].sort();
}

let stale = false;
for (const pkg of [...packages.values()].sort((a, b) => a.file.localeCompare(b.file))) {
  if (!pkg.manifest.vibestudio?.authority) continue;
  const capabilities = inferCapabilities(pkg);
  const requests = capabilities.map((capability) => ({
    capability,
    resource: { kind: "prefix", prefix: "" },
  }));
  const next = structuredClone(pkg.manifest);
  next.vibestudio.authority = { requests };
  const expected = `${JSON.stringify(next, null, 2)}\n`;
  const actual = fs.readFileSync(pkg.file, "utf8");
  if (actual === expected) continue;
  if (check) {
    console.error(`${path.relative(root, pkg.file)} has stale authority requests`);
    stale = true;
  } else {
    fs.writeFileSync(pkg.file, expected);
  }
}
if (stale) process.exitCode = 1;
