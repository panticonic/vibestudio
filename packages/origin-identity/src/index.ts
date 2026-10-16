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
  // `git+https:` is the template system's spelling of the https transport it
  // names (templateCoordinates). Read as that URL, its host parses as a host —
  // punycoded like any other — rather than as an opaque string.
  const parsed = safeUrl(input.url.startsWith("git+") ? input.url.slice("git+".length) : input.url);
  const host = parsed ? parsed.hostname : null;
  // Host plus owner path segment: a new repository under a domain the user
  // already runs code from is not a wholly new source.
  const ownerSegment = parsed?.pathname.split("/").filter(Boolean)[0];
  const originKey = host ? (ownerSegment ? `${host}/${ownerSegment}` : host) : input.url;
  return {
    url: parsed ? repositoryUrl(parsed) : input.url,
    originKey,
    // Private suffixes matter here: acme.github.io belongs to acme, not GitHub.
    registrableDomain: host ? (getDomain(host, { allowPrivateDomains: true }) ?? host) : null,
    version: input.version === null ? null : humanRef(input.version),
    ...(input.selfName ? { selfName: input.selfName } : {}),
    isHostBuild: false,
    ...(input.isWorkspaceRoot ? { isWorkspaceRoot: true } : {}),
    firstEncounter: !input.admittedOriginKeys.has(originKey),
  };
}

/** The repository's address as people write it: `.git` is Git's suffix for it, not part of the name. */
function repositoryUrl(url: URL): string {
  return url.href.replace(/\.git\/?$/u, "");
}

/** A Git ref as people say it: the branch or tag name, not its namespace. */
function humanRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//u, "");
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
