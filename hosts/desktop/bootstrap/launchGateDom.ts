import type { LaunchGateSource, LaunchGateView } from "@vibestudio/shared/bootstrapLaunchGate";
import {
  originTextSegments,
  type InstallReviewOrigin,
} from "@vibestudio/shared/authority/unitInstallReview";

/**
 * The launch gate's identity presentation, as plain DOM
 * (docs/template-install-unit-approval-ux-plan.md §7.6.3, §7.6.5).
 *
 * Separated from `index.ts` for one reason: `index.ts` is a script that starts
 * talking to the host the moment it is imported, and what a person reads on the
 * single surface that decides whether foreign native code runs is worth testing
 * on its own. Everything here is a pure function of the view — no RPC, no
 * module state, no decision.
 */

/**
 * Write an identity string with its registrable domain emphasized in place.
 *
 * The origin URL IS the identity, so it is written whole — this only marks
 * which run of it says whose code this is. `github.com.attacker.net` gets
 * `attacker.net` emphasized and `github.com` left flat, which is the entire
 * reason the emphasis exists.
 *
 * `<strong>` rather than a class on a span: it carries the meaning to a screen
 * reader's element list and to any renderer that ignores our CSS, and the style
 * it takes (weight plus an underline, never colour alone) survives a monochrome
 * display. Bold is not announced, so the emphasis is never the only place the
 * fact appears — the `Domain:` line beside it says the same thing in words.
 */
export function appendOriginText(
  target: HTMLElement,
  text: string,
  origin: InstallReviewOrigin
): void {
  for (const segment of originTextSegments(text, origin)) {
    const node = document.createElement(segment.emphasized ? "strong" : "span");
    if (segment.emphasized) node.className = "origin-domain";
    node.textContent = segment.text;
    target.append(node);
  }
}

/** The origin whose URL the summary sentence is built around, if any. */
export function leadOrigin(view: LaunchGateView): InstallReviewOrigin | undefined {
  return view.sources.find(
    (source) => source.origin.url && view.summary.includes(source.origin.url)
  )?.origin;
}

/**
 * Everything a person needs in order to decide, before the actions.
 *
 * DOM order is reading order and screen-reader order: what this workspace is,
 * which domain that URL belongs to, whether it is new to them, how much of it
 * there is, and what native code can do. None of it sits behind a disclosure,
 * and it is the same content in the same order the terminal form prints.
 *
 * Returns the ids to name in `aria-describedby`, so the whole set is announced
 * with the group rather than only the sentence at the top.
 */
export function appendLaunchGateFacts(card: HTMLElement, view: LaunchGateView): string[] {
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.id = "launch-gate-summary";
  // When the summary leads with an origin it IS an identity string, so the
  // domain is emphasized inside the sentence too — never abbreviated out of it,
  // and never emphasized in the wrong place.
  const lead = leadOrigin(view);
  if (lead) appendOriginText(meta, view.summary, lead);
  else meta.textContent = view.summary;
  card.append(meta);

  const described = [meta.id];
  if (view.domainLine) {
    // Immediately under the sentence whose URL it qualifies, and in the same
    // position the terminal form prints it.
    const domain = document.createElement("div");
    domain.className = "meta launch-origin-domain";
    domain.id = "launch-gate-domain";
    domain.textContent = view.domainLine;
    card.append(domain);
    described.push(domain.id);
  }
  if (view.firstEncounterLine) {
    const first = document.createElement("div");
    first.className = "meta launch-first-encounter";
    first.id = "launch-gate-first-encounter";
    first.textContent = view.firstEncounterLine;
    card.append(first);
    described.push(first.id);
  }
  if (view.programsLine) {
    // Leading with an origin does not cost the count.
    const programs = document.createElement("div");
    programs.className = "meta launch-program-count";
    programs.id = "launch-gate-programs";
    programs.textContent = view.programsLine;
    card.append(programs);
    described.push(programs.id);
  }
  if (view.nativeCodeWarning) {
    // Native code runs outside our protections. That sentence is the risk, it
    // applies to every extension regardless of origin, and it appears at the top
    // level rather than inside a disclosure.
    const warning = document.createElement("div");
    warning.className = "meta launch-native-warning";
    warning.id = "launch-gate-native-warning";
    warning.textContent = view.nativeCodeWarning;
    card.append(warning);
    described.push(warning.id);
  }
  return described;
}

/** One source: origin URL, version, counts, and the units under it (levels 1–2). */
export function sourceItem(source: LaunchGateSource): HTMLElement {
  const item = document.createElement("li");
  item.className = "launch-source";

  const header = document.createElement("div");
  header.className = "launch-source-header";
  const label = document.createElement("span");
  // The origin URL IS the identity: never abbreviated away, never replaced by
  // a name the code gave itself.
  label.className = "unit-name launch-origin";
  appendOriginText(label, source.label, source.origin);
  const counts = document.createElement("span");
  counts.className = "unit-kind";
  counts.textContent = source.counts;
  header.append(label, counts);
  item.append(header);

  if (source.domainLine) {
    // Said, not only drawn: the emphasis above is invisible to a screen reader
    // and to anyone who cannot resolve a weight difference, and this is the
    // same sentence the terminal form prints for this source.
    const domain = document.createElement("div");
    domain.className = "unit-meta launch-origin-domain";
    domain.textContent = source.domainLine;
    item.append(domain);
  }
  if (source.origin.selfName && !source.origin.isHostBuild) {
    const selfName = document.createElement("div");
    // A self-asserted name may only appear in a slot that obviously belongs to
    // the template — never in a position that reads as a verified publisher.
    selfName.className = "unit-meta launch-self-name";
    selfName.textContent = `"${source.origin.selfName}" — name given by this template`;
    item.append(selfName);
  }
  if (source.firstEncounterLine) {
    const first = document.createElement("div");
    first.className = "unit-meta launch-first-encounter";
    first.textContent = source.firstEncounterLine;
    item.append(first);
  }

  const units = document.createElement("ul");
  units.className = "launch-unit-list";
  for (const unit of source.units) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.className = "unit-name";
    name.textContent = unit.name;
    const detail = document.createElement("span");
    detail.className = "unit-capabilities";
    detail.textContent = unit.notable || unit.purpose;
    row.append(name, detail);
    units.append(row);
  }
  item.append(units);
  return item;
}

/**
 * The sources list (§7.6.5, level 1).
 *
 * Collapsed by default when there is one source; expanded the moment a second
 * appears, because the whole point is that anything from elsewhere is named
 * rather than folded into a count. `onToggle` lets the caller remember what the
 * user opened across re-renders without this module holding state.
 */
export function appendSources(
  card: HTMLElement,
  view: LaunchGateView,
  options: { open: boolean; onToggle?: (open: boolean) => void }
): void {
  const details = document.createElement("details");
  details.className = "unit-review";
  details.open = view.sourcesExpandedByDefault || options.open;
  details.addEventListener("toggle", () => options.onToggle?.(details.open));
  const summary = document.createElement("summary");
  summary.textContent = view.disclosureLabel;
  details.append(summary);

  const list = document.createElement("ul");
  list.className = "unit-list";
  for (const source of view.sources) list.append(sourceItem(source));
  details.append(list);
  card.append(details);
}
