/** Pure bounded filesystem values shared by semantic reads and the native disk worker. */
import path from "node:path";

export interface BinaryEnvelope {
  __bin: true;
  data: string; // base64
}

export function isBinaryEnvelope(v: unknown): v is BinaryEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as any).__bin === true &&
    typeof (v as any).data === "string"
  );
}

export function encodeBinary(buf: Buffer): BinaryEnvelope {
  return { __bin: true, data: buf.toString("base64") };
}

export interface GrepOptions {
  /** Directory (or single file) to search, relative to the context root. */
  path?: string;
  /** Glob filter for candidate files (gitignore-style; basename match when slash-free). */
  glob?: string;
  caseInsensitive?: boolean;
  /** Requested lines of context before/after each match. */
  contextLines?: number;
  /** Stop after this many matches (default 200, hard cap 1000). */
  maxMatches?: number;
  /** Include files normally excluded by .gitignore/.ignore. */
  includeIgnored?: boolean;
}

export interface GlobOptions {
  /** Directory to search, relative to the context root. */
  path?: string;
  /** Stop after this many files (default 1000, hard cap 10000). */
  limit?: number;
  /** Resume strictly after this exact path from a previous bounded result. */
  after?: string;
  /** Include files normally excluded by .gitignore/.ignore. */
  includeIgnored?: boolean;
}

export interface GrepMatch {
  file: string;
  lineNumber: number;
  line: string;
  before: string[];
  after: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  matchCount: number;
  truncated: boolean;
}

export interface GlobResult {
  files: string[];
  truncated: boolean;
  /** Exact display path to pass as `after` for the next page. */
  nextCursor?: string;
}

export interface ReadTextOptions {
  /** First line to return (1-indexed). */
  offset?: number;
  /** Maximum lines to return. */
  limit?: number;
  /** Maximum UTF-8 bytes to return. */
  maxBytes?: number;
}

export interface ReadTextResult {
  text: string;
  contentHash: string;
  totalLines: number;
  totalBytes: number;
  maxLines: number;
  maxBytes: number;
  startLine: number;
  endLine: number;
  start: number;
  end: number;
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  nextOffset?: number;
  firstLineExceedsLimit: boolean;
}

export interface ReadBytesOptions {
  /** First byte to return (zero-based). */
  offset?: number;
  /** Maximum raw bytes to return. */
  limit?: number;
}

export interface ReadBytesResult {
  base64: string;
  contentHash: string;
  totalBytes: number;
  maxBytes: number;
  start: number;
  end: number;
  truncated: boolean;
  nextOffset?: number;
}

export const READ_TEXT_DEFAULT_LINES = 2_000;

export const READ_TEXT_MAX_LINES = 10_000;

export const READ_TEXT_DEFAULT_BYTES = 50 * 1024;

export const READ_TEXT_MAX_BYTES = 1024 * 1024;

export const READ_BYTES_DEFAULT_LIMIT = 50 * 1024;

export const READ_BYTES_MAX_LIMIT = 1024 * 1024;

export function normalizedReadBytesOptions(
  options: ReadBytesOptions = {}
): Required<ReadBytesOptions> {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? READ_BYTES_DEFAULT_LIMIT;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError("readBytes offset must be a non-negative integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_BYTES_MAX_LIMIT) {
    throw new RangeError(`readBytes limit must be an integer from 1 to ${READ_BYTES_MAX_LIMIT}`);
  }
  return { offset, limit };
}

export function byteRangeResult(
  bytes: Buffer,
  totalBytes: number,
  contentHash: string,
  options: Required<ReadBytesOptions>
): ReadBytesResult {
  const start = Math.min(options.offset, totalBytes);
  const end = Math.min(totalBytes, options.offset + bytes.length);
  const truncated = end < totalBytes;
  return {
    base64: bytes.toString("base64"),
    contentHash,
    totalBytes,
    maxBytes: options.limit,
    start,
    end,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
  };
}

export function normalizedReadTextOptions(
  options: ReadTextOptions = {}
): Required<ReadTextOptions> {
  const offset = options.offset ?? 1;
  const limit = options.limit ?? READ_TEXT_DEFAULT_LINES;
  const maxBytes = options.maxBytes ?? READ_TEXT_DEFAULT_BYTES;
  if (!Number.isInteger(offset) || offset < 1) {
    throw new RangeError("readText offset must be a positive integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_TEXT_MAX_LINES) {
    throw new RangeError(`readText limit must be an integer from 1 to ${READ_TEXT_MAX_LINES}`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > READ_TEXT_MAX_BYTES) {
    throw new RangeError(`readText maxBytes must be an integer from 1 to ${READ_TEXT_MAX_BYTES}`);
  }
  return { offset, limit, maxBytes };
}

export class TextRangeAccumulator {
  private lineNumber = 1;
  private utf16Offset = 0;
  private readonly selected: string[] = [];
  private selectedBytes = 0;
  private selectedStart = 0;
  private selectedEnd = 0;
  private stoppedBy: "lines" | "bytes" | undefined;
  private firstLineExceedsLimit = false;
  private currentLineParts: string[] = [];
  private currentLineLength = 0;
  private currentLineBytes = 0;

  constructor(private readonly options: Required<ReadTextOptions>) {}

  push(text: string): void {
    let start = 0;
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      this.appendFragment(text.slice(start, newline));
      this.finishLine(true);
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    this.appendFragment(text.slice(start));
  }

  finish(contentHash: string, totalBytes: number): ReadTextResult {
    // `String.prototype.split("\n")` has one final line even for empty input
    // and one trailing empty line when the file ends in a newline.
    this.finishLine(false);
    const totalLines = this.lineNumber - 1;
    const startLine = this.options.offset;
    if (this.selected.length === 0 && startLine > totalLines) {
      this.selectedStart = this.utf16Offset;
      this.selectedEnd = this.utf16Offset;
    }
    const endLine = this.selected.length > 0 ? startLine + this.selected.length - 1 : startLine - 1;
    const moreLines = endLine < totalLines;
    return {
      text: this.selected.join("\n"),
      contentHash,
      totalLines,
      totalBytes,
      maxLines: this.options.limit,
      maxBytes: this.options.maxBytes,
      startLine,
      endLine,
      start: this.selectedStart,
      end: this.selectedEnd,
      truncated: moreLines,
      ...(moreLines && this.stoppedBy ? { truncatedBy: this.stoppedBy } : {}),
      ...(moreLines ? { nextOffset: Math.max(startLine + 1, endLine + 1) } : {}),
      firstLineExceedsLimit: this.firstLineExceedsLimit,
    };
  }

  private appendFragment(fragment: string): void {
    this.currentLineLength += fragment.length;
    if (this.lineNumber < this.options.offset || this.stoppedBy) return;
    if (this.selected.length >= this.options.limit) {
      this.stoppedBy = "lines";
      return;
    }
    this.currentLineBytes += Buffer.byteLength(fragment, "utf8");
    const separatorBytes = this.selected.length > 0 ? 1 : 0;
    if (this.selectedBytes + separatorBytes + this.currentLineBytes > this.options.maxBytes) {
      this.stoppedBy = "bytes";
      this.firstLineExceedsLimit = this.selected.length === 0;
      if (this.selected.length === 0) this.selectedStart = this.utf16Offset;
      this.currentLineParts = [];
      return;
    }
    this.currentLineParts.push(fragment);
  }

  private finishLine(hadNewline: boolean): void {
    const currentLine = this.lineNumber;
    const currentStart = this.utf16Offset;
    this.lineNumber += 1;
    this.utf16Offset += this.currentLineLength + (hadNewline ? 1 : 0);
    if (currentLine < this.options.offset || this.stoppedBy) {
      this.resetCurrentLine();
      return;
    }
    if (this.selected.length >= this.options.limit) {
      this.stoppedBy = "lines";
      this.resetCurrentLine();
      return;
    }
    if (this.selected.length === 0) this.selectedStart = currentStart;
    const line = this.currentLineParts.join("");
    this.selected.push(line);
    this.selectedBytes += this.currentLineBytes + (this.selected.length > 1 ? 1 : 0);
    this.selectedEnd = currentStart + line.length;
    this.resetCurrentLine();
  }

  private resetCurrentLine(): void {
    this.currentLineParts = [];
    this.currentLineLength = 0;
    this.currentLineBytes = 0;
  }
}

export function globSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) {
        out += "\\[";
        i += 1;
      } else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        out += `[${cls}]`;
        i = end + 1;
      }
    } else if (c === "{") {
      const end = glob.indexOf("}", i + 1);
      if (end === -1) {
        out += "\\{";
        i += 1;
      } else {
        const parts = glob.slice(i + 1, end).split(",");
        out += `(?:${parts.map(globSource).join("|")})`;
        i = end + 1;
      }
    } else {
      out += c.replace(/[.+^$()|\\\]}]/g, "\\$&");
      i += 1;
    }
  }
  return out;
}

export function matchesGlob(relPath: string, pattern: string): boolean {
  const subject = pattern.includes("/") ? relPath : path.posix.basename(relPath);
  return new RegExp(`^${globSource(pattern)}$`).test(subject);
}
