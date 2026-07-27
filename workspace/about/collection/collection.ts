/**
 * Pure state + prompt helpers for the Collection panel.
 *
 * Kept free of `@workspace/runtime` imports so they unit-test in a plain
 * Node/vitest environment without a panel runtime.
 */

export interface CollectionStateArgs {
  /** Display name; also pushed to the panel title when the user edits it. */
  title?: string;
  /** Free-form notes about the collection as a whole. */
  note?: string;
  /** Per-child notes, keyed by panel id. */
  notes?: Record<string, string>;
  /** Where the collection came from, e.g. "Firefox · Window 2". Set by the creator. */
  origin?: string;
}

export interface CollectionMember {
  id: string;
  title: string;
  source: string;
  note?: string;
}

/** Merge a per-child note into the persisted map, dropping emptied notes. */
export function withMemberNote(
  notes: Record<string, string> | undefined,
  panelId: string,
  note: string
): Record<string, string> {
  const next = { ...(notes ?? {}) };
  const trimmed = note.trim();
  if (trimmed) next[panelId] = trimmed;
  else delete next[panelId];
  return next;
}

/** Drop notes for panels that are no longer members, so state does not grow forever. */
export function pruneNotes(
  notes: Record<string, string> | undefined,
  memberIds: readonly string[]
): Record<string, string> {
  const live = new Set(memberIds);
  return Object.fromEntries(Object.entries(notes ?? {}).filter(([id]) => live.has(id)));
}

export interface CollectionDebugPromptInput {
  title: string;
  note?: string;
  origin?: string;
  members: readonly CollectionMember[];
  /** When set, the session is scoped to this one member. */
  focusId?: string;
}

/**
 * Build the opening prompt for a debug session over a collection. The agent is
 * told what the collection holds, what the user wrote about it, and that the
 * panels are live and drivable — not just described.
 */
export function buildCollectionDebugPrompt(input: CollectionDebugPromptInput): string {
  const focus = input.focusId
    ? input.members.find((member) => member.id === input.focusId)
    : undefined;
  const scope = focus ? [focus] : input.members;

  const lines: string[] = [
    focus
      ? `You are debugging one panel collected in the Vibestudio collection "${input.title}".`
      : `You are investigating a Vibestudio collection called "${input.title}" and the panels it holds.`,
    "",
  ];

  if (input.origin) lines.push(`Collection origin: ${input.origin}`, "");
  if (input.note?.trim()) {
    lines.push("Notes the user wrote about this collection:", quote(input.note), "");
  }

  lines.push(focus ? "Panel in scope:" : `Panels in this collection (${scope.length}):`);
  if (scope.length === 0) {
    lines.push("- (none — the collection is currently empty)");
  }
  for (const member of scope) {
    lines.push(`- ${member.title}`);
    lines.push(`  panelId: ${member.id}`);
    lines.push(`  source: ${member.source}`);
    if (member.note?.trim()) lines.push(`  user note: ${collapse(member.note)}`);
  }
  lines.push("");

  lines.push(
    "These panels are live. You can drive them through the panel runtime:",
    "- `panelTree.get(panelId)` returns a handle; `observe()`, `diagnose()`, `reload()`, and `cdp` automation all work on it.",
    "- Prefer reading a panel's own diagnostics over guessing from its title.",
    "",
    "Your task:",
    focus
      ? "1. Investigate the panel above and report what it is doing and anything wrong with it."
      : "1. Investigate the panels above and report what the collection is about and anything wrong with them.",
    "2. If the user's notes name a goal, work toward it — including automating repetitive steps across these panels.",
    "3. Say what you verified versus what you assumed.",
    "",
    "Ask the user what they want done here if the notes do not make the goal clear."
  );

  return lines.join("\n");
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
