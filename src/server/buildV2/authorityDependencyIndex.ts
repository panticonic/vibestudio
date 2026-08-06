import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import type { ExactWorkspaceAuthorityEnvironment } from "./userlandAuthority.js";
import type { WorkspaceServiceCallFact } from "./userlandAuthorityAnalyzer.js";

export interface AuthorityAnalysisEpoch {
  analyzerVersion: string;
  rpcSchemaVersion: string;
}

export interface AuthorityDependencyIndex {
  stateHash: string;
  epoch: AuthorityAnalysisEpoch;
  complete: boolean;
  consumerInputs: ReadonlyMap<
    string,
    {
      effectiveVersion: string;
      moduleClosureDigest: string;
      serviceQueries: ReadonlySet<string>;
    }
  >;
  providersByQuery: ReadonlyMap<string, { providerUnit: string; catalogDigest: string }>;
  consumersByQuery: ReadonlyMap<string, ReadonlySet<string>>;
  consumersByProviderUnit: ReadonlyMap<string, ReadonlySet<string>>;
  blockingConsumers: ReadonlySet<string>;
  digest: string;
}

export function authorityDependencyIndexDigest(
  input: Omit<AuthorityDependencyIndex, "digest">
): string {
  return sha256Canonical({
    stateHash: input.stateHash,
    epoch: input.epoch,
    complete: input.complete,
    consumerInputs: [...input.consumerInputs.entries()]
      .map(([unitName, consumer]) => [
        unitName,
        {
          effectiveVersion: consumer.effectiveVersion,
          moduleClosureDigest: consumer.moduleClosureDigest,
          serviceQueries: [...consumer.serviceQueries].sort(),
        },
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    providersByQuery: [...input.providersByQuery.entries()].sort(([a], [b]) => a.localeCompare(b)),
    consumersByQuery: [...input.consumersByQuery.entries()]
      .map(([query, consumers]) => [query, [...consumers].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
    consumersByProviderUnit: [...input.consumersByProviderUnit.entries()]
      .map(([provider, consumers]) => [provider, [...consumers].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
    blockingConsumers: [...input.blockingConsumers].sort(),
  });
}

export async function authorityDependencyIndexFromFacts(input: {
  stateHash: string;
  epoch: AuthorityAnalysisEpoch;
  consumers: readonly {
    unitName: string;
    effectiveVersion: string;
    moduleClosureDigest: string;
    facts: readonly WorkspaceServiceCallFact[];
  }[];
  environment: ExactWorkspaceAuthorityEnvironment;
  blockingConsumers?: ReadonlySet<string>;
}): Promise<AuthorityDependencyIndex> {
  const consumerInputs = new Map<
    string,
    { effectiveVersion: string; moduleClosureDigest: string; serviceQueries: ReadonlySet<string> }
  >();
  const consumersByQuery = new Map<string, Set<string>>();
  const consumersByProviderUnit = new Map<string, Set<string>>();
  const providersByQuery = new Map<string, { providerUnit: string; catalogDigest: string }>();
  for (const consumer of input.consumers) {
    const queries = new Set<string>();
    for (const fact of consumer.facts) {
      if (fact.serviceQueries.kind !== "literals") continue;
      for (const query of fact.serviceQueries.values) {
        queries.add(query);
        const byQuery = consumersByQuery.get(query) ?? new Set<string>();
        byQuery.add(consumer.unitName);
        consumersByQuery.set(query, byQuery);
      }
    }
    consumerInputs.set(consumer.unitName, {
      effectiveVersion: consumer.effectiveVersion,
      moduleClosureDigest: consumer.moduleClosureDigest,
      serviceQueries: queries,
    });
  }
  for (const binding of input.environment.services) {
    const keys = [binding.name, ...binding.protocols];
    const providerUnit = binding.source;
    // Every key is an alias of this one declared binding. Resolve its provider
    // catalog once, then project the same sealed digest to the name and all
    // protocol aliases. Besides avoiding repeated catalog work, this prevents
    // aliases from observing different transient resolution outcomes.
    const resolution = await input.environment.resolveService(binding.name);
    const catalogDigest =
      resolution.kind === "resolved" ? resolution.service.catalog.digest : "invalid";
    for (const query of keys) {
      providersByQuery.set(query, {
        providerUnit,
        catalogDigest,
      });
    }
    for (const query of keys) {
      const consumers = consumersByQuery.get(query);
      if (consumers) {
        const byProvider = consumersByProviderUnit.get(providerUnit) ?? new Set<string>();
        for (const consumer of consumers) byProvider.add(consumer);
        consumersByProviderUnit.set(providerUnit, byProvider);
      }
    }
  }
  const blockingConsumers = new Set(input.blockingConsumers ?? []);
  const withoutDigest = {
    stateHash: input.stateHash,
    epoch: input.epoch,
    complete: blockingConsumers.size === 0,
    consumerInputs,
    providersByQuery,
    consumersByQuery,
    consumersByProviderUnit,
    blockingConsumers,
  } satisfies Omit<AuthorityDependencyIndex, "digest">;
  return {
    ...withoutDigest,
    digest: authorityDependencyIndexDigest(withoutDigest),
  };
}

export function authorityConsumersForProviderChanges(
  indexes: readonly AuthorityDependencyIndex[],
  providerUnits: ReadonlySet<string>,
  changedQueries: ReadonlySet<string> = new Set()
): Set<string> {
  const consumers = new Set<string>();
  for (const index of indexes) {
    for (const provider of providerUnits) {
      for (const consumer of index.consumersByProviderUnit.get(provider) ?? [])
        consumers.add(consumer);
    }
    for (const query of changedQueries) {
      for (const consumer of index.consumersByQuery.get(query) ?? []) consumers.add(consumer);
    }
    for (const consumer of index.blockingConsumers) consumers.add(consumer);
  }
  return consumers;
}
