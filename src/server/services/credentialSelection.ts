import type { Credential, CredentialBindingUse } from "@vibestudio/credential-client/types";
import { findMatchingUrlAudience } from "@vibestudio/credential-client/urlAudience";

export interface UrlBoundCredentialStore {
  listUrlBound(): Promise<Credential[]> | Credential[];
}

/** Resolve one user-owned credential label within an exact use and URL scope. */
export async function resolveCredentialByLabel(
  store: UrlBoundCredentialStore,
  input: { label: string; url: string | URL; use: CredentialBindingUse }
): Promise<Credential | null> {
  const target = input.url instanceof URL ? input.url : new URL(input.url);
  const matches = (await Promise.resolve(store.listUrlBound())).filter(
    (credential) =>
      !credential.revokedAt &&
      credential.label === input.label &&
      credential.bindings?.some(
        (binding) =>
          binding.use === input.use && !!findMatchingUrlAudience(target, binding.audience)
      )
  );
  if (matches.length > 1) {
    throw new Error(`Credential label ${JSON.stringify(input.label)} is not unique`);
  }
  return matches[0] ?? null;
}

export async function assertCredentialLabelAvailable(
  store: UrlBoundCredentialStore,
  input: { label: string; replacingCredentialId?: string }
): Promise<void> {
  const conflict = (await Promise.resolve(store.listUrlBound())).find(
    (credential) =>
      !credential.revokedAt &&
      credential.label === input.label &&
      credential.id !== input.replacingCredentialId
  );
  if (conflict) {
    throw new Error(
      `Credential label ${JSON.stringify(input.label)} is already in use; choose a unique label`
    );
  }
}
