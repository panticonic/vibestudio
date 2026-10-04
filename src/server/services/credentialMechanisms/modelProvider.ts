import type { OAuthAuth, OAuthCredential } from "@panticonic/pi-ai";
import type { Credential } from "@vibestudio/credential-client/types";
import { findMatchingUrlAudience } from "@vibestudio/credential-client/urlAudience";

/** Pi owns provider-specific device login, token minting, and renewal. */
export async function modelProviderOAuth(providerId: string): Promise<OAuthAuth> {
  // The host's Electron utility process is CommonJS; Pi publishes only ESM
  // import conditions. Keep provider loading at that native module boundary.
  const { builtinProviders } = await import("@panticonic/pi-ai/providers/all");
  const auth = builtinProviders().find((provider) => provider.id === providerId)?.auth?.oauth;
  if (!auth) throw new Error(`Subscription sign-in is unavailable for ${providerId}`);
  return auth;
}

export async function modelProviderMaterial(providerId: string, credential: OAuthCredential) {
  const { builtinProviders } = await import("@panticonic/pi-ai/providers/all");
  const provider = builtinProviders().find((entry) => entry.id === providerId)!;
  const auth = await (await modelProviderOAuth(providerId)).toAuth(credential);
  const headers = new Headers(
    Object.fromEntries(
      Object.entries(auth.headers ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    )
  );
  const bearer = headers.get("authorization");
  const token = auth.apiKey ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : undefined);
  if (!token) throw new Error(`Unsupported request authentication for ${providerId}`);
  return {
    token,
    baseUrl: auth.baseUrl,
    ...(provider.filterModels
      ? {
          allowedModelIds: provider
            .filterModels(provider.getModels(), credential)
            .map((model) => model.id),
        }
      : {}),
  };
}

export async function refreshModelProviderCredential(credential: Credential & { id: string }) {
  const session = credential.modelProviderSession!;
  const renewed = await (
    await modelProviderOAuth(session.providerId)
  ).refresh(session.credential, AbortSignal.timeout(60_000));
  const material = await modelProviderMaterial(session.providerId, renewed);
  const audiences = credential.bindings?.flatMap((binding) => binding.audience) ?? [];
  if (material.baseUrl && !findMatchingUrlAudience(material.baseUrl, audiences)) {
    throw new Error(
      "The provider endpoint changed. Reconnect this provider to approve the new endpoint."
    );
  }
  return {
    ...credential,
    accessToken: material.token,
    expiresAt: renewed.expires,
    modelProviderSession: { providerId: session.providerId, credential: renewed },
    metadata: {
      ...credential.metadata,
      ...(material.baseUrl ? { modelBaseUrl: material.baseUrl } : {}),
      ...(material.allowedModelIds
        ? { modelAvailableIds: JSON.stringify(material.allowedModelIds) }
        : {}),
    },
  };
}
