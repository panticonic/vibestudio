import * as path from "node:path";
import type { Project } from "typescript/unstable/sync";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import {
  HOST_AUTHORITY_METHODS,
  HOST_METHOD_MANIFEST_DEPENDENCIES,
} from "@vibestudio/shared/authority/hostAuthorityCatalog.generated";
import { inferUnitTransportCapabilities } from "@vibestudio/shared/unitAuthorityInference";
import {
  authorityRequestCoversEffect,
  userlandHandleResourcePrefix,
  userlandReceiverResourceScope,
  workspaceServiceInvocationResource,
  workspaceServiceResolutionResource,
} from "@vibestudio/shared/authority/userlandResources";
import type { PackageManifest } from "@vibestudio/shared/types";
import type { BuildDiagnostic } from "./diagnostics.js";
import {
  analyzeWorkspaceServiceCalls,
  type AbstractString,
  type AuthorityFoldUnit,
  type WorkspaceServiceCallFact,
} from "./userlandAuthorityAnalyzer.js";
import {
  resolveMethod,
  type ExactWorkspaceAuthorityEnvironment,
  type ExactResolvedService,
  type UserlandMethodAuthority,
} from "./userlandAuthority.js";
import {
  consumerAuthorityFacts,
  EFFECT_IMPLEMENTATION_PACKAGES,
} from "./authorityEffectBoundary.js";

export type { AuthorityFoldUnit } from "./userlandAuthorityAnalyzer.js";

const hostCapabilities = new Set(
  Object.keys(HOST_AUTHORITY_METHODS).map((method) => `service:${method}`)
);
const serviceMethods = new Map<string, string[]>();
for (const method of Object.keys(HOST_AUTHORITY_METHODS)) {
  const separator = method.indexOf(".");
  if (separator < 1) continue;
  const service = method.slice(0, separator);
  const member = method.slice(separator + 1);
  const members = serviceMethods.get(service) ?? [];
  members.push(member);
  serviceMethods.set(service, members);
}

function containsCapability(manifest: UnitAuthorityManifest, capability: string): boolean {
  return manifest.requests.some((request) =>
    authorityRequestCoversEffect(request, { capability, tier: request.tier })
  );
}

function semanticCapabilities(transportCapabilities: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  const seen = new Set<string>();
  const pending = [...transportCapabilities];
  while (pending.length > 0) {
    const transport = pending.shift()!;
    if (seen.has(transport)) continue;
    seen.add(transport);
    if (!transport.startsWith("service:")) {
      result.add(transport);
      continue;
    }
    const method = transport.slice("service:".length);
    const row = HOST_AUTHORITY_METHODS[method as keyof typeof HOST_AUTHORITY_METHODS];
    if (!row || row.tier.tier === "open") continue;
    if (row.capability) result.add(row.capability);
    const dependencies =
      HOST_METHOD_MANIFEST_DEPENDENCIES[method as keyof typeof HOST_METHOD_MANIFEST_DEPENDENCIES] ??
      [];
    pending.push(...dependencies);
  }
  return result;
}

function sourceClosure(
  project: Project,
  sourceRoot: string,
  unitRelativePath: string,
  units: readonly AuthorityFoldUnit[],
  executableModules: Parameters<typeof analyzeWorkspaceServiceCalls>[0]["executableModules"]
): string {
  const unitRoots = units
    .map((unit) => ({ unit, root: `${path.resolve(sourceRoot, unit.relativePath)}${path.sep}` }))
    .sort((left, right) => right.root.length - left.root.length);
  const consumerRoot = path.resolve(sourceRoot, unitRelativePath);
  const consumerSource = project.program
    .getSourceFileNames()
    .flatMap((fileName) => {
      const sourceFile = project.program.getSourceFile(fileName);
      return sourceFile ? [sourceFile] : [];
    })
    .filter((sourceFile) => {
      if (sourceFile.isDeclarationFile) return false;
      const file = path.resolve(sourceFile.fileName);
      const owned = unitRoots.find(({ root }) => `${file}${path.sep}`.startsWith(root));
      return owned
        ? path.resolve(sourceRoot, owned.unit.relativePath) === consumerRoot
        : `${file}${path.sep}`.startsWith(`${consumerRoot}${path.sep}`);
    })
    .map((sourceFile) => sourceFile.text)
    .join("\n");
  const dependencySource = (executableModules ?? [])
    .filter(
      (module) =>
        module.package.kind === "first-party" ||
        !EFFECT_IMPLEMENTATION_PACKAGES.has(module.package.name)
    )
    .map((module) => module.source)
    .join("\n");
  return `${consumerSource}\n${dependencySource}`;
}

/**
 * Compare statically visible effects in the exact materialized TypeScript
 * program with the executable unit's reviewed authority ceiling. This is a
 * diagnostic only: it never edits the manifest and never creates a grant.
 */
export async function authorityDiagnosticsForProgram(input: {
  project: Project;
  sourceRoot: string;
  unitRelativePath: string;
  units: readonly AuthorityFoldUnit[];
  manifest: PackageManifest;
  environment?: ExactWorkspaceAuthorityEnvironment;
  workspaceId?: string;
  executableModules?: Parameters<typeof analyzeWorkspaceServiceCalls>[0]["executableModules"];
}): Promise<BuildDiagnostic[]> {
  let authority: UnitAuthorityManifest;
  try {
    authority = parseUnitAuthorityManifest(
      input.manifest.authority ?? { requests: [], provides: [] },
      `${input.unitRelativePath}/package.json vibestudio.authority`
    );
  } catch (error) {
    return [
      {
        source: "authority",
        severity: "error",
        file: `${input.unitRelativePath}/package.json`,
        line: 1,
        column: 1,
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }

  const source = sourceClosure(
    input.project,
    input.sourceRoot,
    input.unitRelativePath,
    input.units,
    input.executableModules
  );
  const transports = inferUnitTransportCapabilities(source, {
    hostCapabilities,
    serviceMethods,
  });
  // A library package has no runtime/context boundary of its own. Its reachable
  // effects are charged to the executable consumer; explicit host calls still
  // add their semantic context dependency below.
  if (!input.manifest.app) transports.delete("context.boundary");
  for (const capability of input.manifest.app?.capabilities ?? []) transports.add(capability);
  const required = semanticCapabilities(transports);
  const diagnostics = [...required]
    .filter((capability) => !containsCapability(authority, capability))
    .sort();
  const hostDiagnostics = diagnostics.map((capability) => ({
    source: "authority" as const,
    severity: "error" as const,
    file: `${input.unitRelativePath}/package.json`,
    line: 1,
    column: 1,
    message: `Installed code uses capability '${capability}' but vibestudio.authority.requests does not declare it. Add the narrowest reviewed request, then rebuild this exact context.`,
    suggestion: `Add an authority request for ${JSON.stringify(capability)}; use live capability docs to select its narrowest resource scope.`,
  }));
  if (!input.environment) return hostDiagnostics;

  const facts = consumerAuthorityFacts(
    analyzeWorkspaceServiceCalls({
      project: input.project,
      sourceRoot: input.sourceRoot,
      unitRelativePath: input.unitRelativePath,
      units: input.units,
      // Runtime and transport packages implement the authority-bearing calls
      // that consumer syntax denotes; their internal generic dispatchers are not
      // themselves consumer intent. Direct consumer calls remain in `program`,
      // while non-platform dependency modules stay here so package endowments
      // are still checked.
      executableModules: input.executableModules?.filter(
        (module) =>
          module.package.kind === "first-party" ||
          !EFFECT_IMPLEMENTATION_PACKAGES.has(module.package.name)
      ),
    })
  );
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const effects: RequiredAuthorityEffect[] = [];
  const userlandDiagnostics: BuildDiagnostic[] = [];
  const consumerName =
    input.units.find((unit) => unit.relativePath === input.unitRelativePath)?.name ??
    input.unitRelativePath;
  const addDiagnostic = (
    fact: WorkspaceServiceCallFact,
    message: string,
    suggestion?: string
  ): void => {
    const attributedMessage = fact.origin.package
      ? `Dependency package '${fact.origin.package.name}' contributes authority to consumer '${consumerName}': ${message}`
      : message;
    userlandDiagnostics.push({
      source: "authority",
      severity: "error",
      file: fact.origin.file,
      line: fact.origin.line,
      column: fact.origin.column,
      message: attributedMessage,
      ...(suggestion ? { suggestion } : {}),
    });
  };
  const addEffect = (
    fact: WorkspaceServiceCallFact,
    service: ExactResolvedService,
    effect: Omit<RequiredAuthorityEffect, "origin" | "packageName">
  ): void => {
    effects.push({
      ...effect,
      origin: fact.origin,
      ...(fact.origin.package?.name ? { packageName: fact.origin.package.name } : {}),
    });
  };
  const literalValues = (value: AbstractString): string[] | null =>
    value.kind === "literals" ? [...value.values].sort() : null;
  const declaredServices = new Map(
    (authority.serviceRequests ?? []).map((request) => [request.protocol, request] as const)
  );
  const objectKeyValues = (
    service: ExactResolvedService,
    value: AbstractString | { kind: "not-applicable" }
  ): { keys: string[] | null; unbounded: boolean } => {
    if (value.kind === "literals") return { keys: [...value.values].sort(), unbounded: false };
    if (value.kind === "unknown" || value.kind === "symbolic") {
      return { keys: null, unbounded: true };
    }
    if (
      service.binding.target.kind === "durable-object" &&
      service.binding.target.defaultObjectKey
    ) {
      return { keys: [service.binding.target.defaultObjectKey], unbounded: false };
    }
    if (service.binding.target.kind === "worker") return { keys: null, unbounded: false };
    return { keys: null, unbounded: true };
  };
  const abstractKeysCompatible = (
    producer: ExactResolvedService,
    producerValue: AbstractString | { kind: "not-applicable" },
    consumer: ExactResolvedService,
    consumerValue: AbstractString | { kind: "not-applicable" }
  ): boolean => {
    if (producerValue.kind === "symbolic" && consumerValue.kind === "symbolic") {
      return producerValue.valueId === consumerValue.valueId;
    }
    const producerKeys = objectKeyValues(producer, producerValue).keys;
    const consumerKeys = objectKeyValues(consumer, consumerValue).keys;
    return (
      producerKeys !== null &&
      consumerKeys !== null &&
      producerKeys.some((key) => consumerKeys.includes(key))
    );
  };
  const sameServiceTarget = (left: ExactResolvedService, right: ExactResolvedService): boolean =>
    left.binding.source === right.binding.source &&
    left.binding.target.kind === right.binding.target.kind &&
    (left.binding.target.kind === "worker" && right.binding.target.kind === "worker"
      ? left.binding.target.routePath === right.binding.target.routePath
      : left.binding.target.kind === "durable-object" &&
        right.binding.target.kind === "durable-object" &&
        left.binding.target.className === right.binding.target.className);
  const operationResource = (
    service: ExactResolvedService,
    value: AbstractString | { kind: "not-applicable" }
  ): {
    resource: import("@vibestudio/rpc").ResourceScope;
    keys: string[] | null;
    unbounded: boolean;
  } => {
    const selected = objectKeyValues(service, value);
    return {
      ...selected,
      resource: workspaceServiceResolutionResource(service.binding, selected.keys),
    };
  };
  const serviceResults = async (
    fact: WorkspaceServiceCallFact
  ): Promise<Array<{ query: string; service: ExactResolvedService }>> => {
    const queries = literalValues(fact.serviceQueries);
    if (!queries) {
      addDiagnostic(
        fact,
        "Authority analysis cannot bound this workspace service query. Use a literal or finite literal union so the build can determine which provider authority the installed code may exercise."
      );
      return [];
    }
    const resolved: Array<{ query: string; service: ExactResolvedService }> = [];
    for (const query of queries) {
      const declaration = declaredServices.get(query);
      if (!declaration) {
        addDiagnostic(
          fact,
          `Installed code resolves workspace service protocol '${query}' but vibestudio.authority.serviceRequests does not declare it.`,
          `Declare ${JSON.stringify({ protocol: query, availability: "required" })} in vibestudio.authority.serviceRequests; this declaration is review vocabulary and does not replace the concrete provider capability grant.`
        );
        continue;
      }
      const result = await input.environment!.resolveService(query);
      if (result.kind === "missing") {
        if (declaration.availability === "required") {
          addDiagnostic(fact, `Required workspace service protocol '${query}' is unavailable.`);
        }
      } else if (result.kind === "inaccessible") {
        addDiagnostic(
          fact,
          `Workspace service '${result.service.binding.name}' does not admit installed code as a service principal.`
        );
      } else if (result.kind === "unbounded") {
        addDiagnostic(
          fact,
          `Workspace service query '${query}' could not be resolved in the exact state.`
        );
      } else {
        resolved.push({ query, service: result.service });
      }
    }
    return resolved;
  };

  const unreviewedServiceDeclarations = new Set<string>();
  for (const fact of facts) {
    const resolved = await serviceResults(fact);
    for (const { service } of resolved) {
      if (
        service.binding.notability === undefined &&
        !unreviewedServiceDeclarations.has(service.binding.name)
      ) {
        unreviewedServiceDeclarations.add(service.binding.name);
        addDiagnostic(
          fact,
          `Workspace service '${service.binding.name}' has no reviewed notability classification.`,
          `Add notability: "headline" or notability: "everyday" to the '${service.binding.name}' service declaration in meta/vibestudio.yml. Headline means a reasonable non-technical person would want to know before adding the caller; everyday means ordinary workspace machinery.`
        );
      }
      if (fact.kind === "resolution") {
        const operation = operationResource(service, fact.objectKeys);
        if (operation.unbounded) {
          addDiagnostic(
            fact,
            `The workspace service '${service.binding.name}' requires a bounded Durable Object object key for static authority analysis.`
          );
        }
        addEffect(fact, service, {
          capability: `workspace-service:${service.binding.name}`,
          tier: "gated",
          operation: "service-resolution",
          resource: operation.resource,
          providerCatalogDigest: service.catalog.digest,
          serviceName: service.binding.name,
        });
        continue;
      }

      const methodValues = literalValues(fact.methods);
      const selectedMethods: Array<[string, UserlandMethodAuthority]> = [];
      if (!methodValues) {
        const dynamic = resolveMethod(service.catalog, null);
        if (dynamic.kind === "dynamic") {
          for (const authorityEntry of dynamic.reachable) {
            if (authorityEntry.kind === "protected") {
              selectedMethods.push(["<dynamic>", authorityEntry]);
            }
          }
          if (selectedMethods.length > 0) {
            addDiagnostic(
              fact,
              `The workspace service '${service.binding.name}' is called with an unbounded method value; static authority includes every code-reachable protected method. Narrow the method to a literal union when possible.`
            );
          }
        }
      } else {
        for (const methodName of methodValues) {
          const methodResult = resolveMethod(service.catalog, methodName);
          if (methodResult.kind === "missing") {
            addDiagnostic(
              fact,
              `Workspace service '${service.binding.name}' provider '${service.binding.source}' has no RPC method '${methodName}'.`
            );
          } else if (methodResult.kind === "inaccessible") {
            addDiagnostic(
              fact,
              `RPC method '${service.binding.name}.${methodName}' is not reachable by installed code according to the provider's sealed access declaration.`
            );
          } else if (methodResult.kind === "resolved") {
            selectedMethods.push([methodName, methodResult.method]);
          }
        }
      }

      const admission = operationResource(service, fact.objectKeys);
      addEffect(fact, service, {
        capability: `workspace-service:${service.binding.name}`,
        tier: "gated",
        operation: "service-invocation",
        resource: workspaceServiceInvocationResource(service.binding, admission.keys),
        providerCatalogDigest: service.catalog.digest,
        serviceName: service.binding.name,
        ...(methodValues?.[0] ? { method: methodValues[0] } : {}),
      });

      for (const [methodName, methodAuthority] of selectedMethods) {
        if (methodAuthority.kind !== "protected") continue;
        let resource: import("@vibestudio/rpc").ResourceScope;
        if (methodAuthority.resource.kind === "receiver-object") {
          const selected = objectKeyValues(service, fact.objectKeys);
          resource = userlandReceiverResourceScope(
            methodAuthority.resource.resourceType,
            {
              source: service.binding.source,
              className:
                service.binding.target.kind === "durable-object"
                  ? service.binding.target.className
                  : "worker",
            },
            selected.keys
          );
        } else {
          const argumentIndex = methodAuthority.resource.argument;
          const argument = fact.arguments[argumentIndex];
          let handleResolved = false;
          if (argument?.kind === "service-call-result") {
            const producer = factsById.get(argument.producerCallId);
            if (producer) {
              const producerResults = await serviceResults(producer);
              for (const producerResult of producerResults) {
                const producerMethodName = literalValues(producer.methods)?.[0] ?? null;
                const producerAuthority = producerMethodName
                  ? resolveMethod(producerResult.service.catalog, producerMethodName)
                  : { kind: "missing" as const, method: "<dynamic>" };
                if (
                  producerAuthority.kind === "resolved" &&
                  producerAuthority.method.producesHandle
                ) {
                  const production = producerAuthority.method.producesHandle;
                  if (
                    sameServiceTarget(producerResult.service, service) &&
                    production.canonicalCapability === methodAuthority.canonicalCapability &&
                    production.definitionDigest === methodAuthority.definitionDigest &&
                    production.resourceType === methodAuthority.resource.resourceType
                  ) {
                    if (
                      abstractKeysCompatible(
                        producerResult.service,
                        producer.objectKeys,
                        service,
                        fact.objectKeys
                      )
                    ) {
                      handleResolved = true;
                    } else if (
                      objectKeyValues(producerResult.service, producer.objectKeys).keys &&
                      objectKeyValues(service, fact.objectKeys).keys
                    ) {
                      addDiagnostic(
                        fact,
                        `Opaque handle passed to '${service.binding.name}.${methodName}' was produced for a different receiver object; authority requests cannot make that handle valid.`
                      );
                    }
                  }
                }
              }
            }
          }
          if (!handleResolved && !methodAuthority.resource.resourceType) {
            addDiagnostic(
              fact,
              `Opaque handle resource type for '${service.binding.name}.${methodName}' is unresolved.`
            );
          }
          resource = {
            kind: "prefix",
            prefix: userlandHandleResourcePrefix(methodAuthority.resource.resourceType),
          };
          if (!handleResolved && argument?.kind !== "service-call-result") {
            addDiagnostic(
              fact,
              `The opaque handle argument for '${service.binding.name}.${methodName}' is not statically traced to a compatible provider handle.`
            );
          }
        }
        addEffect(fact, service, {
          capability: methodAuthority.canonicalCapability,
          tier: methodAuthority.tier,
          operation: "method-effect",
          resource,
          providerCatalogDigest: service.catalog.digest,
          serviceName: service.binding.name,
          ...(methodName === "<dynamic>" ? {} : { method: methodName }),
        });
      }
    }
  }

  // A resolved service call still uses the host-owned resolution facade. This
  // is intentionally added as a transport fact only for calls that exist in
  // the executable closure; direct handle invocation does not imply it.
  if (facts.some((fact) => fact.kind === "resolution")) {
    const resolutionCapability = semanticCapabilities(new Set(["service:workers.resolveService"]));
    for (const capability of resolutionCapability) {
      if (!containsCapability(authority, capability)) {
        hostDiagnostics.push({
          source: "authority",
          severity: "error",
          file: `${input.unitRelativePath}/package.json`,
          line: 1,
          column: 1,
          message: `Installed code uses capability '${capability}' but vibestudio.authority.requests does not declare it. Add the narrowest reviewed request, then rebuild this exact context.`,
          suggestion: `Add an authority request for ${JSON.stringify(capability)}; use live capability docs to select its narrowest resource scope.`,
        });
      }
    }
  }

  const effectKey = (effect: RequiredAuthorityEffect): string =>
    `${effect.capability}\0${effect.tier}\0${JSON.stringify(effect.resource)}\0${effect.packageName ?? ""}`;
  const uniqueEffects = new Map<string, RequiredAuthorityEffect>();
  for (const effect of effects) uniqueEffects.set(effectKey(effect), effect);
  for (const effect of [...uniqueEffects.values()].sort((a, b) =>
    effectKey(a).localeCompare(effectKey(b))
  )) {
    const covered = authority.requests.some((request) =>
      authorityRequestCoversEffect(request, {
        capability: effect.capability,
        tier: effect.tier,
        resource: effect.resource,
        packageName: effect.packageName,
      })
    );
    if (covered) continue;
    const origin = effect.origin;
    userlandDiagnostics.push({
      source: "authority",
      severity: "error",
      file: origin.file,
      line: origin.line,
      column: origin.column,
      message: `Calling ${effect.serviceName ?? "the workspace service"}${effect.method ? `.${effect.method}` : ""} requires '${effect.capability}' at ${effect.tier} tier, but consumer '${consumerName}' does not request a covering authority scope${effect.packageName ? ` for dependency package '${effect.packageName}'` : ""}.`,
      suggestion:
        "Add the narrowest reviewed request for this provider capability and receiver resource, or remove/narrow the call. A request is not a grant.",
    });
  }
  return [...hostDiagnostics, ...userlandDiagnostics];
}

interface RequiredAuthorityEffect {
  capability: string;
  tier: "gated" | "critical";
  operation: "service-resolution" | "service-invocation" | "method-effect";
  resource: import("@vibestudio/rpc").ResourceScope;
  providerCatalogDigest?: string;
  serviceName?: string;
  method?: string;
  packageName?: string;
  origin: WorkspaceServiceCallFact["origin"];
}
