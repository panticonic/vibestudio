import { getDomain } from "tldts";
import type { InstallReviewOrigin } from "@vibestudio/shared/authority/unitInstallReview";

/** Derive the exact user-visible identity of a pinned template origin. */
export function templateOrigin(input: {
  url: string;
  version: string | null;
  selfName?: string;
  admittedOriginKeys: ReadonlySet<string>;
  isWorkspaceRoot?: boolean;
}): InstallReviewOrigin {
  const parsed = safeUrl(input.url);
  const host = parsed ? parsed.hostname : null;
  // Host plus owner path segment: a new repository under a domain the user
  // already runs code from is not a wholly new source.
  const ownerSegment = parsed?.pathname.split("/").filter(Boolean)[0];
  const originKey = host ? (ownerSegment ? `${host}/${ownerSegment}` : host) : input.url;
  return {
    url: parsed ? parsed.href : input.url,
    originKey,
    // Private suffixes matter here: acme.github.io belongs to acme, not GitHub.
    registrableDomain: host ? (getDomain(host, { allowPrivateDomains: true }) ?? host) : null,
    version: input.version,
    ...(input.selfName ? { selfName: input.selfName } : {}),
    isHostBuild: false,
    ...(input.isWorkspaceRoot ? { isWorkspaceRoot: true } : {}),
    firstEncounter: !input.admittedOriginKeys.has(originKey),
  };
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
