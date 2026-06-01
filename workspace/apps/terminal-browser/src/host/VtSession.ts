import xterm from "@xterm/headless";
import type { TerminalSize } from "@workspace/terminal-host-protocol";

// @xterm/headless ships CJS; the Terminal class is on the default export.
const { Terminal } = xterm as unknown as { Terminal: typeof import("@xterm/headless").Terminal };

/**
 * A headless VT emulator for one worker session. The worker's Ink output (raw
 * ANSI, relative-cursor) is fed in via `write`; the host reads the resulting
 * cell grid via `grid()` and re-renders it inside its own single Ink frame.
 * This is the proven "Option B" that lets host chrome and worker output
 * coexist (two Inks writing one TTY corrupt each other).
 *
 * `convertEol: true` is required: Ink emits bare `\n`, relying on the TTY's
 * ONLCR translation; without it every line drifts right. (Learned in the spike.)
 */
export class VtSession {
  private readonly term: InstanceType<typeof Terminal>;
  private readonly decoder = new TextDecoder();
  size: TerminalSize;

  constructor(size: TerminalSize) {
    this.size = { ...size };
    this.term = new Terminal({
      cols: size.columns,
      rows: size.rows,
      allowProposedApi: true,
      scrollback: 1000,
      convertEol: true,
    });
  }

  /**
   * Feed worker output into the emulator. xterm parses asynchronously (the
   * callback fires once the chunk is applied), so this resolves only after the
   * grid reflects the bytes — callers await before reading `grid()`.
   */
  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve) => this.term.write(this.decoder.decode(bytes), resolve));
  }

  resize(size: TerminalSize): void {
    this.size = { ...size };
    this.term.resize(size.columns, size.rows);
  }

  /** The visible viewport as trimmed text rows (what the host composites). */
  grid(): string[] {
    const buffer = this.term.buffer.active;
    const rows: string[] = [];
    const top = buffer.viewportY;
    for (let y = 0; y < this.size.rows; y++) {
      const line = buffer.getLine(top + y);
      rows.push(line ? line.translateToString(true) : "");
    }
    return rows;
  }

  /**
   * The visible viewport as styled runs per row, preserving the worker's
   * colors and attributes. Adjacent cells with identical style merge into one
   * run so the host can render each as an Ink `<Text color=… bold=…>` span.
   */
  styledGrid(): StyledRun[][] {
    const buffer = this.term.buffer.active;
    const top = buffer.viewportY;
    const rows: StyledRun[][] = [];
    for (let y = 0; y < this.size.rows; y++) {
      const line = buffer.getLine(top + y);
      rows.push(line ? styleRow(line) : []);
    }
    return rows;
  }

  dispose(): void {
    this.term.dispose();
  }
}

// ── styled compositing ───────────────────────────────────────────────────────

/** A run of same-styled cells, rendered as one Ink `<Text>` span. */
export interface StyledRun {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}

// xterm system palette 0–15 → Ink/chalk color keywords.
const ANSI_16 = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "gray", "redBright", "greenBright", "yellowBright",
  "blueBright", "magentaBright", "cyanBright", "whiteBright",
];

function hex6(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** Map an xterm 256-palette index to a hex color (cube + grayscale ramp). */
function paletteHex(i: number): string {
  if (i < 16) return ANSI_16[i] ?? "white";
  if (i >= 232) {
    const v = 8 + (i - 232) * 10;
    return hex6((v << 16) | (v << 8) | v);
  }
  const c = i - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  const r = levels[Math.floor(c / 36) % 6]!;
  const g = levels[Math.floor(c / 6) % 6]!;
  const b = levels[c % 6]!;
  return hex6((r << 16) | (g << 8) | b);
}

type Cellish = {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  isFgDefault(): boolean;
  isFgRGB(): boolean;
  isFgPalette(): boolean;
  getBgColor(): number;
  isBgDefault(): boolean;
  isBgRGB(): boolean;
  isBgPalette(): boolean;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isInverse(): number;
  isStrikethrough(): number;
};

function fgColor(cell: Cellish): string | undefined {
  if (cell.isFgDefault()) return undefined;
  if (cell.isFgRGB()) return hex6(cell.getFgColor());
  if (cell.isFgPalette()) return paletteHex(cell.getFgColor());
  return undefined;
}
function bgColor(cell: Cellish): string | undefined {
  if (cell.isBgDefault()) return undefined;
  if (cell.isBgRGB()) return hex6(cell.getBgColor());
  if (cell.isBgPalette()) return paletteHex(cell.getBgColor());
  return undefined;
}

function sameStyle(a: StyledRun, c: Cellish): boolean {
  return (
    a.fg === fgColor(c) &&
    a.bg === bgColor(c) &&
    a.bold === !!c.isBold() &&
    a.dim === !!c.isDim() &&
    a.italic === !!c.isItalic() &&
    a.underline === !!c.isUnderline() &&
    a.inverse === !!c.isInverse() &&
    a.strikethrough === !!c.isStrikethrough()
  );
}

function styleRow(line: import("@xterm/headless").IBufferLine): StyledRun[] {
  const runs: StyledRun[] = [];
  let current: StyledRun | null = null;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x) as unknown as Cellish | undefined;
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // combining / 2nd half of wide char
    const chars = cell.getChars() || " ";
    if (current && sameStyle(current, cell)) {
      current.text += chars;
      continue;
    }
    current = {
      text: chars,
      fg: fgColor(cell),
      bg: bgColor(cell),
      bold: !!cell.isBold(),
      dim: !!cell.isDim(),
      italic: !!cell.isItalic(),
      underline: !!cell.isUnderline(),
      inverse: !!cell.isInverse(),
      strikethrough: !!cell.isStrikethrough(),
    };
    runs.push(current);
  }
  // Trim trailing all-whitespace default run (matches translateToString(true)).
  while (runs.length > 0) {
    const last = runs[runs.length - 1]!;
    if (last.text.trim() === "" && !last.bg && !last.underline && !last.inverse) runs.pop();
    else break;
  }
  return runs;
}
