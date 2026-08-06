/**
 * Host keyboard model. The terminal browser reads raw stdin bytes itself
 * (rather than Ink's `useInput`, which would fight the session pass-through)
 * and intercepts a small set of global control chords BEFORE forwarding the
 * rest to the focused session. Overlays suspend session input.
 */
export type HostChord = "switcher" | "approvals" | "logs" | "new" | "quit" | "escape";

// Single control bytes (raw mode delivers C0 controls as one byte).
const CHORD_BYTES: Record<number, HostChord> = {
  0x10: "switcher", // Ctrl+P
  0x01: "approvals", // Ctrl+A
  0x0c: "logs", // Ctrl+L
  0x0e: "new", // Ctrl+N
  0x11: "quit", // Ctrl+Q
  0x1b: "escape", // Esc (only when delivered as a lone byte; sequences are multi-byte)
};

/**
 * Classify a raw input chunk as a host chord, or null to pass through. Only a
 * single-byte chunk can be a chord — multi-byte chunks (e.g. `\x1b[A` arrows,
 * pasted text) are session input, so a lone Esc is distinguishable from an
 * escape sequence.
 */
export function classifyChord(chunk: Uint8Array): HostChord | null {
  if (chunk.length !== 1) return null;
  return CHORD_BYTES[chunk[0]!] ?? null;
}

/**
 * Overlay navigation actions parsed from a chunk while an overlay is open.
 * `left`/`right`/`tab` exist only for the `unit-install-review` detail (part
 * and permission-row focus, §7.2/§8) — every other overlay ignores them, the
 * same way they already ignore `{ char }` today.
 */
export type NavKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "tab"
  | "enter"
  | "escape"
  | { digit: number }
  | { char: string }
  | null;

export function parseNavKey(chunk: Uint8Array): NavKey {
  if (chunk.length === 1) {
    const b = chunk[0]!;
    if (b === 0x1b) return "escape";
    if (b === 0x09) return "tab";
    if (b === 0x0d || b === 0x0a) return "enter";
    if (b >= 0x31 && b <= 0x39) return { digit: b - 0x30 }; // '1'..'9'
    if (b >= 0x20 && b < 0x7f) return { char: String.fromCharCode(b) };
    return null;
  }
  // Arrow keys: ESC [ A/B/C/D
  if (chunk.length === 3 && chunk[0] === 0x1b && chunk[1] === 0x5b) {
    if (chunk[2] === 0x41) return "up";
    if (chunk[2] === 0x42) return "down";
    if (chunk[2] === 0x43) return "right";
    if (chunk[2] === 0x44) return "left";
  }
  return null;
}
