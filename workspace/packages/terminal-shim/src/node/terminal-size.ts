/**
 * Replacement for the `terminal-size` npm package inside workerd.
 *
 * The real package imports `execFileSync` from `node:child_process` (to shell
 * out to `tput`/`resize`), which is unavailable in workerd. Ink only needs a
 * size; the host is authoritative, so we return a size backed by a mutable
 * holder the shim runtime updates on resize events.
 */
export interface TerminalSize {
  columns: number;
  rows: number;
}

// Mutable current size, updated by createInkTerminalSession on resize.
const current: TerminalSize = { columns: 80, rows: 24 };

/** Internal: the shim runtime calls this when the host reports a resize. */
export function __setTerminalSize(size: TerminalSize): void {
  current.columns = size.columns;
  current.rows = size.rows;
}

export default function terminalSize(): TerminalSize {
  return { columns: current.columns, rows: current.rows };
}
