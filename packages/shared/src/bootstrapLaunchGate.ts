import type { PendingUnitInstallReviewApproval } from "./approvals.js";
import {
  installRowHeadline,
  originDomainFact,
  partNotableLine,
  type InstallReviewOrigin,
  type InstallReviewPart,
} from "./authority/unitInstallReview.js";
import { HOST_APPROVAL_COPY } from "./hostApprovalCopy.js";
import type { HostTarget } from "./hostTargets.js";

/**
 * The launch gate (docs/template-install-unit-approval-ux-plan.md §7.6).
 *
 * Client apps and extensions are decided before the workspace UI exists, in a
 * host-owned window and in the terminal. This surface cannot be replaced by the
 * in-workspace collection route, because `apps/shell` is itself under review and
 * cannot render its own approval. After the creation review exists, it is also
 * the ONLY review these units ever get — including for a third-party root — so
 * it is specified properly rather than treated as chrome.
 *
 * **This decision is not about permissions.** Extensions are native code running
 * outside Vibestudio's protections with access to the computer, and apps are the
 * client itself. Listing individual permissions here invites the user to weigh
 * details downstream of the only question that matters:
 *
 *   > Whose code is this, and do I want it running on my computer?
 *
 * So the organizing axis is **origin**, not kind and not permission — the
 * opposite of the collection route, where the code is sandboxed and the
 * interesting axis is what it can reach. The difference is deliberate.
 *
 * Three rules follow, because the gate cannot lean on any notion of an approved
 * publisher — there is no publisher identity in this system at all:
 *
 *   the origin URL IS the identity, never abbreviated away and never replaced by
 *     a self-asserted name;
 *   no digests anywhere a user reads — a 40-character hash is unreadable, and
 *     printing it implies the user should check it against something they have no
 *     way to check;
 *   nothing may imply we reviewed, approved, or vouched for anyone, because we
 *     have not.
 */

export type BootstrapDecision = "once" | "deny";

export function targetLabel(target: HostTarget): string {
  if (target === "react-native") return "Mobile";
  if (target === "terminal") return "Terminal";
  return "Desktop";
}

export function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

/** One unit line: name and its notable rows in plain language (level 2). */
export interface LaunchGateUnitRow {
  name: string;
  kind: "Client App" | "Extension";
  /** Notable rows in the same words the collection route uses for this unit. */
  notable: string;
  /** Purpose only, when there is nothing notable to say. */
  purpose: string;
}

/** One source: origin URL, version, and counts (level 1). */
export interface LaunchGateSource {
  origin: InstallReviewOrigin;
  /** `github.com/acme/studio  at v2.1`, or the host naming its own build. */
  label: string;
  /** `2 apps · 4 extensions` */
  counts: string;
  apps: number;
  extensions: number;
  units: LaunchGateUnitRow[];
  /** `You haven't run code from github.com/acme before.` */
  firstEncounterLine: string | null;
  /**
   * `Domain: attacker.net` — the emphasized part of the URL, said out loud.
   *
   * A window can bold the registrable domain inside the URL; the terminal
   * cannot, and a screen reader does not hear bold. Both read this instead, so
   * the two forms carry the same claim rather than the window carrying more.
   */
  domainLine: string | null;
}

export interface LaunchGateView {
  approvalIds: string[];
  title: string;
  /** The one-sentence common case, or the leading fact for a foreign root. */
  summary: string;
  /**
   * `You haven't run code from github.com/acme before.`, at the TOP LEVEL.
   *
   * The single most useful signal available without an identity system does not
   * belong behind a disclosure, so when the workspace is built from someone
   * else's code the line is promoted out of that source's row and printed here.
   */
  firstEncounterLine: string | null;
  /**
   * `Domain: attacker.net`, for the origin the summary leads with.
   *
   * Promoted for the same reason the first-encounter line is: when the lead
   * sentence IS a URL, the one part of it that says who this is has to be
   * readable without eyesight and without typography.
   */
  domainLine: string | null;
  /**
   * `It needs to run 9 programs on this computer, including 4 extensions.`
   *
   * Set only when the summary led with an origin instead of a count: the count
   * is a fact worth keeping, not something the lead sentence replaces.
   */
  programsLine: string | null;
  /** Present whenever any extension is in the set; never folded away. */
  nativeCodeWarning: string | null;
  sources: LaunchGateSource[];
  /** Expanded by default the moment a second source appears. */
  sourcesExpandedByDefault: boolean;
  /** `See what runs` when the list is collapsed, `Review each` when it is open. */
  disclosureLabel: string;
  totalPrograms: number;
  /** What declining costs, stated honestly for this exact case (§7.6.6). */
  declineConsequence: string;
  acceptLabel: string;
  declineLabel: string;
}

const LAUNCH_GATE_COPY = {
  title: "Start this workspace?",
  accept: "Start",
  /** At creation the whole app is what declines; later it is one extension. */
  quit: "Quit",
  dontStart: "Don't start",
  seeWhatRuns: "See what runs",
  reviewEach: "Review each",
  selfNamed: (name: string) => `"${name}" — name given by this template`,
  firstEncounter: (originKey: string) => `You haven't run code from ${originKey} before.`,
  builtFrom: (url: string) => `This workspace is built from code at ${url}.`,
  allFromOneSource: (programs: string, counts: string, label: string) =>
    `Vibestudio needs to run ${programs} on this computer — ${counts}, all from ${label}.`,
  programCount: (programs: string) => `Vibestudio needs to run ${programs} on this computer.`,
  /** The count survives leading with an origin; it is never dropped for it. */
  programsIncluding: (programs: string, extensions: number) =>
    extensions > 0
      ? `It needs to run ${programs} on this computer, including ${plural(extensions, "extension")}.`
      : `It needs to run ${programs} on this computer.`,
  declineAtStart: "Vibestudio won't start. Nothing is installed or changed.",
  declineExtension: (name: string) =>
    `The ${name} extension won't run. The rest of your workspace works normally.`,
  declineExtensions: (names: readonly string[]) =>
    `The ${joinNames(names)} extensions won't run. The rest of your workspace works normally.`,
} as const;

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "new";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * How a source is named.
 *
 * A template's self-given name may appear as its title, in a slot that obviously
 * belongs to the template — never in a `From X` position that reads as a
 * verified publisher. The host's own build is the one exception: its URL ships
 * in the host build, so the host naming its own origin is a build vouching for
 * itself rather than a claim about a third party.
 */
export function sourceLabel(origin: InstallReviewOrigin): string {
  if (origin.isHostBuild) {
    return origin.version ? `Vibestudio ${origin.version}` : "Vibestudio";
  }
  if (origin.originStatus === "unresolved" || !origin.url) return "";
  return origin.version ? `${origin.url}  at ${origin.version}` : origin.url;
}

export function launchGateUnitRow(part: InstallReviewPart): LaunchGateUnitRow {
  const notable = part.notableRows.map(installRowHeadline);
  return {
    name: part.title || part.name,
    kind: part.kind === "app" ? "Client App" : "Extension",
    // The same words the collection route uses for the same unit, so what a
    // person reads here matches what they will later see in Templates.
    notable: notable.length > 0 ? notable.join(" · ") : partNotableLine(part),
    purpose: part.purpose,
  };
}

function countsPhrase(apps: number, extensions: number): string {
  const parts = [
    apps > 0 ? plural(apps, "app") : null,
    extensions > 0 ? plural(extensions, "extension") : null,
  ].filter((value): value is string => value !== null);
  return parts.join(" · ") || "nothing";
}

/**
 * Group the units under review by where their bytes came from, unfamiliar
 * origins first.
 *
 * Ordering is stable and never hides a source behind a count: the moment a
 * second source appears, sources become the list.
 */
export function launchGateSources(parts: readonly InstallReviewPart[]): LaunchGateSource[] {
  const byOrigin = new Map<string, LaunchGateSource>();
  for (const part of parts) {
    const key = part.origin.originKey;
    let source = byOrigin.get(key);
    if (!source) {
      source = {
        origin: part.origin,
        label: sourceLabel(part.origin),
        counts: "",
        apps: 0,
        extensions: 0,
        units: [],
        firstEncounterLine:
          part.origin.originStatus === "unresolved"
            ? null
            : part.origin.firstEncounter
              ? LAUNCH_GATE_COPY.firstEncounter(part.origin.originKey)
              : null,
        domainLine: originDomainFact(part.origin),
      };
      byOrigin.set(key, source);
    }
    if (part.kind === "app") source.apps += 1;
    if (part.kind === "extension") source.extensions += 1;
    source.units.push(launchGateUnitRow(part));
  }
  const sources = [...byOrigin.values()];
  for (const source of sources) {
    source.counts = countsPhrase(source.apps, source.extensions);
    source.units.sort((left, right) => left.name.localeCompare(right.name));
  }
  return sources.sort((left, right) => {
    // Unfamiliar first, then anything that is not our own build, then by name.
    const rank = (source: LaunchGateSource) =>
      source.origin.firstEncounter
        ? 0
        : source.origin.originStatus === "unresolved"
          ? 1
          : source.origin.isHostBuild
            ? 2
            : 1;
    return rank(left) - rank(right) || left.label.localeCompare(right.label);
  });
}

function rootSource(sources: readonly LaunchGateSource[]): LaunchGateSource | undefined {
  return sources.find((source) => source.origin.isWorkspaceRoot === true);
}

/**
 * The whole gate, for one host target.
 *
 * A fresh workspace from our own base — the overwhelmingly common case — reads
 * as one fact and one button. Anything from elsewhere is named, never buried.
 */
export function launchGateView(input: {
  approvals: readonly PendingUnitInstallReviewApproval[];
  /** True at creation or when the app being launched is itself under review. */
  blocksStartup?: boolean;
}): LaunchGateView {
  const parts = input.approvals.flatMap((approval) => approval.parts);
  const sources = launchGateSources(parts);
  const totalPrograms = parts.length;
  const programs = plural(totalPrograms, "program");
  const extensions = parts.filter((part) => part.kind === "extension");
  const root = rootSource(sources);
  // Root provenance is supplied by the server from the workspace creation
  // descriptor. Counts and source ordering are presentation facts, never
  // evidence of which source the workspace was built from.
  const leadsWithOrigin =
    root !== undefined && !root.origin.isHostBuild && root.origin.originStatus !== "unresolved";
  const singleSource = sources.length === 1;
  const only = sources[0];

  const summary = leadsWithOrigin
    ? // A workspace built from a root published by someone else leads with that
      // fact — not because it is disallowed, but because it is the thing worth
      // knowing.
      LAUNCH_GATE_COPY.builtFrom(root.origin.url ?? root.origin.originKey)
    : singleSource && only
      ? // One fact, one button: `Vibestudio needs to run 16 programs on this
        // computer — 3 apps and 13 extensions, all from Vibestudio 1.4.0.`
        LAUNCH_GATE_COPY.allFromOneSource(programs, only.counts, only.label)
      : LAUNCH_GATE_COPY.programCount(programs);

  // Promoted out of the disclosure, not duplicated into it: the row for this
  // source would otherwise repeat the sentence the reader just read.
  let firstEncounterLine: string | null = null;
  if (leadsWithOrigin && root.firstEncounterLine) {
    firstEncounterLine = root.firstEncounterLine;
    root.firstEncounterLine = null;
  }
  // The domain travels with the URL it belongs to. When the lead sentence is
  // the URL, the fact belongs beside it and not further down the page.
  let domainLine: string | null = null;
  if (leadsWithOrigin && root.domainLine) {
    domainLine = root.domainLine;
    root.domainLine = null;
  }

  const blocksStartup = input.blocksStartup ?? parts.some((part) => part.kind === "app");
  // One source that is not ours is still a source worth opening on: collapsing
  // it would put the only identity in this decision behind a click.
  const sourcesExpandedByDefault =
    sources.length > 1 || sources.some((source) => !source.origin.isHostBuild);
  return {
    approvalIds: input.approvals.map((approval) => approval.approvalId),
    title: LAUNCH_GATE_COPY.title,
    summary,
    firstEncounterLine,
    domainLine,
    programsLine: leadsWithOrigin
      ? LAUNCH_GATE_COPY.programsIncluding(programs, extensions.length)
      : null,
    nativeCodeWarning:
      extensions.length > 0 ? HOST_APPROVAL_COPY.installReview.nativeCodeWarning : null,
    sources,
    sourcesExpandedByDefault,
    disclosureLabel: sourcesExpandedByDefault
      ? LAUNCH_GATE_COPY.reviewEach
      : LAUNCH_GATE_COPY.seeWhatRuns,
    totalPrograms,
    declineConsequence: blocksStartup
      ? LAUNCH_GATE_COPY.declineAtStart
      : extensions.length === 1
        ? LAUNCH_GATE_COPY.declineExtension(extensions[0]?.title ?? "new")
        : LAUNCH_GATE_COPY.declineExtensions(extensions.map((extension) => extension.title)),
    acceptLabel: LAUNCH_GATE_COPY.accept,
    declineLabel: blocksStartup ? LAUNCH_GATE_COPY.quit : LAUNCH_GATE_COPY.dontStart,
  };
}

export function approvalSignature(approval: PendingUnitInstallReviewApproval): string {
  return [
    approval.approvalId,
    approval.mode,
    ...approval.parts.map((part) =>
      [part.kind, part.name, part.target ?? "", part.repoPath, part.effectiveVersion].join(":")
    ),
  ].join("|");
}

export function pendingSignature(approvals: PendingUnitInstallReviewApproval[]): string {
  return approvals.map(approvalSignature).join("\n");
}

export function samePendingApprovals(
  left: PendingUnitInstallReviewApproval[],
  right: PendingUnitInstallReviewApproval[]
): boolean {
  return pendingSignature(left) === pendingSignature(right);
}

export function approvalIds(approvals: PendingUnitInstallReviewApproval[]): Set<string> {
  return new Set(approvals.map((approval) => approval.approvalId));
}

/**
 * The terminal form carries the same content and the same decision as the
 * window — same sources, same notable lines, same consequence copy — as plain
 * text with an explicit prompt, never a truncated summary.
 */
export function formatLaunchGateForTerminal(
  approvals: PendingUnitInstallReviewApproval[],
  target: HostTarget
): string {
  const view = launchGateView({ approvals });
  const lines = [`${targetLabel(target)} — ${view.title}`, "", view.summary];
  // Same order as the window: what this workspace is, which domain that URL
  // actually belongs to, whether it is new to the user, how much of it there is,
  // and what native code can do — all before the per-source list, none of it
  // behind a disclosure the terminal cannot have.
  //
  // The domain is stated rather than emphasized. Plain text has no honest way to
  // emphasize a run of characters — every candidate (asterisks, carets, a
  // second underlined line) is typography a hostile URL could imitate in its own
  // path — so the terminal says the fact instead of drawing it.
  if (view.domainLine) lines.push(view.domainLine);
  if (view.firstEncounterLine) lines.push(view.firstEncounterLine);
  if (view.programsLine) lines.push("", view.programsLine);
  if (view.nativeCodeWarning) lines.push("", view.nativeCodeWarning);
  for (const source of view.sources) {
    lines.push("");
    lines.push(`  ${source.label}${source.counts ? `   ${source.counts}` : ""}`);
    // Directly under the URL it qualifies, before anything the template says
    // about itself: the domain is the non-asserted part of this row.
    if (source.domainLine) lines.push(`      ${source.domainLine}`);
    if (source.origin.selfName && !source.origin.isHostBuild) {
      lines.push(`      ${LAUNCH_GATE_COPY.selfNamed(source.origin.selfName)}`);
    }
    if (source.firstEncounterLine) lines.push(`      ${source.firstEncounterLine}`);
    for (const unit of source.units) {
      lines.push(`    ${unit.name} — ${unit.notable || unit.purpose}`);
    }
  }
  lines.push("", view.declineConsequence);
  lines.push("", `[${view.acceptLabel}] / [${view.declineLabel}]`);
  return lines.join("\n");
}
