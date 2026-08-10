/**
 * Turn what a publication's producers describe into what a person reads
 * (docs/template-install-unit-approval-ux-plan.md §7, §8).
 *
 * Producers — the build system, the app host, the extension host — know units:
 * a source path, an effective version, a manifest. The review knows parts: a
 * kind with a plain-language label, one sentence of purpose, a notable line, and
 * rows with timings. This module is the single crossing between the two, so
 * every surface (creation, install, update, part-changed, launch gate) renders
 * the same unit the same way.
 *
 * Nothing here decides authority. It derives presentation from facts the
 * platform already verified, and defers every classification to
 * `installReviewRows`.
 */

import { getDomain } from "tldts";
import type { ReviewedUnit } from "../approvals.js";
import type { UnitAuthorityRequest } from "../authorityManifest.js";
import type { CapabilityPresentationResolver } from "../authorityPresentation.js";
import {
  installPartLabel,
  installReviewRows,
  type InstallBehaviorFact,
  type InstallPartKind,
  type InstallPartSurface,
  type InstallReviewOrigin,
  type InstallReviewPart,
  type UserlandDefinitions,
} from "./unitInstallReview.js";

export interface ReviewedUnitPartInput {
  unit: ReviewedUnit;
  identityKey: string;
  /** The previously admitted declaration, when this unit is being updated. */
  previousRequests?: readonly UnitAuthorityRequest[] | null;
  /** Rows the user had already cleared for the previous version (§7.3). */
  previouslyCleared?: ReadonlySet<string>;
  userlandDefinitions?: UserlandDefinitions;
  presentationFor?: CapabilityPresentationResolver;
  origin: InstallReviewOrigin;
  change?: InstallReviewPart["change"];
  section?: "template" | "repair";
  originallyInstalledFrom?: string;
}

/**
 * The human-scale name of a workspace part is its canonical repo leaf: `chat`,
 * `agent-worker`, `permissions`. Package scopes identify build artifacts and
 * are both noisier and less stable as UI copy.
 */
export function installReviewPartTitle(repoPath: string): string {
  const segments = repoPath.split("/");
  const leaf = segments.at(-1);
  if (!leaf) throw new Error(`Install-review part requires a canonical repo path: ${repoPath}`);
  return leaf;
}

/**
 * Durable Objects and services are surfaces of the Agent that hosts them, not
 * kinds of their own (§8). A DO class has no `repoPath`, so it shares its
 * worker's subject and appears nested under it.
 */
export function surfacesOf(unit: ReviewedUnit): InstallPartSurface[] {
  return (unit.authority?.provides ?? []).map((definition) => ({
    kind: "service" as const,
    name: definition.title,
  }));
}

/**
 * Behavioral facts no capability row states. A worker works without anyone
 * opening it, which is the single most useful thing to know about it; one that
 * other parts can call is reachable without being opened at all.
 */
export function behaviorsOf(
  unit: ReviewedUnit,
  surfaces: readonly InstallPartSurface[]
): InstallBehaviorFact[] {
  if (unit.unitKind !== "worker") return [];
  return surfaces.length > 0 ? ["reachable-without-opening"] : ["runs-in-background"];
}

export function reviewedUnitPart(input: ReviewedUnitPartInput): InstallReviewPart {
  const { unit } = input;
  const kind = unit.unitKind as InstallPartKind;
  const surfaces = surfacesOf(unit);
  const { notableRows, everydayRows } = installReviewRows({
    requests: unit.authority?.requests ?? [],
    ...(input.previousRequests === undefined ? {} : { previousRequests: input.previousRequests }),
    behaviors: behaviorsOf(unit, surfaces),
    // The manifest declares protocols, not providers. Carrying the resolved
    // binding lets a service row name the contract it came from alongside the
    // provider currently filling it.
    ...(unit.authority?.serviceBindings ? { serviceBindings: unit.authority.serviceBindings } : {}),
    ...(input.userlandDefinitions ? { userlandDefinitions: input.userlandDefinitions } : {}),
    ...(input.presentationFor ? { presentationFor: input.presentationFor } : {}),
    ...(input.previouslyCleared ? { previouslyCleared: input.previouslyCleared } : {}),
    ...(input.section ? { section: input.section } : {}),
  });
  return {
    identityKey: input.identityKey,
    kind,
    label: installPartLabel(kind, surfaces),
    surfaces,
    name: unit.unitName,
    ...(unit.displayName?.trim() ? { displayName: unit.displayName.trim() } : {}),
    ...(unit.icon?.trim() ? { icon: unit.icon.trim() } : {}),
    title: installReviewPartTitle(unit.source.repo),
    purpose: unit.purpose ?? "",
    repoPath: unit.source.repo,
    effectiveVersion: unit.ev ?? "",
    version: unit.version ?? null,
    requiredUnitKeys: Object.keys(unit.dependencyEvs ?? {}),
    runsInBackground: unit.unitKind === "worker",
    ...(unit.target === undefined ? {} : { target: unit.target }),
    origin: input.origin,
    notableRows,
    everydayRows,
    change: input.change ?? "added",
    section: input.section ?? "template",
    ...(input.originallyInstalledFrom
      ? { originallyInstalledFrom: input.originallyInstalledFrom }
      : {}),
  };
}

/**
 * The origin of the host's own build.
 *
 * The one place a name may stand in for a URL: the host naming its own origin
 * is a build vouching for itself, not a claim about a third party (§7.6.3).
 */
export function hostBuildOrigin(version: string | null): InstallReviewOrigin {
  return {
    url: null,
    originKey: "vibestudio",
    registrableDomain: null,
    version,
    isHostBuild: true,
    isWorkspaceRoot: true,
    firstEncounter: false,
  };
}

/**
 * Provenance could not be resolved. This is deliberately distinct from the
 * host build: an unavailable source must never be presented as Vibestudio code.
 */
export function unresolvedOrigin(): InstallReviewOrigin {
  return {
    url: null,
    originKey: "source unavailable",
    registrableDomain: null,
    version: null,
    isHostBuild: false,
    originStatus: "unresolved",
    firstEncounter: false,
  };
}

/** A merged repository whose file-level provenance names multiple templates. */
export function multipleTemplateContributorsOrigin(): InstallReviewOrigin {
  return {
    url: null,
    originKey: "multiple template contributions",
    registrableDomain: null,
    version: null,
    isHostBuild: false,
    originStatus: "multiple-template-contributors",
    firstEncounter: false,
  };
}

/**
 * Where bytes came from, from a template pin.
 *
 * There is no publisher identity, so the URL is the identity: it is never
 * abbreviated away, internationalized domains render as punycode, and the
 * template's self-given name is carried separately so it can only ever appear
 * as a title.
 *
 * Two things this deliberately does NOT do.
 *
 * It does not rewrite the URL. The previous form rebuilt it from protocol, host
 * and path, which silently dropped a non-default port and every other authority
 * component — so two different sources could print as the same identity string.
 * `URL` already punycodes the host on parse, so `href` is the ASCII form a
 * person reads, with nothing removed.
 *
 * It does not guess the registrable domain. `registrableDomain` is the real
 * boundary, from the public suffix list `tldts` ships — never "the last two
 * labels", which is wrong for `co.uk` and every other multi-label suffix, and
 * which would emphasize `com.attacker` inside `github.com.attacker.net`. The
 * emphasis this field drives is the whole defence against a lookalike host, so
 * a wrong answer here is worse than no emphasis at all.
 *
 * `allowPrivateDomains` is on deliberately. The private section of the list is
 * where one operator hands out names to strangers — `acme.github.io`,
 * `acme.pages.dev` — and there the boundary a person must judge is the label
 * the stranger holds, not the operator's domain. Emphasizing `github.io` in
 * `acme.github.io` would say "this is GitHub's" about a name anyone can take.
 *
 * A host with no suffix at all — an IP literal, `localhost`, a single label —
 * gets the whole host, which is exactly right: there is no narrower boundary,
 * and the whole host is then what gets emphasized.
 */
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
