import * as path from "node:path";
import * as fs from "node:fs";
import type { PrincipalKind } from "@vibestudio/rpc";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import type { WorkspaceServiceDecl } from "@vibestudio/workspace-contracts/types";
import {
  buildWorkspaceDeclarations,
  type WorkspaceDeclarations,
} from "@vibestudio/workspace/singletonRegistry";
import type { GraphNode, PackageGraph } from "./packageGraph.js";
import type { BuildSourceProvider } from "./buildSource.js";
import { collectTransitiveInternalDeps } from "./buildSource.js";
import { collectWorkspaceRpcCatalog, type WorkspaceRpcMethodDoc } from "./workspaceRpcCatalog.js";
import { workspaceRpcSchema } from "./workspaceRpcSchemas.js";

export const USERLAND_AUTHORITY_ANALYZER_VERSION = "userland-authority-v2";

export interface ExactWorkspaceServiceBinding {
  name: string;
  protocols: readonly string[];
  source: string;
  title?: string;
  action: string;
  description?: string;
  notability?: WorkspaceServiceDecl["notability"];
  presentation: WorkspaceServiceDecl["presentation"];
  principals: readonly PrincipalKind[];
  target:
    | { kind: "durable-object"; className: string; defaultObjectKey: string | null }
    | { kind: "worker"; routePath: string };
}

export interface UserlandServiceAuthorityCatalog {
  provider: {
    unitName: string;
    source: string;
    effectiveVersion: string;
    className: string;
  };
  methods: ReadonlyMap<string, UserlandMethodAuthority>;
  digest: string;
}

export interface EffectiveMethodAccess {
  principals: readonly PrincipalKind[];
  codeOnly: boolean;
  codeReachable: boolean;
}

export type UserlandMethodAuthority =
  | {
      kind: "open";
      tier: "open";
      access: EffectiveMethodAccess;
      producesHandle?: UserlandHandleProduction;
    }
  | {
      kind: "protected";
      localCapability: string;
      canonicalCapability: string;
      definitionDigest: string;
      tier: "gated" | "critical";
      sensitivity: "read" | "write" | "admin" | "destructive";
      resource:
        | { kind: "receiver-object"; resourceType: string }
        | { kind: "opaque-handle"; resourceType: string; argument: number };
      access: EffectiveMethodAccess;
      producesHandle?: UserlandHandleProduction;
    };

export interface UserlandHandleProduction {
  localCapability: string;
  canonicalCapability: string;
  definitionDigest: string;
  resourceType: string;
}

export interface ExactResolvedService {
  stateHash: string;
  binding: ExactWorkspaceServiceBinding;
  catalog: UserlandServiceAuthorityCatalog;
}

export type ServiceResolution =
  | { kind: "resolved"; service: ExactResolvedService }
  | { kind: "missing"; query: string }
  | { kind: "inaccessible"; query: string; service: ExactResolvedService }
  | { kind: "unbounded" };

export type MethodResolution =
  | { kind: "resolved"; method: UserlandMethodAuthority }
  | { kind: "missing"; method: string }
  | { kind: "inaccessible"; method: string; authority: UserlandMethodAuthority }
  | { kind: "dynamic"; reachable: readonly UserlandMethodAuthority[] };

export interface ExactWorkspaceAuthorityEnvironment {
  stateHash: string;
  services: readonly ExactWorkspaceServiceBinding[];
  digest: string;
  resolveService(query: string): Promise<ServiceResolution>;
}

export interface ProviderCatalogResolverInput {
  stateHash: string;
  provider: GraphNode;
  effectiveVersion: string;
  className: string;
  graph: PackageGraph;
  workspaceRoot: string;
  source: BuildSourceProvider;
}

interface CatalogCacheEntry {
  key: string;
  value: UserlandServiceAuthorityCatalog;
}

export interface ExactProviderRpcCatalog {
  provider: {
    unitName: string;
    source: string;
    effectiveVersion: string;
    className: string;
  };
  methods: readonly WorkspaceRpcMethodDoc[];
}

interface RpcCatalogCacheEntry {
  key: string;
  value: ExactProviderRpcCatalog;
}

const catalogEntries = new Map<string, CatalogCacheEntry>();
const catalogFlights = new Map<string, Promise<UserlandServiceAuthorityCatalog>>();
const rpcCatalogEntries = new Map<string, RpcCatalogCacheEntry>();
const rpcCatalogFlights = new Map<string, Promise<ExactProviderRpcCatalog>>();
const MAX_CATALOG_CACHE = 64;

function rememberCatalog(key: string, value: UserlandServiceAuthorityCatalog): void {
  catalogEntries.delete(key);
  catalogEntries.set(key, { key, value });
  while (catalogEntries.size > MAX_CATALOG_CACHE) {
    const oldest = catalogEntries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    catalogEntries.delete(oldest);
  }
}

function rememberRpcCatalog(key: string, value: ExactProviderRpcCatalog): void {
  rpcCatalogEntries.delete(key);
  rpcCatalogEntries.set(key, { key, value });
  while (rpcCatalogEntries.size > MAX_CATALOG_CACHE) {
    const oldest = rpcCatalogEntries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    rpcCatalogEntries.delete(oldest);
  }
}

function authorityDigest(authority: UnitAuthorityManifest): string {
  return sha256Canonical({
    requests: authority.requests,
    provides: authority.provides,
  });
}

function materializedAuthority(provider: GraphNode, sourceRoot: string): UnitAuthorityManifest {
  const packagePath = path.join(sourceRoot, provider.relativePath, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    vibestudio?: { authority?: unknown };
  };
  return parseUnitAuthorityManifest(
    packageJson.vibestudio?.authority ?? { requests: [], provides: [] },
    `${provider.name} vibestudio.authority`
  );
}

function methodAccess(
  doc: WorkspaceRpcMethodDoc,
  binding: ExactWorkspaceServiceBinding
): EffectiveMethodAccess {
  const principals = [
    ...new Set((doc.access?.principals ?? []).filter(isPrincipal)),
  ] as PrincipalKind[];
  return {
    principals,
    codeOnly: doc.access?.codeOnly === true,
    codeReachable: binding.principals.includes("code") && principals.includes("code"),
  };
}

function isPrincipal(value: string): value is PrincipalKind {
  return ["host", "user", "code", "session", "mission"].includes(value);
}

function projectMethod(
  doc: WorkspaceRpcMethodDoc,
  binding: ExactWorkspaceServiceBinding
): UserlandMethodAuthority {
  const access = methodAccess(doc, binding);
  if (doc.effect.kind === "open") {
    if (doc.access?.tier !== "open") {
      throw new Error(`${doc.className}.${doc.name} has an open effect but is not open-tier`);
    }
    return {
      kind: "open",
      tier: "open",
      access,
      ...(doc.producesHandle
        ? {
            producesHandle: {
              localCapability: doc.producesHandle.localName,
              canonicalCapability: doc.producesHandle.canonicalCapability,
              definitionDigest: doc.producesHandle.definitionDigest,
              resourceType: doc.producesHandle.resourceType,
            },
          }
        : {}),
    };
  }
  if (doc.effect.kind !== "userland-capability" || !doc.userlandCapability) {
    throw new Error(`${doc.className}.${doc.name} has no sealed userland capability`);
  }
  if (doc.access?.tier !== "gated" && doc.access?.tier !== "critical") {
    throw new Error(`${doc.className}.${doc.name} has no sealed protected tier`);
  }
  return {
    kind: "protected",
    localCapability: doc.userlandCapability.localName,
    canonicalCapability: doc.userlandCapability.canonicalCapability,
    definitionDigest: doc.userlandCapability.definitionDigest,
    tier: doc.access.tier,
    sensitivity: doc.access.sensitivity ?? "read",
    resource:
      doc.effect.resource.kind === "receiver-object"
        ? { kind: "receiver-object", resourceType: doc.userlandCapability.resourceType }
        : {
            kind: "opaque-handle",
            resourceType: doc.userlandCapability.resourceType,
            argument: doc.effect.resource.argument,
          },
    access,
    ...(doc.producesHandle
      ? {
          producesHandle: {
            localCapability: doc.producesHandle.localName,
            canonicalCapability: doc.producesHandle.canonicalCapability,
            definitionDigest: doc.producesHandle.definitionDigest,
            resourceType: doc.producesHandle.resourceType,
          },
        }
      : {}),
  };
}

function catalogDigest(
  provider: GraphNode,
  effectiveVersion: string,
  className: string,
  methods: ReadonlyMap<string, UserlandMethodAuthority>
): string {
  return sha256Canonical({
    analyzer: USERLAND_AUTHORITY_ANALYZER_VERSION,
    provider: provider.relativePath,
    effectiveVersion,
    className,
    methods: [...methods.entries()].sort(([a], [b]) => a.localeCompare(b)),
  });
}

function providerCatalogIdentity(input: ProviderCatalogResolverInput): {
  classManifest: NonNullable<GraphNode["manifest"]["durable"]>["classes"][number];
  key: string;
} {
  if (input.provider.kind !== "worker") {
    throw new Error(
      `Workspace service provider ${input.provider.relativePath} is not a worker unit`
    );
  }
  const classes = input.provider.manifest.durable?.classes ?? [];
  const classManifest = classes.find((entry) => entry.className === input.className);
  if (!classManifest) {
    throw new Error(
      `Workspace service ${input.provider.relativePath} declares missing Durable Object class ${input.className}`
    );
  }
  const authorityManifestDigest = authorityDigest(
    input.provider.manifest.authority ?? { requests: [], provides: [] }
  );
  const schemaVersion = classManifest.rpcSchema ?? "none";
  return {
    classManifest,
    key: [
      input.provider.relativePath,
      input.effectiveVersion,
      authorityManifestDigest,
      input.className,
      schemaVersion,
      USERLAND_AUTHORITY_ANALYZER_VERSION,
    ].join("\0"),
  };
}

/** Resolve documentation and receiver declarations from one exact provider
 * source view. Authority analysis and live documentation share this extraction
 * so neither needs an executable worker build. */
export async function resolveProviderRpcCatalog(
  input: ProviderCatalogResolverInput
): Promise<ExactProviderRpcCatalog> {
  const { classManifest, key } = providerCatalogIdentity(input);
  const cached = rpcCatalogEntries.get(key);
  if (cached) {
    rpcCatalogEntries.delete(key);
    rpcCatalogEntries.set(key, cached);
    return cached.value;
  }
  const flight = rpcCatalogFlights.get(key);
  if (flight) return flight;
  const pending = (async () => {
    const materialized = await input.source.materializeForBuild(
      collectTransitiveInternalDeps(input.provider, input.graph),
      input.stateHash,
      input.workspaceRoot
    );
    const sourcePath = path.join(materialized.sourceRoot, input.provider.relativePath);
    const packageAuthority = materializedAuthority(input.provider, materialized.sourceRoot);
    const schema = classManifest.rpcSchema
      ? workspaceRpcSchema(classManifest.rpcSchema)
      : undefined;
    if (classManifest.rpcSchema && !schema) {
      throw new Error(
        `${input.provider.relativePath}:${input.className} names unknown workspace RPC schema ${classManifest.rpcSchema}`
      );
    }
    const methods = (
      await collectWorkspaceRpcCatalog(sourcePath, {
        provider: input.provider.relativePath,
        authority: packageAuthority,
        ...(schema ? { rpcSchemas: { [input.className]: schema } } : {}),
      })
    ).filter((entry) => entry.className === input.className);
    const catalog: ExactProviderRpcCatalog = {
      provider: {
        unitName: input.provider.name,
        source: input.provider.relativePath,
        effectiveVersion: input.effectiveVersion,
        className: input.className,
      },
      methods,
    };
    rememberRpcCatalog(key, catalog);
    return catalog;
  })();
  rpcCatalogFlights.set(key, pending);
  try {
    return await pending;
  } finally {
    rpcCatalogFlights.delete(key);
  }
}

export async function resolveProviderCatalog(
  input: ProviderCatalogResolverInput
): Promise<UserlandServiceAuthorityCatalog> {
  const { key } = providerCatalogIdentity(input);
  const cached = catalogEntries.get(key);
  if (cached) {
    catalogEntries.delete(key);
    catalogEntries.set(key, cached);
    return cached.value;
  }
  const flight = catalogFlights.get(key);
  if (flight) return flight;
  const pending = (async () => {
    const sourceCatalog = await resolveProviderRpcCatalog(input);
    const serviceBinding: ExactWorkspaceServiceBinding = {
      name: "__catalog__",
      protocols: [],
      source: input.provider.relativePath,
      action: "",
      presentation: { domain: "computer", verb: "see" },
      principals: ["code"],
      target: { kind: "durable-object", className: input.className, defaultObjectKey: null },
    };
    const methods = new Map<string, UserlandMethodAuthority>();
    for (const doc of sourceCatalog.methods) {
      if (methods.has(doc.name))
        throw new Error(`Duplicate RPC method ${input.className}.${doc.name}`);
      methods.set(doc.name, projectMethod(doc, serviceBinding));
    }
    const catalog: UserlandServiceAuthorityCatalog = {
      provider: {
        unitName: input.provider.name,
        source: input.provider.relativePath,
        effectiveVersion: input.effectiveVersion,
        className: input.className,
      },
      methods,
      digest: catalogDigest(input.provider, input.effectiveVersion, input.className, methods),
    };
    rememberCatalog(key, catalog);
    return catalog;
  })();
  catalogFlights.set(key, pending);
  try {
    return await pending;
  } finally {
    catalogFlights.delete(key);
  }
}

export function exactServiceBindingFromDeclarations(
  service: WorkspaceServiceDecl,
  declarations: WorkspaceDeclarations
): ExactWorkspaceServiceBinding {
  const target = service.durableObject
    ? {
        kind: "durable-object" as const,
        className: service.durableObject.className,
        defaultObjectKey:
          declarations.singletons.find(service.source, service.durableObject.className)?.key ??
          null,
      }
    : { kind: "worker" as const, routePath: service.worker.routePath };
  return {
    name: service.name,
    protocols: [...(service.protocols ?? [])].sort(),
    source: service.source,
    ...(service.title ? { title: service.title } : {}),
    action: service.action,
    ...(service.description ? { description: service.description } : {}),
    ...(service.notability ? { notability: service.notability } : {}),
    presentation: { ...service.presentation },
    principals: [...service.authority.principals].sort() as PrincipalKind[],
    target,
  };
}

export function exactWorkspaceServiceBindings(
  config: Parameters<typeof buildWorkspaceDeclarations>[0]
): ExactWorkspaceServiceBinding[] {
  const declarations = buildWorkspaceDeclarations(config);
  return (config.services ?? []).map((service) =>
    exactServiceBindingFromDeclarations(service, declarations)
  );
}

export function exactServiceBindingDigest(binding: ExactWorkspaceServiceBinding): string {
  return sha256Canonical({
    ...binding,
    protocols: [...binding.protocols].sort(),
    principals: [...binding.principals].sort(),
  });
}

export function exactWorkspaceEnvironmentDigest(
  stateHash: string,
  services: readonly ExactWorkspaceServiceBinding[]
): string {
  return sha256Canonical({
    stateHash,
    services: services
      .map((service) => ({ ...service, digest: exactServiceBindingDigest(service) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

export function createExactWorkspaceAuthorityEnvironment(input: {
  stateHash: string;
  services: readonly ExactWorkspaceServiceBinding[];
  resolveCatalog(binding: ExactWorkspaceServiceBinding): Promise<UserlandServiceAuthorityCatalog>;
}): ExactWorkspaceAuthorityEnvironment {
  const allServices = [...input.services];
  const byKey = new Map<string, ExactWorkspaceServiceBinding>();
  for (const service of allServices) {
    for (const key of [service.name, ...service.protocols]) {
      if (byKey.has(key)) throw new Error(`Duplicate workspace service key ${JSON.stringify(key)}`);
      byKey.set(key, service);
    }
  }
  const services = Object.freeze(allServices.map((service) => Object.freeze({ ...service })));
  return {
    stateHash: input.stateHash,
    services,
    digest: exactWorkspaceEnvironmentDigest(input.stateHash, services),
    async resolveService(query: string): Promise<ServiceResolution> {
      const binding = byKey.get(query);
      if (!binding) return { kind: "missing", query };
      const catalog = await input.resolveCatalog(binding);
      const service = { stateHash: input.stateHash, binding, catalog };
      if (!binding.principals.includes("code")) return { kind: "inaccessible", query, service };
      return { kind: "resolved", service };
    },
  };
}

export function resolveMethod(
  catalog: UserlandServiceAuthorityCatalog,
  method: string | null
): MethodResolution {
  if (method === null) {
    return {
      kind: "dynamic",
      reachable: [...catalog.methods.values()].filter(
        (authority) => authority.access.codeReachable
      ),
    };
  }
  const authority = catalog.methods.get(method);
  if (!authority) return { kind: "missing", method };
  if (!authority.access.codeReachable) return { kind: "inaccessible", method, authority };
  return { kind: "resolved", method: authority };
}
