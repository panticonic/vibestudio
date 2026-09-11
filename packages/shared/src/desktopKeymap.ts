/**
 * The one place a desktop key binding is decided.
 *
 * There used to be three. `src/main/menu.ts` registered the accelerators that
 * actually fire, `panelCommands.ts` told context menus what to print next to
 * each command, and the keyboard-shortcuts about page kept its own table
 * "mirroring" the menu. They disagreed, which is what a reader would predict
 * and what happened: the page and the context menu both advertised `Alt+Left`
 * for Back, which nothing bound at all; reload was advertised as `Ctrl+R` and
 * registered as `Ctrl+Shift+R`; and `Ctrl+Y` was documented as Redo while the
 * menu spent it on History.
 *
 * So the binding, the label, and the matcher all come from here. A chord that
 * is not in this table does not exist, and one that is cannot be described
 * two ways.
 */

/** Which chords apply. macOS differs by more than the name of one modifier. */
export type DesktopKeyPlatform = "mac" | "other";

export type DesktopBindingId =
  | "newPanel"
  | "closePanel"
  | "nextPanel"
  | "previousPanel"
  | "commandPalette"
  | "keyboardShortcuts"
  | "switchWorkspace"
  | "focusApproval"
  | "bookmarks"
  | "history"
  | "back"
  | "forward"
  | "reload"
  | "forceReload"
  | "stop"
  | "focusAddress"
  | "findInPage"
  | "findNext"
  | "findPrevious"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "toggleFullScreen"
  | "panelDevTools"
  | "appDevTools";

interface PlatformBinding {
  /** The chord the menus print and register. Electron accelerator syntax. */
  primary: string;
  /**
   * Chords that must do the same thing without being advertised.
   *
   * Browsers accept several spellings of the same intent — `F5` as well as
   * `Ctrl+R`, `Ctrl+=` as well as `Ctrl+Plus` — and a person who learned one
   * of them is not wrong. These are matched, never displayed.
   */
  also?: readonly string[];
}

interface DesktopBinding {
  mac: PlatformBinding;
  other: PlatformBinding;
  /**
   * True when the chord is a fact about the app rather than a menu accelerator.
   *
   * `Escape` is the case this exists for: it stops loading, but registering it
   * as an accelerator would take Escape away from every dialog, field and
   * overlay in the app. The renderer that owns the key handles it in context,
   * and this table still describes it so the documentation cannot drift.
   */
  displayOnly?: boolean;
}

const BINDINGS: Record<DesktopBindingId, DesktopBinding> = {
  newPanel: { mac: { primary: "Cmd+T" }, other: { primary: "Ctrl+T" } },
  closePanel: { mac: { primary: "Cmd+W" }, other: { primary: "Ctrl+W" } },
  // Cycling the panes in reading order, which is this layout's tab strip.
  //
  // `Cmd+Alt+Right` is what Chrome uses on macOS and is already spent here on
  // moving pane focus between columns, so the advertised mac chord is Safari's
  // spelling. `Ctrl+Tab` works everywhere, because that is the chord people
  // actually reach for, and `Ctrl+PageDown` is the third way browsers accept.
  nextPanel: {
    mac: { primary: "Cmd+Shift+]", also: ["Ctrl+Tab", "Cmd+Alt+]"] },
    other: { primary: "Ctrl+Tab", also: ["Ctrl+PageDown"] },
  },
  previousPanel: {
    mac: { primary: "Cmd+Shift+[", also: ["Ctrl+Shift+Tab", "Cmd+Alt+["] },
    other: { primary: "Ctrl+Shift+Tab", also: ["Ctrl+PageUp"] },
  },
  commandPalette: { mac: { primary: "Cmd+K" }, other: { primary: "Ctrl+K" } },
  keyboardShortcuts: { mac: { primary: "Cmd+/" }, other: { primary: "Ctrl+/" } },
  switchWorkspace: { mac: { primary: "Cmd+Shift+O" }, other: { primary: "Ctrl+Shift+O" } },
  focusApproval: { mac: { primary: "Cmd+Shift+A" }, other: { primary: "Ctrl+Shift+A" } },
  bookmarks: { mac: { primary: "Cmd+Shift+B" }, other: { primary: "Ctrl+Shift+B" } },
  // Chrome spends Cmd+Y on history on macOS and Ctrl+H elsewhere. The previous
  // `CmdOrCtrl+Y` took Windows and Linux users' Redo chord to open History.
  history: { mac: { primary: "Cmd+Y" }, other: { primary: "Ctrl+H" } },
  back: {
    mac: { primary: "Cmd+Left", also: ["Cmd+["] },
    other: { primary: "Alt+Left" },
  },
  forward: {
    mac: { primary: "Cmd+Right", also: ["Cmd+]"] },
    other: { primary: "Alt+Right" },
  },
  reload: {
    mac: { primary: "Cmd+R", also: ["F5"] },
    other: { primary: "Ctrl+R", also: ["F5"] },
  },
  forceReload: {
    mac: { primary: "Cmd+Shift+R", also: ["Cmd+Alt+R"] },
    other: { primary: "Ctrl+Shift+R", also: ["Ctrl+F5", "Ctrl+Alt+R"] },
  },
  stop: { mac: { primary: "Esc" }, other: { primary: "Esc" }, displayOnly: true },
  focusAddress: {
    mac: { primary: "Cmd+L" },
    // Alt+D and F6 are the other two ways every Windows browser accepts.
    other: { primary: "Ctrl+L", also: ["Alt+D", "F6", "Ctrl+Shift+L"] },
  },
  findInPage: { mac: { primary: "Cmd+F" }, other: { primary: "Ctrl+F" } },
  findNext: {
    mac: { primary: "Cmd+G" },
    other: { primary: "Ctrl+G", also: ["F3"] },
  },
  findPrevious: {
    mac: { primary: "Cmd+Shift+G" },
    other: { primary: "Ctrl+Shift+G", also: ["Shift+F3"] },
  },
  zoomIn: {
    // The shifted-plus chord is what a keyboard physically produces, and the
    // unshifted `=` is what people press. Both, or zooming in feels broken.
    mac: { primary: "Cmd+Plus", also: ["Cmd+=", "Cmd+Shift+Plus"] },
    other: { primary: "Ctrl+Plus", also: ["Ctrl+=", "Ctrl+Shift+Plus"] },
  },
  zoomOut: { mac: { primary: "Cmd+-" }, other: { primary: "Ctrl+-" } },
  resetZoom: { mac: { primary: "Cmd+0" }, other: { primary: "Ctrl+0" } },
  toggleFullScreen: { mac: { primary: "Ctrl+Cmd+F" }, other: { primary: "F11" } },
  panelDevTools: { mac: { primary: "Cmd+Shift+I" }, other: { primary: "Ctrl+Shift+I" } },
  appDevTools: { mac: { primary: "Cmd+Alt+I" }, other: { primary: "Ctrl+Alt+I" } },
};

function bindingFor(id: DesktopBindingId, platform: DesktopKeyPlatform): PlatformBinding {
  return BINDINGS[id][platform];
}

/** The Electron accelerator to register and print for a binding. */
export function desktopAccelerator(id: DesktopBindingId, platform: DesktopKeyPlatform): string {
  return bindingFor(id, platform).primary;
}

/** Whether this binding is a described fact rather than a menu accelerator. */
export function isDisplayOnlyBinding(id: DesktopBindingId): boolean {
  return BINDINGS[id].displayOnly === true;
}

/** Every chord that must perform a binding, advertised or not. */
export function desktopChords(
  id: DesktopBindingId,
  platform: DesktopKeyPlatform
): readonly string[] {
  const binding = bindingFor(id, platform);
  return [binding.primary, ...(binding.also ?? [])];
}

const MAC_SYMBOLS: Record<string, string> = {
  Cmd: "⌘",
  Command: "⌘",
  CmdOrCtrl: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Option: "⌥",
  Ctrl: "⌃",
  Control: "⌃",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Plus: "+",
  Esc: "Esc",
};

const TEXT_TOKENS: Record<string, string> = {
  Cmd: "Ctrl",
  Command: "Ctrl",
  CmdOrCtrl: "Ctrl",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Plus: "+",
};

/**
 * The chord as a person reads it: symbols on macOS, words elsewhere.
 *
 * Returned as tokens because that is what a key-cap renderer needs, and
 * joining them is trivial where prose is wanted.
 */
export function desktopShortcutTokens(
  id: DesktopBindingId,
  platform: DesktopKeyPlatform
): string[] {
  const table = platform === "mac" ? MAC_SYMBOLS : TEXT_TOKENS;
  return desktopAccelerator(id, platform)
    .split("+")
    .map((token) => table[token] ?? token);
}

/** The chord as one string, for a menu row or a tooltip. */
export function desktopShortcutLabel(id: DesktopBindingId, platform: DesktopKeyPlatform): string {
  const tokens = desktopShortcutTokens(id, platform);
  return platform === "mac" ? tokens.join("") : tokens.join("+");
}

/**
 * One label for a surface that renders on both platforms at once.
 *
 * A panel context menu is built from the same definitions on a Mac and on a
 * Linux box, so where the two chords differ only in the primary modifier it
 * says `Cmd/Ctrl+R`, and where they differ in substance it names both.
 */
export function desktopNeutralShortcutLabel(id: DesktopBindingId): string {
  const mac = desktopAccelerator(id, "mac");
  const other = desktopAccelerator(id, "other");
  if (mac === other) return other;
  const unified = mac.replace(/^Cmd\+/u, "Cmd/Ctrl+");
  if (unified === other.replace(/^Ctrl\+/u, "Cmd/Ctrl+")) return unified;
  return `${mac} / ${other}`;
}

/** A key event, in the one shape this module compares against. */
export interface DesktopKeyInput {
  /** `KeyboardEvent.key`, or Electron's `Input.key`. */
  key: string;
  /** `KeyboardEvent.code`, or Electron's `Input.code`. Used for letter keys. */
  code?: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

function normalizeChordKey(token: string): string {
  const lower = token.toLowerCase();
  if (lower === "plus") return "+";
  if (lower === "esc" || lower === "escape") return "escape";
  if (lower === "left") return "arrowleft";
  if (lower === "right") return "arrowright";
  if (lower === "up") return "arrowup";
  if (lower === "down") return "arrowdown";
  if (lower === "space") return " ";
  return lower;
}

function keyMatches(chordKey: string, input: DesktopKeyInput): boolean {
  const wanted = normalizeChordKey(chordKey);
  if (input.key.toLowerCase() === wanted) return true;
  // A letter typed with a modifier can arrive as the unmodified character on
  // some layouts and as the physical key on others; `code` is the stable one.
  if (wanted.length === 1 && /[a-z0-9]/u.test(wanted)) {
    const code = input.code?.toLowerCase();
    if (code === `key${wanted}` || code === `digit${wanted}`) return true;
  }
  if (wanted === "+" && (input.key === "+" || input.code === "Equal")) return true;
  if (wanted === "=" && (input.key === "=" || input.code === "Equal")) return true;
  if (wanted === "-" && (input.key === "-" || input.code === "Minus")) return true;
  return false;
}

function chordMatches(
  chord: string,
  input: DesktopKeyInput,
  platform: DesktopKeyPlatform
): boolean {
  const tokens = chord.split("+");
  // "Cmd+Shift+Plus" splits into a trailing empty token for chords ending in
  // "+"; the key is the last non-empty token, and "Plus" spells it explicitly.
  const keyToken = tokens[tokens.length - 1] ?? "";
  const modifiers = new Set(tokens.slice(0, -1).map((token) => token.toLowerCase()));
  const wantsPrimary =
    modifiers.has("cmd") || modifiers.has("command") || modifiers.has("cmdorctrl");
  const wantsCtrl = modifiers.has("ctrl") || modifiers.has("control");
  const wantsShift = modifiers.has("shift");
  const wantsAlt = modifiers.has("alt") || modifiers.has("option");

  const expectMeta = platform === "mac" ? wantsPrimary : false;
  const expectCtrl = platform === "mac" ? wantsCtrl : wantsPrimary || wantsCtrl;

  return (
    input.meta === expectMeta &&
    input.ctrl === expectCtrl &&
    input.shift === wantsShift &&
    input.alt === wantsAlt &&
    keyMatches(keyToken, input)
  );
}

/** True when this key event performs the binding, by any of its chords. */
export function matchesDesktopBinding(
  id: DesktopBindingId,
  input: DesktopKeyInput,
  platform: DesktopKeyPlatform
): boolean {
  return desktopChords(id, platform).some((chord) => chordMatches(chord, input, platform));
}

/** The binding this key event performs, if any. First match in listed order. */
export function desktopBindingFor(
  input: DesktopKeyInput,
  platform: DesktopKeyPlatform,
  candidates: readonly DesktopBindingId[]
): DesktopBindingId | null {
  for (const id of candidates) {
    if (matchesDesktopBinding(id, input, platform)) return id;
  }
  return null;
}

/** Which platform's chords apply, from a platform string. */
export function desktopKeyPlatform(platform: string): DesktopKeyPlatform {
  return platform === "darwin" || platform === "mac" || /Mac|iPhone|iPad/u.test(platform)
    ? "mac"
    : "other";
}
