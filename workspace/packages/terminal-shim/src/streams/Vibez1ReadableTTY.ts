import { EventEmitter } from "node:events";

/**
 * Duck-typed readable TTY sufficient for Ink's stdin. Ink (via `useInput`)
 * attaches a `data` listener and expects raw key bytes; it calls `setRawMode`,
 * `setEncoding`, `resume`/`pause`, `ref`/`unref`. Input bytes are injected by
 * the shim runtime (`emitInput`) from host-forwarded keystrokes.
 *
 * `setRawMode` calls back to the host so the host can put the *real* TTY into
 * raw mode (granted only to the focused session). The method exists only so
 * Ink's `isRawModeSupported` detection passes.
 */
export class Vibez1ReadableTTY extends EventEmitter {
  readonly isTTY = true as const;
  isRaw = false;
  isPaused = false;
  readable = true;
  destroyed = false;

  private readonly onRawMode?: (enabled: boolean) => void;

  constructor(onRawMode?: (enabled: boolean) => void) {
    super();
    this.onRawMode = onRawMode;
  }

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    this.onRawMode?.(enabled);
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    this.isPaused = false;
    return this;
  }
  pause(): this {
    this.isPaused = true;
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): null {
    return null;
  }

  /** Internal: deliver host-forwarded input bytes to Ink. */
  push(data: Uint8Array): void {
    if (this.isPaused) return;
    this.emit("data", data);
  }
}
