import type { WorkspaceServiceCallFact } from "./userlandAuthorityAnalyzer.js";

/**
 * Packages in this set implement the trusted transport/runtime mechanics behind
 * public authority-bearing APIs. Their generic dispatch calls are not consumer
 * intent; the consumer syntax that reaches those APIs is analyzed separately.
 */
export const EFFECT_IMPLEMENTATION_PACKAGES = new Set([
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

export function isEffectImplementationPackage(packageName: string): boolean {
  return EFFECT_IMPLEMENTATION_PACKAGES.has(packageName);
}

/**
 * Remove dependency-origin facts belonging to trusted effect implementations.
 * Facts authored by the consumer have no package endowment and remain visible.
 */
export function consumerAuthorityFacts(
  facts: readonly WorkspaceServiceCallFact[]
): WorkspaceServiceCallFact[] {
  return facts.filter(
    (fact) => !fact.origin.package || !isEffectImplementationPackage(fact.origin.package.name)
  );
}
