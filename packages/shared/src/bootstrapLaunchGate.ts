import type { PendingUnitInstallReviewApproval } from "./approvals.js";
import {
  installRowHeadline,
  originDomainFact,
  partNotableLine,
  type InstallReviewOrigin,
  type InstallReviewPart,
} from "./authority/unitInstallReview.js";
import { HOST_APPROVAL_COPY } from "./hostApprovalCopy.js";
import type { HostKind } from "@vibestudio/workspace-contracts/clients";

/**
 * The launch gate (docs/template-install-unit-approval-ux-plan.md §7.6).
 *
 * Clients and extensions are decided before the workspace UI exists, in a
 * host-owned window and in the terminal. This surface cannot be replaced by the
 * in-workspace collection route, because the client is itself under review and
 * cannot render its own approval. After the creation review exists, it is also
 * the ONLY review these units ever get — including for a third-party root — so
 * it is specified properly rather than treated as chrome.
 *
 * **This decision is not about permissions.** Extensions execute workspace code under the host platform
 * contract, including normal account permissions on Windows, and a client is the
 * program the person is looking at. Listing individual permissions here invites the user to weigh
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

export function hostLabel(host: HostKind): string {
  if (host === "android") return "Android";
  if (host === "ios") return "iOS";
  if (host === "terminal") return "Terminal";
  return "Desktop";
}

export function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

/** One unit line: name and its notable rows in plain language (level 2). */
export interface LaunchGateUnitRow {
  /** Canonical reviewed-unit identity; titles can repeat across different parts. */
  identityKey: string;
  name: string;
  /** The user-facing noun: Client, Extension, Panel, Agent, Service. */
  label: string;
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
  /** `2 clients · 4 extensions · 9 other parts` */
  counts: string;
  clients: number;
  extensions: number;
  /** Panels, agents and services: everything that is neither a client nor an extension. */
  others: number;
  units: LaunchGateUnitRow[];
  /** `This is the first time you've run code from github.com/acme.` */
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
   * The first run from an origin, at the top level.
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
   * What will run, stated directly when the source sentence leads.
   *
   * Set only when the summary led with an origin instead of a count: the count
   * is a fact worth keeping, not something the lead sentence replaces.
   */
  programsLine: string | null;
  /** Present whenever any extension is in the set; never folded away. */
  nativeCodeWarning: string | null;
  sources: LaunchGateSource[];
  /** Individual program details start closed; sources and counts stay visible. */
  sourcesExpandedByDefault: boolean;
  /** Label for the individual program details disclosure. */
  disclosureLabel: string;
  totalPrograms: number;
  /** What declining costs, stated honestly for this exact case (§7.6.6). */
  declineConsequence: string;
  acceptLabel: string;
  declineLabel: string;
}

const LAUNCH_GATE_COPY = {
  startupTitle: "Review code before starting",
  runtimeTitle: "Allow code to run?",
  start: "Start workspace",
  allow: "Allow and continue",
  /** At creation the whole app is what declines; later it is one extension. */
  quit: "Quit without starting",
  dontStart: "Don't start",
  seeWhatRuns: "Review included programs",
  selfNamed: (name: string) => `"${name}" — name given by this template`,
  firstEncounter: (originKey: string) => `This is the first time you've run code from ${originKey}.`,
  builtFrom: (url: string) => `This workspace is based on code from ${url}.`,
  builtFromEach: (urls: readonly string[]) =>
    `These workspaces are based on code from ${joinNames(urls)}.`,
  allFromOneSource: (programs: string, counts: string, label: string) =>
    `Starting this workspace will run ${programs} on this computer (${counts}), all from ${label}.`,
  runtimeOneSource: (programs: string, counts: string, label: string) =>
    `Vibestudio is asking to run ${programs} on this computer (${counts}), from ${label}.`,
  programCount: (programs: string) =>
    `Starting this workspace will run ${programs} on this computer.`,
  runtimeProgramCount: (programs: string) =>
    `Vibestudio is asking to run ${programs} on this computer.`,
  /** The count survives leading with an origin; it is never dropped for it. */
  programsIncluding: (programs: string, extensions: number) =>
    extensions > 0
      ? `Starting this workspace will run ${programs} on this computer, including ${plural(extensions, "extension")}.`
      : `Starting this workspace will run ${programs} on this computer.`,
  runtimeProgramsIncluding: (programs: string, extensions: number) =>
    extensions > 0
      ? `Vibestudio is asking to run ${programs} on this computer, including ${plural(extensions, "extension")}.`
      : `Vibestudio is asking to run ${programs} on this computer.`,
  declineAtStart: "Vibestudio will quit without starting this workspace.",
  declineExtension: (name: string) =>
    `The ${name} extension won't run. The rest of your workspace works normally.`,
  declineExtensions: (names: readonly string[]) =>
    `The ${joinNames(names)} extensions won't run. The rest of your workspace works normally.`,
} as const;

function isString(value: string | null): value is string {
  return value !== null;
}

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
  if (origin.originStatus === "multiple-template-contributors") {
    return "Multiple template contributions — inspect file history for exact sources";
  }
  if (origin.originStatus === "unresolved" || !origin.url) return "";
  return origin.version ? `${origin.url}  at ${origin.version}` : origin.url;
}

export function launchGateUnitRow(part: InstallReviewPart): LaunchGateUnitRow {
  const notable = part.notableRows.map(installRowHeadline);
  return {
    identityKey: part.identityKey,
    name: part.title || part.name,
    label: part.label,
    // The same words the collection route uses for the same unit, so what a
    // person reads here matches what they will later see in Templates.
    notable: notable.length > 0 ? notable.join(" · ") : partNotableLine(part),
    purpose: part.purpose,
  };
}

function countsPhrase(clients: number, extensions: number, others: number): string {
  // Every program counts somewhere: the source's counts add up to what it runs.
  const parts = [
    clients > 0 ? plural(clients, "client") : null,
    extensions > 0 ? plural(extensions, "extension") : null,
    others > 0 ? plural(others, clients + extensions > 0 ? "other part" : "part") : null,
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
    // A source is one repository at one version: the identity its label shows.
    // (`originKey` is the owner, which first encounter keys on; two repositories
    // under one owner are still two sources.)
    const key = `${part.origin.url ?? part.origin.originKey}\u0000${part.origin.version ?? ""}`;
    let source = byOrigin.get(key);
    if (!source) {
      source = {
        origin: part.origin,
        label: sourceLabel(part.origin),
        counts: "",
        clients: 0,
        extensions: 0,
        others: 0,
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
    if (part.kind === "client") source.clients += 1;
    else if (part.kind === "extension") source.extensions += 1;
    else source.others += 1;
    source.units.push(launchGateUnitRow(part));
  }
  const sources = [...byOrigin.values()];
  for (const source of sources) {
    source.counts = countsPhrase(source.clients, source.extensions, source.others);
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

/** The sources workspaces are built from: one per workspace the gate starts. */
function rootSources(sources: readonly LaunchGateSource[]): LaunchGateSource[] {
  return sources.filter((source) => source.origin.isWorkspaceRoot === true);
}

/**
 * The whole gate, for one host.
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
  // Root provenance is supplied by the server from the workspace creation
  // descriptor. Counts and source ordering are presentation facts, never
  // evidence of which source the workspace was built from. A gate that starts
  // several workspaces at once (an instance's first start) has one root each.
  const roots = rootSources(sources);
  const foreignRoots = roots.filter(
    (root) => !root.origin.isHostBuild && root.origin.originStatus !== "unresolved"
  );
  const leadsWithOrigin = foreignRoots.length > 0;
  const blocksStartup = input.blocksStartup ?? parts.some((part) => part.kind === "client");
  const singleSource = sources.length === 1;
  const only = sources[0];

  const summary = leadsWithOrigin
    ? // A workspace built from a root published by someone else leads with that
      // fact — not because it is disallowed, but because it is the thing worth
      // knowing.
      foreignRoots.length === 1
      ? LAUNCH_GATE_COPY.builtFrom(foreignRoots[0]!.origin.url ?? foreignRoots[0]!.origin.originKey)
      : LAUNCH_GATE_COPY.builtFromEach(
          foreignRoots.map((root) => root.origin.url ?? root.origin.originKey)
        )
    : singleSource && only
      ? blocksStartup
        ? LAUNCH_GATE_COPY.allFromOneSource(programs, only.counts, only.label)
        : LAUNCH_GATE_COPY.runtimeOneSource(programs, only.counts, only.label)
      : blocksStartup
        ? LAUNCH_GATE_COPY.programCount(programs)
        : LAUNCH_GATE_COPY.runtimeProgramCount(programs);

  // Promoted out of the disclosure, not duplicated into it: the row for this
  // source would otherwise repeat the sentence the reader just read.
  // Roots under one owner say it once.
  const firstEncounterLine =
    [
      ...new Set(foreignRoots.map((root) => root.firstEncounterLine).filter(isString)),
    ].join(" ") || null;
  // The domain travels with the URL it belongs to. When the lead sentence is
  // the URL, the fact belongs beside it and not further down the page.
  const domainLine =
    [...new Set(foreignRoots.map((root) => root.domainLine).filter(isString))].join(" ") || null;
  for (const root of foreignRoots) {
    root.firstEncounterLine = null;
    root.domainLine = null;
  }

  // Provenance is presented in a compact visible summary below. Keep the
  // potentially long list of individual programs closed until requested.
  const sourcesExpandedByDefault = false;
  return {
    approvalIds: input.approvals.map((approval) => approval.approvalId),
    title: blocksStartup ? LAUNCH_GATE_COPY.startupTitle : LAUNCH_GATE_COPY.runtimeTitle,
    summary,
    firstEncounterLine,
    domainLine,
    programsLine: leadsWithOrigin
      ? blocksStartup
        ? LAUNCH_GATE_COPY.programsIncluding(programs, extensions.length)
        : LAUNCH_GATE_COPY.runtimeProgramsIncluding(programs, extensions.length)
      : null,
    nativeCodeWarning:
      extensions.length > 0
        ? HOST_APPROVAL_COPY.installReview.nativeCodeWarning(input.approvals[0]?.executionPlatform)
        : null,
    sources,
    sourcesExpandedByDefault,
    disclosureLabel: LAUNCH_GATE_COPY.seeWhatRuns,
    totalPrograms,
    declineConsequence: blocksStartup
      ? LAUNCH_GATE_COPY.declineAtStart
      : extensions.length === 1
        ? LAUNCH_GATE_COPY.declineExtension(extensions[0]?.title ?? "new")
        : LAUNCH_GATE_COPY.declineExtensions(extensions.map((extension) => extension.title)),
    acceptLabel: blocksStartup ? LAUNCH_GATE_COPY.start : LAUNCH_GATE_COPY.allow,
    declineLabel: blocksStartup ? LAUNCH_GATE_COPY.quit : LAUNCH_GATE_COPY.dontStart,
  };
}

export function approvalSignature(approval: PendingUnitInstallReviewApproval): string {
  return [
    approval.approvalId,
    approval.mode,
    ...approval.parts.map((part) =>
      [part.kind, part.name, part.runtime ?? "", part.repoPath, part.effectiveVersion].join(":")
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
 *
 * Like the window it discloses in levels (§7.6.5): this is what the window
 * shows before program details are opened — what the code is, where it came
 * from, how much runs, what native code may do, each source with its counts,
 * and what
 * declining costs. The programs themselves are one keypress away
 * (`formatLaunchGateUnitsForTerminal`), so the decision is never scrolled away
 * under a list of every program. Everything wraps to `width`, keeping its indent.
 */
export function formatLaunchGateForTerminal(
  approvals: PendingUnitInstallReviewApproval[],
  host: HostKind,
  width = 80
): string {
  const view = launchGateView({ approvals });
  const lines = [`${hostLabel(host)} — ${view.title}`, ""];
  const add = (text: string, indent = 0, hanging = indent) =>
    lines.push(...wrapIndented(text, width, indent, hanging));
  add(view.summary);
  // Same order as the window: what this workspace is, which domain that URL
  // actually belongs to, whether it is new to the user, how much of it there is,
  // and what native code can do — all before the per-source list.
  //
  // The domain is stated rather than emphasized. Plain text has no honest way to
  // emphasize a run of characters — every candidate (asterisks, carets, a
  // second underlined line) is typography a hostile URL could imitate in its own
  // path — so the terminal says the fact instead of drawing it.
  if (view.domainLine) add(view.domainLine);
  if (view.firstEncounterLine) add(view.firstEncounterLine);
  if (view.programsLine) {
    lines.push("");
    add(view.programsLine);
  }
  if (view.nativeCodeWarning) {
    lines.push("");
    add(view.nativeCodeWarning);
  }
  lines.push("");
  for (const source of view.sources) {
    add(source.label, 2, 6);
    if (source.counts) add(source.counts, 6);
    // Directly under the URL it qualifies, before anything the template says
    // about itself: the domain is the non-asserted part of this row.
    if (source.domainLine) add(source.domainLine, 6);
    if (source.origin.selfName && !source.origin.isHostBuild) {
      add(LAUNCH_GATE_COPY.selfNamed(source.origin.selfName), 6);
    }
    if (source.firstEncounterLine) add(source.firstEncounterLine, 6);
  }
  lines.push("");
  add(view.declineConsequence);
  return lines.join("\n");
}

/** Level 2 for the terminal: every program under its source, with its notable rows. */
export function formatLaunchGateUnitsForTerminal(
  approvals: PendingUnitInstallReviewApproval[],
  width = 80
): string {
  const view = launchGateView({ approvals });
  const lines: string[] = [];
  for (const source of view.sources) {
    if (lines.length > 0) lines.push("");
    lines.push(...wrapIndented(`${source.label}   ${source.counts}`, width, 2, 6));
    for (const unit of source.units) {
      lines.push(...wrapIndented(`${unit.name} (${unit.label})`, width, 4, 8));
      lines.push(...wrapIndented(unit.notable || unit.purpose, width, 8));
    }
  }
  return lines.join("\n");
}

/** Word-wrap `text` to `width`: the first line at `indent`, the rest at `hanging`. */
function wrapIndented(text: string, width: number, indent: number, hanging = indent): string[] {
  const lines: string[] = [];
  let line = " ".repeat(indent);
  let empty = true;
  // Runs of spaces are kept: `url  at v2.1` reads as two fields.
  for (const word of text.split(" ")) {
    if (!empty && line.length + 1 + word.length > width) {
      lines.push(line);
      line = " ".repeat(hanging);
      empty = true;
    }
    line += (empty ? "" : " ") + word;
    empty = false;
  }
  lines.push(line);
  return lines;
}
