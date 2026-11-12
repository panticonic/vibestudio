import type { Credential, CredentialBindingUse } from "@vibestudio/credential-client/types";
import {
  credentialCallerUse,
  type CredentialCallerFacts,
} from "@vibestudio/credential-client/credentialActor";
import { findMatchingUrlAudience } from "@vibestudio/credential-client/urlAudience";

export interface UrlBoundCredentialStore {
  listUrlBound(): Promise<Credential[]> | Credential[];
}

/**
 * Resolve one user-owned credential label within an exact use and URL scope.
 * With `caller`, personal (human-attributed) credentials of other members are
 * not candidates, so each member's same-labelled credential resolves to their own.
 */
export async function resolveCredentialByLabel(
  store: UrlBoundCredentialStore,
  input: {
    label: string;
    url: string | URL;
    use: CredentialBindingUse;
    caller?: CredentialCallerFacts;
  }
): Promise<Credential | null> {
  const target = input.url instanceof URL ? input.url : new URL(input.url);
  const matches = (await Promise.resolve(store.listUrlBound())).filter(
    (credential) =>
      !credential.revokedAt &&
      credential.label === input.label &&
      (input.caller === undefined ||
        credentialCallerUse(credential, input.caller).kind === "direct") &&
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

/**
 * Labels are the portable name userland selects credentials by. A
 * human-attributed credential is personal, so each member may hold their own
 * under the same label (e.g. every member's "Namlu"); selection then picks the
 * acting member's. Every other label is unique across the store.
 */
export async function assertCredentialLabelAvailable(
  store: UrlBoundCredentialStore,
  input: {
    label: string;
    replacingCredentialId?: string;
    actor?: Credential["actor"];
    ownerUserId?: string;
  }
): Promise<void> {
  const personal = (credential: Pick<Credential, "actor">) => credential.actor === "human";
  const conflict = (await Promise.resolve(store.listUrlBound())).find(
    (credential) =>
      !credential.revokedAt &&
      credential.label === input.label &&
      credential.id !== input.replacingCredentialId &&
      !(
        personal(credential) &&
        personal(input) &&
        credential.owner?.userId !== undefined &&
        input.ownerUserId !== undefined &&
        credential.owner.userId !== input.ownerUserId
      )
  );
  if (conflict) {
    throw new Error(
      `Credential label ${JSON.stringify(input.label)} is already in use; choose a unique label`
    );
  }
}
