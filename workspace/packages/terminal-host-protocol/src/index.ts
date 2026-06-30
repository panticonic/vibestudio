/**
 * @workspace/terminal-host-protocol
 *
 * Typed protocol between the trusted terminal-browser host app and sandboxed
 * terminal session workers (DOs). Transport is the existing bidirectional RPC
 * (`@vibez1/rpc`): the host exposes the `HOST_METHODS` and the worker exposes
 * the `SESSION_METHODS`; each calls the other by target id. Workers cannot
 * expose *streaming* RPC, so terminal output is delivered as ordered discrete
 * `terminal.onFrame` calls (frames are small — Ink only redraws changed lines).
 *
 * This package defines payloads + codecs only; it prescribes no transport.
 */

export interface TerminalSize {
  columns: number;
  rows: number;
}

export type TerminalStreamName = "stdout" | "stderr";

/** A chunk of terminal output bytes, base64-encoded for the JSON RPC transport. */
export interface TerminalFrame {
  sessionId: string;
  stream: TerminalStreamName;
  /** base64-encoded bytes (JSON transports can't carry raw binary). */
  data: string;
  /** Monotonic per-session sequence for ordering / gap detection. */
  seq: number;
}

export interface TerminalInputEvent {
  sessionId: string;
  /** base64-encoded raw input bytes (keystrokes). */
  data: string;
}

export interface TerminalResizeEvent {
  sessionId: string;
  size: TerminalSize;
}

export type TerminalLifecyclePhase =
  | "started"
  | "focused"
  | "blurred"
  | "closed"
  | "errored";

export interface TerminalLifecycleEvent {
  sessionId: string;
  phase: TerminalLifecyclePhase;
  reason?: string;
}

/** Args the host passes when starting a session on a worker DO. */
export interface StartTerminalSessionArgs {
  sessionId: string;
  /** RPC target id of the host app — the worker calls `terminal.onFrame` on it. */
  hostPrincipalId: string;
  /** Initial viewport (host is authoritative; updated via resize). */
  viewport: TerminalSize;
  /** Context the session runs in (mirrors panel/agent contextId). */
  contextId?: string;
}

/** Methods the SESSION WORKER exposes (host → worker). */
export const SESSION_METHODS = {
  start: "terminal.startSession",
  onInput: "terminal.onInput",
  onResize: "terminal.onResize",
  onFocus: "terminal.onFocus",
  onBlur: "terminal.onBlur",
  onClose: "terminal.onClose",
  /** Ask the worker to emit a full repaint (after an overlay/ focus change). */
  repaint: "terminal.repaint",
} as const;

/** Methods the HOST exposes (worker → host). */
export const HOST_METHODS = {
  onFrame: "terminal.onFrame",
  setTitle: "terminal.setTitle",
  requestClose: "terminal.requestClose",
  setRawMode: "terminal.setRawMode",
} as const;

// ── codecs ──────────────────────────────────────────────────────────────────

const toBase64 = (bytes: Uint8Array): string => {
  // Avoid spreading large arrays onto the call stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  // btoa exists in workerd + Node 18+.
  return btoa(binary);
};

const fromBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

export function encodeFrame(
  sessionId: string,
  stream: TerminalStreamName,
  bytes: Uint8Array,
  seq: number,
): TerminalFrame {
  return { sessionId, stream, data: toBase64(bytes), seq };
}

export function decodeFrameData(frame: Pick<TerminalFrame, "data">): Uint8Array {
  return fromBase64(frame.data);
}

export function encodeInput(sessionId: string, bytes: Uint8Array): TerminalInputEvent {
  return { sessionId, data: toBase64(bytes) };
}

export function decodeInputData(event: Pick<TerminalInputEvent, "data">): Uint8Array {
  return fromBase64(event.data);
}
