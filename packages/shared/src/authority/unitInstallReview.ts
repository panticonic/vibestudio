/**
 * The one review surface every arrival of code shares
 * (docs/template-install-unit-approval-ux-plan.md §7).
 *
 * Creating a workspace from a template, installing one, updating one, and
 * accepting an edit to a part already present are the same decision with the
 * same rows and the same copy. This module owns the typed contract they share:
 * what a part is, what a row is, when it applies, and what accepting one means.
 *
 * Two words are used consistently and never interchanged (U5):
 *
 *   admission — this exact part version was reviewed and accepted. Every part an
 *               accepted operation lands is admitted, selected or not.
 *   clearance — a standing grant, minted at admission, for the part of the
 *               manifest platform policy allows to be pre-authorized.
 *
 * Selecting a part or a permission means "allow this now". Deselecting it means
 * "ask me when it's needed". Nothing is disabled and nothing is withheld from
 * the workspace.
 */

import type { AuthorityRow } from "./authorityRows.js";
import { authorityRow } from "./authorityRows.js";
import { AUTHORITY_DOMAINS } from "./authorityDomains.js";
import { capabilityNotability, reviewedCapabilityNotability } from "./capabilityNotability.js";
import type { CapabilityNotability } from "./capabilityNotability.js";
import { capabilityClearancePolicy } from "./capabilityClearance.js";
import type { UnitAuthorityRequest, UserlandCapabilityDefinition } from "../authorityManifest.js";
import type { CapabilityPresentationResolver } from "../authorityPresentation.js";

/** The four kinds of executable unit a review can present. */
export type InstallPartKind = "panel" | "worker" | "app" | "extension";

/**
 * The user-facing noun. A worker splits by a computable test rather than by
 * judgment: one that declares a service or Durable Object surface is a Service,
 * one that declares none is an Agent.
 */
export type InstallPartLabel = "Panel" | "Agent" | "Service" | "Client App" | "Extension";

export const INSTALL_PART_LABEL_COPY: Record<InstallPartLabel, string> = {
  Panel: "Something you open and look at",
  Agent: "Something that works on its own",
  Service: "Something other parts rely on",
  "Client App": "The desktop, mobile, or terminal app itself",
  Extension: "Native code that adds an ability to the host",
};

/** Durable Objects and services are surfaces of the Agent that hosts them, not kinds. */
export interface InstallPartSurface {
  kind: "durable-object" | "service";
  name: string;
}

export function installPartLabel(
  kind: InstallPartKind,
  surfaces: readonly InstallPartSurface[]
): InstallPartLabel {
  switch (kind) {
    case "panel":
      return "Panel";
    case "app":
      return "Client App";
    case "extension":
      return "Extension";
    case "worker":
      return surfaces.length > 0 ? "Service" : "Agent";
  }
}

/**
 * When a row applies. The timing line carries the whole meaning of a row that
 * this decision cannot pre-authorize, which is why it lives on the row rather
 * than in a section heading.
 */
export type InstallRowTiming = "on-add" | "asks-when-needed" | "asks-every-time" | "behavioral";

export const INSTALL_ROW_TIMING_COPY: Record<InstallRowTiming, string | null> = {
  // Cleared at install: no second line; it simply works once added.
  "on-add": null,
  "asks-when-needed": "Asks when it needs one, and you pick which.",
  "asks-every-time": "Asks every time, showing exactly what.",
  // A behavioral row states its own timing in its detail line, and the fact
  // differs per row: a service is reachable without being opened, a worker runs
  // on its own. One fixed sentence here claimed a schedule for both, and
  // contradicted the detail immediately above it.
  behavioral: null,
};

/**
 * Behavioral facts matter to users and no capability row states them, so the
 * review contributes them itself. They are always headline and never selectable.
 */
export type InstallBehaviorFact =
  | "runs-in-background"
  | "runs-on-schedule"
  | "reachable-without-opening";

export const INSTALL_BEHAVIOR_COPY: Record<
  InstallBehaviorFact,
  { action: string; detail: string }
> = {
  "runs-in-background": {
    action: "Works on its own",
    detail: "Runs in the background, without you opening anything.",
  },
  "runs-on-schedule": {
    action: "Works on its own",
    detail: "Runs in the background on a schedule, without you opening anything.",
  },
  "reachable-without-opening": {
    action: "Other parts can reach it",
    detail: "Other parts can use it without you opening anything.",
  },
};

/** Differential sign, present only in update mode (§5.4). */
export type InstallRowChange = "added" | "removed" | "retiered";

interface InstallReviewRowBase {
  /** Stable key used by the acceptance payload and by the server validator. */
  key: string;
  timing: InstallRowTiming;
  notability: CapabilityNotability;
  /**
   * Only install-clearable rows carry a checkbox. Contextual and critical rows
   * are disclosures: a checkbox would promise something this decision cannot
   * deliver and the server would refuse it.
   */
  selectable: boolean;
  /** Pre-checked state for a selectable row. */
  selectedByDefault: boolean;
  change?: InstallRowChange;
}

/**
 * Which provider currently fills a declared protocol.
 *
 * A unit declares service dependencies by stable protocol, so its manifest
 * names a contract rather than an implementation. That keeps the declaration
 * stable across provider changes, but it also means the manifest alone cannot
 * answer "who does this talk to today". This is the resolved answer for one
 * exact workspace state, carried next to the row the user actually reads.
 */
export interface ServiceBindingFact {
  protocol: string;
  availability: "required" | "optional";
  /** Null when no provider currently implements the declared protocol. */
  serviceName: string | null;
  providerUnit: string | null;
  catalogDigest: string | null;
}

export interface InstallReviewPermissionRow extends InstallReviewRowBase {
  kind: "permission";
  row: AuthorityRow;
  /**
   * Present on `workspace-service:` rows whose provider resolved from a
   * declared protocol. The row's own copy names the concrete service; this
   * records the contract it was reached through.
   */
  binding?: ServiceBindingFact;
}

export interface InstallReviewBehaviorRow extends InstallReviewRowBase {
  kind: "behavior";
  fact: InstallBehaviorFact;
  timing: "behavioral";
  notability: "headline";
  selectable: false;
  selectedByDefault: false;
}

export type InstallReviewRow = InstallReviewPermissionRow | InstallReviewBehaviorRow;

/** The stable identity of a permission row within one review. */
export function installRowKey(input: {
  capability: string;
  resourceScope: AuthorityRow["resourceScope"];
}): string {
  return `${input.capability}\0${JSON.stringify(input.resourceScope)}`;
}

/**
 * The receiver definitions an operation carries, keyed by the fully-qualified
 * `workspace-service:<name>` capability.
 *
 * A receiver-declared capability is classified when its provider is part of the
 * same reviewed set — the user is accepting the receiver and its declaration in
 * one decision. Anything else is unreviewed, and therefore contextual and
 * headline (§6.1).
 */
export type UserlandDefinitions = ReadonlyMap<string, UserlandCapabilityDefinition>;

export interface InstallReviewRowsInput {
  requests: readonly UnitAuthorityRequest[];
  /** The previously admitted declaration, for differential review (§5.4, U7). */
  previousRequests?: readonly UnitAuthorityRequest[] | null;
  /** Behavioral facts the review contributes itself; always headline (§10). */
  behaviors?: readonly InstallBehaviorFact[];
  userlandDefinitions?: UserlandDefinitions;
  /**
   * Protocol declarations resolved against one exact workspace state, so a
   * service row can name the contract it came from as well as the provider
   * currently filling it.
   */
  serviceBindings?: readonly ServiceBindingFact[];
  /** Exact workspace declarations for dynamic service envelopes. */
  presentationFor?: CapabilityPresentationResolver;
  /**
   * Rows the user had already cleared for the previous version. An update
   * re-mints exactly this ∩ the new manifest ∩ current policy, so a permission
   * declined once stays declined without being declined again (§7.3).
   */
  previouslyCleared?: ReadonlySet<string>;
  /**
   * A repair is a change the user did not ask for, arriving inside an operation
   * about something else, so its new authority defaults to unchecked (§5.3).
   */
  section?: "template" | "repair";
}

export interface InstallReviewRows {
  notableRows: InstallReviewRow[];
  everydayRows: InstallReviewRow[];
}

/**
 * Turn one unit's declared authority into the rows every review surface reads.
 *
 * The unit author decides nothing here (U4): the platform derives the timing,
 * the clearance partition, and the notability split, and a receiver's own
 * declaration acts only as a ceiling and a vocabulary.
 */
export function installReviewRows(input: InstallReviewRowsInput): InstallReviewRows {
  const previousByKey = new Map(
    (input.previousRequests ?? []).map((request) => [requestKey(request), request])
  );
  const isUpdate = input.previousRequests !== undefined && input.previousRequests !== null;
  const notableRows: InstallReviewRow[] = [];
  const everydayRows: InstallReviewRow[] = [];
  // Keyed by the concrete capability the fold derived from each protocol, which
  // is what a permission row carries.
  const bindingByCapability = new Map<string, ServiceBindingFact>(
    (input.serviceBindings ?? [])
      .filter((binding) => binding.serviceName !== null)
      .map((binding) => [`workspace-service:${binding.serviceName}`, binding] as const)
  );

  for (const request of input.requests) {
    const key = requestKey(request);
    const previous = previousByKey.get(key);
    previousByKey.delete(key);
    const row = buildPermissionRow({
      request,
      key,
      userlandDefinitions: input.userlandDefinitions,
      presentationFor: input.presentationFor,
      binding: bindingByCapability.get(request.capability),
      change: !isUpdate
        ? undefined
        : !previous
          ? "added"
          : previous.tier !== request.tier
            ? "retiered"
            : undefined,
      // An install allows everything by default, so one click adds the complete
      // slate. An update carries forward exactly what was cleared before, and a
      // newly declared permission the user did just ask for is offered checked
      // — except in a repair section, which they did not ask for at all.
      selectedByDefault:
        input.section === "repair"
          ? false
          : !isUpdate || !previous
            ? true
            : (input.previouslyCleared?.has(key) ?? false),
    });
    (row.notability === "headline" ? notableRows : everydayRows).push(row);
  }

  // Whatever the new manifest dropped: shown with its sign, never selectable.
  for (const [key, request] of previousByKey) {
    const row = buildPermissionRow({
      request,
      key,
      userlandDefinitions: input.userlandDefinitions,
      presentationFor: input.presentationFor,
      binding: bindingByCapability.get(request.capability),
      change: "removed",
      selectedByDefault: false,
      removed: true,
    });
    (row.notability === "headline" ? notableRows : everydayRows).push(row);
  }

  for (const fact of input.behaviors ?? []) {
    notableRows.push({
      kind: "behavior",
      key: `behavior:${fact}`,
      fact,
      timing: "behavioral",
      notability: "headline",
      selectable: false,
      selectedByDefault: false,
    });
  }

  notableRows.sort(compareRows);
  everydayRows.sort(compareRows);
  return { notableRows, everydayRows };
}

function buildPermissionRow(input: {
  request: UnitAuthorityRequest;
  key: string;
  userlandDefinitions: UserlandDefinitions | undefined;
  presentationFor: CapabilityPresentationResolver | undefined;
  binding?: ServiceBindingFact | undefined;
  change: InstallRowChange | undefined;
  selectedByDefault: boolean;
  removed?: boolean;
}): InstallReviewPermissionRow {
  const { request } = input;
  const definition = input.userlandDefinitions?.get(request.capability);
  const declaredPresentation = input.presentationFor?.(request.capability);
  const declaredServiceReview =
    request.capability.startsWith("workspace-service:") &&
    declaredPresentation?.notability !== undefined
      ? declaredPresentation
      : undefined;
  const row = authorityRow({
    capability: request.capability,
    resource: request.resource,
    tier: request.tier,
    statement: "declared",
    provenance: { source: definition || declaredServiceReview ? "receiver" : "manifest" },
    degradeUnknown: true,
    ...(definition
      ? { category: definition.presentation, reviewedAction: definition.action }
      : declaredServiceReview?.authorityCategory
        ? {
            category: declaredServiceReview.authorityCategory,
            reviewedAction: declaredServiceReview.action,
          }
        : {}),
    ...(input.change === "added"
      ? { flags: { newInDiff: true } }
      : input.change === "removed"
        ? { flags: { removedInDiff: true } }
        : {}),
  });
  // Unreviewed means unknown, and unknown is never quietly granted or quietly
  // hidden: contextual for clearance, headline for display (§6.1, §10).
  const reviewed =
    row.unrecognized !== true &&
    (definition !== undefined ||
      declaredServiceReview !== undefined ||
      reviewedCapabilityNotability(request.capability) !== null);
  const policy = capabilityClearancePolicy({
    capability: request.capability,
    resource: request.resource,
    tier: request.tier,
    reviewed,
    ...(definition
      ? {
          declaration: { sensitivity: definition.sensitivity, localName: definition.name },
          // The receiver's own scope vocabulary, translated into the two
          // reusable scopes clearance policy knows about. It is a ceiling: the
          // platform may offer less than the provider allows, never more.
          declaredReusableScopes: definition.grantScopes.flatMap((scope) =>
            scope === "task"
              ? ["task" as const]
              : scope === "version"
                ? ["unit-version" as const]
                : []
          ),
        }
      : {}),
  });
  const timing: InstallRowTiming =
    request.tier === "critical"
      ? "asks-every-time"
      : policy.clearance === "install"
        ? "on-add"
        : "asks-when-needed";
  const notability: CapabilityNotability = row.unrecognized
    ? "headline"
    : capabilityNotability({
        capability: request.capability,
        tier: request.tier,
        ...(definition
          ? { declared: definition.notability }
          : declaredServiceReview
            ? { declared: declaredServiceReview.notability }
            : {}),
      });
  const selectable = timing === "on-add" && input.removed !== true;
  return {
    kind: "permission",
    key: input.key,
    row,
    timing,
    notability,
    selectable,
    selectedByDefault: selectable && input.selectedByDefault,
    ...(input.change ? { change: input.change } : {}),
    ...(input.binding ? { binding: input.binding } : {}),
  };
}

function requestKey(request: UnitAuthorityRequest): string {
  return installRowKey({ capability: request.capability, resourceScope: request.resource });
}

/**
 * Within a group, what changed comes first, then what always confirms, then
 * what asks at use, then what simply works — the order a person scans for
 * "what is different and what should I worry about".
 */
function compareRows(left: InstallReviewRow, right: InstallReviewRow): number {
  const rank = (row: InstallReviewRow): number => {
    if (row.change === "added") return 0;
    if (row.change === "retiered") return 1;
    if (row.change === "removed") return 2;
    if (row.timing === "asks-every-time") return 3;
    if (row.timing === "behavioral") return 4;
    if (row.timing === "asks-when-needed") return 5;
    return 6;
  };
  const delta = rank(left) - rank(right);
  if (delta !== 0) return delta;
  return installRowHeadline(left).localeCompare(installRowHeadline(right));
}

/**
 * Where bytes came from, at human scale.
 *
 * There is no publisher identity in this system, so the origin URL is the
 * identity (§7.6.3). A template's self-given name is carried separately and may
 * only be rendered in a slot that obviously belongs to the template — never in a
 * `From X` position that reads as a verified publisher. No commit id or content
 * digest appears here, because none may appear on any review surface.
 */
export interface InstallReviewOrigin {
  /** Full origin URL, never abbreviated away. Null for host or unresolved sources. */
  url: string | null;
  /** The registrable domain plus owner path segment; the first-encounter key. */
  originKey: string;
  /** Punycode-rendered registrable domain, emphasized within the URL. */
  registrableDomain: string | null;
  /** Human version tag (`v1.2.0`), never a commit id. */
  version: string | null;
  /** Self-asserted, unverified. Rendered only as a template-attributed title. */
  selfName?: string;
  /** True only for the host's own base, whose URL ships in the host build. */
  isHostBuild: boolean;
  /**
   * This source is the workspace root, proven by the creation descriptor or
   * the trusted host bootstrap. Never inferred from how many units it owns.
   */
  isWorkspaceRoot?: boolean;
  /** Present when the server could not prove where the bytes came from. */
  originStatus?: "unresolved";
  /** The user has not run code from this origin before. A fact, not a judgment. */
  firstEncounter: boolean;
}

/** Verified source facts that may be persisted with an admission. */
export interface UnitInstallSourceOrigin {
  originKey: string;
  url: string | null;
  version?: string | null;
  selfName?: string | null;
  isWorkspaceRoot?: boolean;
}

/** One run of an identity string, marked for whether it carries the emphasis. */
export interface OriginTextSegment {
  text: string;
  emphasized: boolean;
}

/**
 * The registrable domain, stated as a fact rather than as typography.
 *
 * Emphasis inside a URL is visual, and three readers never see it: a screen
 * reader, a monochrome display used by someone who cannot resolve weight, and
 * any plain-text surface (the terminal launch gate, the terminal overlay).
 * Rather than fake bold with punctuation there, every surface states the same
 * short fact, so the terminal and the window carry the identical claim and the
 * only difference is that the window ALSO shows it in place.
 *
 * It is a label and a value, deliberately: nothing here characterizes the
 * domain, because we know nothing about it beyond where the bytes came from.
 */
export function originDomainFact(origin: InstallReviewOrigin): string | null {
  // The host's own build has no URL to disambiguate, and naming a domain for it
  // would invent an identity claim the build does not make.
  if (origin.isHostBuild || origin.originStatus === "unresolved" || !origin.registrableDomain) {
    return null;
  }
  return `Domain: ${origin.registrableDomain}`;
}

/**
 * Split a string that a user reads as identity so the registrable domain can be
 * emphasized WITHIN it (§7.6.3), never instead of it.
 *
 * The threat this exists for: a person cannot tell `github.com/acme` from
 * `github.com/acme-studio`, and — far worse — reads `github.com.attacker.net`
 * as GitHub. So the emphasis must land on `attacker.net` and must never land on
 * `github.com` there. Two rules get that right:
 *
 *   the domain is only ever matched inside the URL's AUTHORITY. A path may
 *     contain anything, including the domain's own text (`gitlab.com/gitlab.com`
 *     is a real shape), and emphasizing a path segment would move the reader's
 *     eye off the only part of the string that says who this is;
 *   within the authority it must be a SUFFIX of the host, on a label boundary,
 *     which is what makes `github.com.attacker.net` emphasize its tail and
 *     nothing else.
 *
 * `text` may be the bare URL or a sentence containing it, so the same function
 * serves a source row and `This workspace is built from code at <url>.` When the
 * URL is absent, or the domain cannot be located as a host suffix, the whole
 * string comes back unemphasized — no emphasis is always better than emphasis in
 * the wrong place.
 */
export function originTextSegments(text: string, origin: InstallReviewOrigin): OriginTextSegment[] {
  const plain = [{ text, emphasized: false }];
  const url = origin.url;
  const domain = origin.registrableDomain;
  if (!url || !domain) return plain;
  const urlStart = text.indexOf(url);
  if (urlStart < 0) return plain;

  // The authority: after `scheme://`, up to the first `/`, `?` or `#`.
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return plain;
  const authorityStart = schemeEnd + 3;
  const pathStart = url.slice(authorityStart).search(/[/?#]/u);
  const authorityEnd = pathStart < 0 ? url.length : authorityStart + pathStart;
  const authority = url.slice(authorityStart, authorityEnd);
  // Userinfo can contain anything at all, including a whole other hostname, so
  // the host starts after the last `@`. A port and an IPv6 literal are trimmed
  // the same way a browser's origin display trims them: they are not the domain.
  const hostStart = authorityStart + authority.lastIndexOf("@") + 1;
  let hostEnd = authorityEnd;
  const afterAt = url.slice(hostStart, authorityEnd);
  if (afterAt.startsWith("[")) {
    // An IPv6 literal is full of colons; only the one after `]` is a port.
    const bracket = afterAt.indexOf("]");
    if (bracket >= 0) hostEnd = hostStart + bracket + 1;
  } else {
    const colon = afterAt.lastIndexOf(":");
    if (colon >= 0) hostEnd = hostStart + colon;
  }
  let host = url.slice(hostStart, hostEnd);
  // A fully qualified `example.com.` is the same host as `example.com`; the
  // trailing dot is part of the emphasis, not a reason to skip it.
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host !== domain && !host.endsWith(`.${domain}`)) return plain;

  const start = urlStart + hostStart + (host.length - domain.length);
  const end = start + domain.length;
  return [
    { text: text.slice(0, start), emphasized: false },
    { text: text.slice(start, end), emphasized: true },
    { text: text.slice(end), emphasized: false },
  ].filter((segment) => segment.text.length > 0);
}

export type InstallPartChange = "added" | "removed" | "changed" | "unchanged";

/**
 * A part the operation lands, with everything the review needs to render it.
 *
 * `title` is the concise, platform-derived repo leaf (`chat`, `agent-worker`);
 * the template supplies `purpose`. Identity, dependency closure, rows, the
 * clearance partition, and the notability split are derived and verified by
 * the platform (U4) — a unit author never decides whether their own effects
 * clear at install or count as notable.
 */
export interface InstallReviewPart {
  identityKey: string;
  kind: InstallPartKind;
  label: InstallPartLabel;
  /** Durable Objects and services this part hosts, shown nested under it. */
  surfaces: InstallPartSurface[];
  name: string;
  /** Human-facing label for navigation results; absent in older payloads. */
  displayName?: string;
  title: string;
  purpose: string;
  repoPath: string;
  effectiveVersion: string;
  /** Human version, when the part declares one. */
  version: string | null;
  requiredUnitKeys: string[];
  runsInBackground: boolean;
  /** Which host a client app targets. Absent for panels, workers, and extensions. */
  target?: "electron" | "react-native" | "terminal" | null;
  origin: InstallReviewOrigin;
  /** Every headline row plus every behavioral fact. Never truncated. */
  notableRows: InstallReviewRow[];
  /** Everything else, rendered one level down. */
  everydayRows: InstallReviewRow[];
  change: InstallPartChange;
  /**
   * `template` — a part this operation's template owns.
   * `repair` — an agent-authored fix to a part already in the workspace, shipped
   *   in the same publication (§5.3). Always shown, never folded away.
   */
  section: "template" | "repair";
  /** Set once a part has been installed before: `Originally installed from News 1.2.0`. */
  originallyInstalledFrom?: string;
}

export type UnitInstallReviewMode = "adopt-root" | "install" | "update" | "remove" | "part-changed";

export interface InstallReviewTemplate {
  title: string;
  purpose: string;
  origin: InstallReviewOrigin;
  fromVersion: string | null;
  toVersion: string | null;
}

/** Counts by label for the header line: `23 panels · 14 agents and services · …`. */
export interface InstallReviewSummary {
  panels: number;
  agents: number;
  services: number;
  clientApps: number;
  extensions: number;
}

export function summarizeParts(
  parts: readonly InstallReviewPart[],
  options: { includeRemoved?: boolean } = {}
): InstallReviewSummary {
  const summary: InstallReviewSummary = {
    panels: 0,
    agents: 0,
    services: 0,
    clientApps: 0,
    extensions: 0,
  };
  for (const part of parts) {
    if (part.change === "removed" && !options.includeRemoved) continue;
    switch (part.label) {
      case "Panel":
        summary.panels += 1;
        break;
      case "Agent":
        summary.agents += 1;
        break;
      case "Service":
        summary.services += 1;
        break;
      case "Client App":
        summary.clientApps += 1;
        break;
      case "Extension":
        summary.extensions += 1;
        break;
    }
  }
  return summary;
}

/**
 * Accepting a review.
 *
 * Every part of the template is always installed; `allowNow` decides only what
 * is pre-authorized. There is no "install a subset" result, because there is no
 * mechanism behind one (U5).
 */
export interface TemplateAcceptance {
  decision: "install" | "update" | "adopt-root";
  allowNow: Array<{
    identityKey: string;
    /** Row keys to clear. Absent means every install-clearable row for the part. */
    permissions?: string[];
  }>;
}

export type TemplateInstallResolution = TemplateAcceptance | { decision: "cancel" };

/**
 * The footer status line, restated in plain terms and updated live (§7.2):
 *
 *   3 parts · everything allowed now
 *   3 parts · 1 will ask before it does 2 things
 *   3 parts · 1 will ask before anything
 */
export function selectionStatusLine(input: {
  parts: readonly InstallReviewPart[];
  allowNow: TemplateAcceptance["allowNow"];
}): string {
  const installed = input.parts.filter((part) => part.change !== "removed");
  const partCount = installed.length;
  const partWord = `${partCount} part${partCount === 1 ? "" : "s"}`;
  const byKey = new Map(input.allowNow.map((entry) => [entry.identityKey, entry]));

  let fullyAsking = 0;
  let partiallyAsking = 0;
  let withheldRows = 0;
  for (const part of installed) {
    const clearable = [...part.notableRows, ...part.everydayRows].filter((row) => row.selectable);
    if (clearable.length === 0) continue;
    const entry = byKey.get(part.identityKey);
    if (!entry) {
      fullyAsking += 1;
      continue;
    }
    if (!entry.permissions) continue;
    const allowed = new Set(entry.permissions);
    const missing = clearable.filter((row) => !allowed.has(row.key)).length;
    if (missing === 0) continue;
    if (missing === clearable.length) fullyAsking += 1;
    else {
      partiallyAsking += 1;
      withheldRows += missing;
    }
  }

  if (fullyAsking === 0 && partiallyAsking === 0) return `${partWord} · everything allowed now`;
  if (fullyAsking > 0 && partiallyAsking === 0) {
    return `${partWord} · ${fullyAsking} will ask before anything`;
  }
  if (fullyAsking === 0) {
    return `${partWord} · ${partiallyAsking} will ask before ${
      withheldRows === 1 ? "it does 1 thing" : `it does ${withheldRows} things`
    }`;
  }
  return `${partWord} · ${fullyAsking} will ask before anything, ${partiallyAsking} before some things`;
}

/**
 * The row's one-line notable summary, used by the list row and by the launch
 * gate so the same unit reads the same way on both surfaces.
 *
 * A part with no headline rows states its ordinary footprint rather than
 * claiming innocence.
 */
export function partNotableLine(part: InstallReviewPart): string {
  const everydayCount = part.everydayRows.length;
  if (part.notableRows.length === 0) {
    return everydayCount === 0
      ? "Nothing unusual"
      : `Nothing unusual · ${everydayCount} everyday permission${everydayCount === 1 ? "" : "s"}`;
  }
  const phrases = part.notableRows.slice(0, 2).map(installRowHeadline);
  return phrases.join(" · ");
}

export function installRowHeadline(row: InstallReviewRow): string {
  return row.kind === "behavior" ? INSTALL_BEHAVIOR_COPY[row.fact].action : row.row.action;
}

/** Everything selectable on a part, in render order. */
export function clearableRows(part: InstallReviewPart): InstallReviewRow[] {
  return [...part.notableRows, ...part.everydayRows].filter((row) => row.selectable);
}

/**
 * Default acceptance: every part checked, every install-clearable row checked.
 * One click adds the complete slate with everything allowed.
 */
export function defaultAcceptance(
  mode: UnitInstallReviewMode,
  parts: readonly InstallReviewPart[]
): TemplateAcceptance {
  return {
    decision: mode === "update" ? "update" : mode === "adopt-root" ? "adopt-root" : "install",
    allowNow: parts
      .filter((part) => part.change !== "removed")
      .map((part) => ({
        identityKey: part.identityKey,
        permissions: clearableRows(part)
          .filter((row) => row.selectedByDefault)
          .map((row) => row.key),
      })),
  };
}

/**
 * Ordering for a first-encounter list — creation and install (§7.1, §7.2).
 *
 * A base template lands dozens of parts. Alphabetical order scatters the handful
 * that have something to say through fifty that do not, and the person who most
 * needs to see them is the one least likely to scroll for them. Notable first,
 * with what always confirms above what merely runs on its own; everything that
 * reads `Nothing unusual` sinks together to the bottom, where one click covers
 * it.
 */
export function notablePartRank(part: InstallReviewPart): number {
  if (part.change === "removed") return 4;
  if (part.notableRows.some((row) => row.timing === "asks-every-time")) return 0;
  if (part.notableRows.some((row) => row.kind === "behavior")) return 1;
  if (part.notableRows.length > 0) return 2;
  return 3;
}

/** The one comparator both the desktop list and the mobile sheet sort by. */
export function compareInstallParts(
  mode: UnitInstallReviewMode,
  left: InstallReviewPart,
  right: InstallReviewPart
): number {
  const rank = mode === "update" ? differentialPartRank : notablePartRank;
  return rank(left) - rank(right) || left.title.localeCompare(right.title);
}

/** A repository-level section in the install review's part list. */
export interface InstallPartGroup {
  key: string;
  title: string;
  order: number;
  parts: InstallReviewPart[];
  hasNotablePart: boolean;
}

/**
 * Put a unit where a person will find it after installation. Repository
 * directory is the stable first-level model; the platform-derived Service
 * label is the one intentional refinement, because a hosted API and an agent
 * that acts on its own are materially different things to review even though
 * both execute as workers.
 */
export function installPartGroup(
  part: InstallReviewPart
): Omit<InstallPartGroup, "parts" | "hasNotablePart"> {
  const directory = part.repoPath.split("/").filter(Boolean)[0] ?? "other";
  if (directory === "panels") return { key: "app-panels", title: "App panels", order: 0 };
  if (directory === "workers" && part.label !== "Service") {
    return {
      key: "agents-and-background-tasks",
      title: "Agents and background tasks",
      order: 1,
    };
  }
  if (directory === "about") return { key: "system-panels", title: "System panels", order: 2 };
  if (part.label === "Service") return { key: "services", title: "Services", order: 3 };
  if (directory === "apps") return { key: "client-apps", title: "Client apps", order: 4 };
  if (directory === "extensions") return { key: "extensions", title: "Extensions", order: 5 };
  return {
    key: `directory:${directory}`,
    title: directory
      .split(/[-_]/u)
      .filter(Boolean)
      .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
      .join(" "),
    order: 100,
  };
}

/** Group an already-sorted part list without disturbing its within-group order. */
export function groupInstallParts(parts: readonly InstallReviewPart[]): InstallPartGroup[] {
  const groups = new Map<string, InstallPartGroup>();
  for (const part of parts) {
    const category = installPartGroup(part);
    const group = groups.get(category.key) ?? {
      ...category,
      parts: [],
      hasNotablePart: false,
    };
    group.parts.push(part);
    group.hasNotablePart ||= part.notableRows.length > 0;
    groups.set(category.key, group);
  }
  return [...groups.values()].sort(
    (left, right) => left.order - right.order || left.title.localeCompare(right.title)
  );
}

/** The category header's part count, shown as a badge beside the group title. */
export function installPartGroupCount(group: InstallPartGroup): number {
  return group.parts.length;
}

/**
 * Everyday rows under their domain heading (§7.2). Ordinary permissions are
 * only scannable in groups: eight rows in a flat list are eight things to read,
 * and the same eight under `Files`, `The web`, `Your workspace` are three.
 */
export function groupRowsByDomain(
  rows: readonly InstallReviewRow[]
): Array<{ domain: AuthorityRow["domain"] | null; label: string; rows: InstallReviewRow[] }> {
  const groups = new Map<
    string,
    { domain: AuthorityRow["domain"] | null; rows: InstallReviewRow[] }
  >();
  for (const row of rows) {
    // A behavioral row states a fact about the part, not a domain of authority.
    const domain = row.kind === "permission" ? row.row.domain : null;
    const key = domain ?? "\0other";
    const group = groups.get(key) ?? { domain, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      domain: group.domain,
      label: group.domain ? AUTHORITY_DOMAINS[group.domain].label : "Other",
      rows: group.rows,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Ordering for the differential list (§7.3): new or widened permissions first,
 * then permissions that moved to asking-at-use or always-confirms, then new
 * background behavior, then newly added parts, then removed parts.
 */
export function differentialPartRank(part: InstallReviewPart): number {
  if (part.change === "removed") return 4;
  if (part.change === "added") return 3;
  const rows = [...part.notableRows, ...part.everydayRows];
  if (rows.some((row) => row.change === "added")) return 0;
  if (rows.some((row) => row.change === "retiered" || row.change === "removed")) return 1;
  if (rows.some((row) => row.kind === "behavior")) return 2;
  return 3;
}
