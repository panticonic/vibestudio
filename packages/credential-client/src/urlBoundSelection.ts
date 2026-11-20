import type { Credential, CredentialBinding, CredentialBindingUse } from "./types.js";
import { credentialCallerUse, credentialSelectionRefusal, type CredentialCallerFacts } from "./credentialActor.js";
import { findMatchingUrlAudience } from "./urlAudience.js";

type BoundCandidate = Pick<Credential,"bindings"|"label"|"revokedAt"|"actor"|"owner"|"agentExchange">;

export function findCredentialBinding(
  credential: Pick<Credential,"bindings">,
  target: URL,
  use: CredentialBindingUse,
): CredentialBinding | null {
  return credential.bindings?.find(binding =>
    binding.use === use && !!findMatchingUrlAudience(target,binding.audience)) ?? null;
}

/** The shared selection step runs before credential loading, admission or egress. */
export function matchUrlBoundCredentialCandidates<T extends BoundCandidate>(
  records: readonly T[],
  target: URL,
  use: CredentialBindingUse,
  caller: CredentialCallerFacts,
  options: { label?: string; directOnly?: boolean } = {},
) {
  const { label, directOnly = false } = options;
  const audienceMatches = records.filter(record =>
    !record.revokedAt && (label === undefined || record.label === label) && !!findCredentialBinding(record,target,use));
  const candidates = audienceMatches.filter(record => {
    const kind = credentialCallerUse(record, caller).kind;
    return directOnly ? kind === "direct" : kind !== "refused";
  });
  return { audienceMatches, candidates, refusal: credentialSelectionRefusal(audienceMatches,caller) };
}
