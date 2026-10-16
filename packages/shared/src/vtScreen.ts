/**
 * A small VT screen model for reading what a terminal program shows.
 *
 * System tests run in the eval sandbox, which has no `process` or `window`;
 * the usual headless emulators assume one of them while loading, so this unit
 * carries the little it needs: printable text (UTF-8 across chunks, wide
 * characters), the C0 controls, cursor movement and addressing, erase, line
 * and character insert/delete, scroll regions, scrolling, save/restore
 * cursor, and the alternate screen. Colours, modes and other
 * presentation-only sequences are parsed and ignored. Only the visible rows
 * are kept; there is no scrollback.
 */

export interface VtScreenOptions {
  cols: number;
  rows: number;
  /** Treat LF as CR LF (the line discipline's ONLCR). */
  convertEol?: boolean;
  /** DEC synchronized-output frame completion, independent of transport chunks. */
  onFrame?: () => void;
}

interface Buffer {
  cells: string[][];
}

type ParserState = "ground" | "escape" | "escape-intermediate" | "csi" | "osc" | "string" | "charset";

function codepointWidth(code: number): 0 | 1 | 2 {
  if (code < 0x20) return 0;
  if (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0x20e3
  )
    return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  )
    return 2;
  return 1;
}

export class VtScreen {
  #cols: number;
  #rows: number;
  readonly #convertEol: boolean;
  #main: Buffer;
  #alt: Buffer;
  #buffer: Buffer;
  #x = 0;
  #y = 0;
  #wrapPending = false;
  #saved = { x: 0, y: 0 };
  #top = 0;
  #bottom: number;
  #state: ParserState = "ground";
  #csi = "";
  #oscEscape = false;
  readonly #decoder = new TextDecoder("utf-8");
  readonly #onFrame?: () => void;
  #synchronized = false;
  #presented: string[] | null = null;

  constructor(options: VtScreenOptions) {
    this.#cols = options.cols;
    this.#rows = options.rows;
    this.#convertEol = options.convertEol ?? false;
    this.#onFrame = options.onFrame;
    this.#bottom = this.#rows - 1;
    this.#main = this.#blank();
    this.#alt = this.#blank();
    this.#buffer = this.#main;
  }

  get rows(): number {
    return this.#rows;
  }

  /** The visible rows, right-trimmed. */
  lines(): string[] {
    if (this.#presented) return [...this.#presented];
    return this.#buffer.cells.map((row) => row.join("").replace(/\s+$/u, ""));
  }

  get synchronized(): boolean { return this.#synchronized; }

  reset(): void {
    this.#main = this.#blank();
    this.#alt = this.#blank();
    this.#buffer = this.#main;
    this.#x = this.#y = 0;
    this.#wrapPending = false;
    this.#top = 0;
    this.#bottom = this.#rows - 1;
    this.#state = "ground";
    this.#synchronized = false;
    this.#presented = null;
  }

  write(data: Uint8Array | string): void {
    const text = typeof data === "string" ? data : this.#decoder.decode(data, { stream: true });
    for (const char of text) this.#feed(char);
  }

  #blank(): Buffer {
    return { cells: Array.from({ length: this.#rows }, () => Array.from({ length: this.#cols }, () => " ")) };
  }

  #feed(char: string): void {
    const code = char.codePointAt(0)!;
    switch (this.#state) {
      case "ground":
        if (code === 0x1b) this.#state = "escape";
        else if (code < 0x20 || code === 0x7f) this.#control(code);
        else this.#print(char);
        return;
      case "escape":
        this.#escape(char);
        return;
      case "escape-intermediate":
        this.#state = "ground";
        return;
      case "charset":
        this.#state = "ground";
        return;
      case "csi":
        if (code >= 0x40 && code <= 0x7e) {
          const params = this.#csi;
          this.#csi = "";
          this.#state = "ground";
          this.#dispatchCsi(params, char);
        } else if (code === 0x1b) {
          this.#csi = "";
          this.#state = "escape";
        } else if (code >= 0x20) this.#csi += char;
        return;
      case "osc":
      case "string":
        // Ends at BEL or ST (ESC \).
        if (code === 0x07 && this.#state === "osc") this.#state = "ground";
        else if (this.#oscEscape && char === "\\") {
          this.#state = "ground";
          this.#oscEscape = false;
        } else this.#oscEscape = code === 0x1b;
        if (this.#state === "ground") this.#oscEscape = false;
        return;
    }
  }

  #control(code: number): void {
    switch (code) {
      case 0x08:
        this.#wrapPending = false;
        this.#x = Math.max(0, this.#x - 1);
        return;
      case 0x09:
        this.#wrapPending = false;
        this.#x = Math.min(this.#cols - 1, (Math.floor(this.#x / 8) + 1) * 8);
        return;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        if (this.#convertEol) this.#x = 0;
        this.#lineFeed();
        return;
      case 0x0d:
        this.#wrapPending = false;
        this.#x = 0;
        return;
      default:
        return;
    }
  }

  #escape(char: string): void {
    this.#state = "ground";
    switch (char) {
      case "[":
        this.#state = "csi";
        this.#csi = "";
        return;
      case "]":
        this.#state = "osc";
        this.#oscEscape = false;
        return;
      case "P":
      case "_":
      case "^":
      case "X":
        this.#state = "string";
        this.#oscEscape = false;
        return;
      case "(":
      case ")":
      case "*":
      case "+":
        this.#state = "charset";
        return;
      case " ":
      case "#":
      case "%":
        this.#state = "escape-intermediate";
        return;
      case "7":
        this.#saved = { x: this.#x, y: this.#y };
        return;
      case "8":
        this.#x = this.#saved.x;
        this.#y = this.#saved.y;
        this.#wrapPending = false;
        return;
      case "D":
        this.#lineFeed();
        return;
      case "E":
        this.#x = 0;
        this.#lineFeed();
        return;
      case "M":
        this.#reverseIndex();
        return;
      case "c":
        this.reset();
        return;
      default:
        return;
    }
  }

  #print(char: string): void {
    const width = codepointWidth(char.codePointAt(0)!);
    if (width === 0) return;
    if (this.#wrapPending || this.#x + width > this.#cols) {
      this.#x = 0;
      this.#lineFeed();
    }
    const row = this.#buffer.cells[this.#y]!;
    row[this.#x] = char;
    if (width === 2 && this.#x + 1 < this.#cols) row[this.#x + 1] = "";
    this.#x += width;
    if (this.#x >= this.#cols) {
      this.#x = this.#cols - 1;
      this.#wrapPending = true;
    } else this.#wrapPending = false;
  }

  #lineFeed(): void {
    this.#wrapPending = false;
    if (this.#y === this.#bottom) this.#scrollUp(1);
    else if (this.#y < this.#rows - 1) this.#y += 1;
  }

  #reverseIndex(): void {
    this.#wrapPending = false;
    if (this.#y === this.#top) this.#scrollDown(1);
    else if (this.#y > 0) this.#y -= 1;
  }

  #blankRow(): string[] {
    return Array.from({ length: this.#cols }, () => " ");
  }

  #scrollUp(count: number): void {
    const cells = this.#buffer.cells;
    for (let i = 0; i < count; i++) {
      cells.splice(this.#top, 1);
      cells.splice(this.#bottom, 0, this.#blankRow());
    }
  }

  #scrollDown(count: number): void {
    const cells = this.#buffer.cells;
    for (let i = 0; i < count; i++) {
      cells.splice(this.#bottom, 1);
      cells.splice(this.#top, 0, this.#blankRow());
    }
  }

  #dispatchCsi(raw: string, final: string): void {
    const marker = /^[?<=>]/u.test(raw) ? raw[0]! : "";
    const body = marker ? raw.slice(1) : raw;
    const numbers = body.split(/[;:]/u).map((part) => (part === "" ? NaN : Number.parseInt(part, 10)));
    const param = (index: number, fallback: number): number => {
      const value = numbers[index];
      return value === undefined || Number.isNaN(value) || value === 0 ? fallback : value;
    };
    const raw0 = Number.isNaN(numbers[0] ?? NaN) ? 0 : (numbers[0] ?? 0);
    const cells = this.#buffer.cells;
    const row = cells[this.#y]!;
    this.#wrapPending = false;
    if (marker === "?" && (final === "h" || final === "l")) {
      for (const mode of numbers) {
        if (mode === 2026) {
          if (final === "h") {
            if (!this.#synchronized) this.#presented = this.lines();
            this.#synchronized = true;
          } else {
            this.#synchronized = false;
            this.#presented = null;
            this.#onFrame?.();
          }
        }
        if (mode === 1049 || mode === 1047 || mode === 47) {
          const enter = final === "h";
          if (enter) {
            if (mode === 1049) this.#saved = { x: this.#x, y: this.#y };
            this.#alt = this.#blank();
            this.#buffer = this.#alt;
          } else {
            this.#buffer = this.#main;
            if (mode === 1049) {
              this.#x = this.#saved.x;
              this.#y = this.#saved.y;
            }
          }
        }
      }
      return;
    }
    if (marker) return;
    switch (final) {
      case "A":
        this.#y = Math.max(this.#top, this.#y - param(0, 1));
        return;
      case "B":
        this.#y = Math.min(this.#bottom, this.#y + param(0, 1));
        return;
      case "C":
        this.#x = Math.min(this.#cols - 1, this.#x + param(0, 1));
        return;
      case "D":
        this.#x = Math.max(0, this.#x - param(0, 1));
        return;
      case "E":
        this.#x = 0;
        this.#y = Math.min(this.#bottom, this.#y + param(0, 1));
        return;
      case "F":
        this.#x = 0;
        this.#y = Math.max(this.#top, this.#y - param(0, 1));
        return;
      case "G":
        this.#x = Math.min(this.#cols - 1, param(0, 1) - 1);
        return;
      case "H":
      case "f":
        this.#y = Math.min(this.#rows - 1, param(0, 1) - 1);
        this.#x = Math.min(this.#cols - 1, param(1, 1) - 1);
        return;
      case "d":
        this.#y = Math.min(this.#rows - 1, param(0, 1) - 1);
        return;
      case "J":
        if (raw0 === 0) {
          row.fill(" ", this.#x);
          for (let y = this.#y + 1; y < this.#rows; y++) cells[y]!.fill(" ");
        } else if (raw0 === 1) {
          row.fill(" ", 0, this.#x + 1);
          for (let y = 0; y < this.#y; y++) cells[y]!.fill(" ");
        } else for (const r of cells) r.fill(" ");
        return;
      case "K":
        if (raw0 === 0) row.fill(" ", this.#x);
        else if (raw0 === 1) row.fill(" ", 0, this.#x + 1);
        else row.fill(" ");
        return;
      case "L": {
        if (this.#y < this.#top || this.#y > this.#bottom) return;
        for (let i = 0; i < param(0, 1); i++) {
          cells.splice(this.#bottom, 1);
          cells.splice(this.#y, 0, this.#blankRow());
        }
        return;
      }
      case "M": {
        if (this.#y < this.#top || this.#y > this.#bottom) return;
        for (let i = 0; i < param(0, 1); i++) {
          cells.splice(this.#y, 1);
          cells.splice(this.#bottom, 0, this.#blankRow());
        }
        return;
      }
      case "P":
        row.splice(this.#x, param(0, 1));
        while (row.length < this.#cols) row.push(" ");
        return;
      case "@":
        row.splice(this.#x, 0, ...Array.from({ length: param(0, 1) }, () => " "));
        row.length = this.#cols;
        return;
      case "X":
        row.fill(" ", this.#x, Math.min(this.#cols, this.#x + param(0, 1)));
        return;
      case "S":
        this.#scrollUp(param(0, 1));
        return;
      case "T":
        this.#scrollDown(param(0, 1));
        return;
      case "s":
        this.#saved = { x: this.#x, y: this.#y };
        return;
      case "u":
        this.#x = this.#saved.x;
        this.#y = this.#saved.y;
        return;
      case "r": {
        const top = param(0, 1) - 1;
        const bottom = Math.min(this.#rows - 1, param(1, this.#rows) - 1);
        if (top < bottom) {
          this.#top = top;
          this.#bottom = bottom;
          this.#x = 0;
          this.#y = 0;
        }
        return;
      }
      default:
        return;
    }
  }
}
