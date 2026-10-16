import { VtScreen } from "@vibestudio/shared/vtScreen";

/** How a PTY program ended. */
export interface PtyEnd {
  exitCode: number | null;
  signal: number | null;
}

/**
 * A headless terminal screen fed by one PTY.
 *
 * Output goes into a VT screen model in stream order. A waiter is re-evaluated
 * after every consumed chunk and settles on a match, on the program's end, or
 * on its caller's abort: never on elapsed time.
 */
export class PtyScreen {
  private readonly term: VtScreen;
  private readonly waiters = new Set<() => void>();
  private ended: PtyEnd | null = null;

  constructor(size: { cols: number; rows: number }) {
    // Programs written for a TTY rely on the line discipline's ONLCR.
    this.term = new VtScreen({ cols: size.cols, rows: size.rows, convertEol: true });
  }

  write(data: string): void {
    this.term.write(data);
    this.notify();
  }

  end(end: PtyEnd): void {
    this.ended = end;
    this.notify();
  }

  get exit(): PtyEnd | null {
    return this.ended;
  }

  /** The visible rows, right-trimmed, without trailing blank rows. */
  text(): string {
    const lines = this.term.lines();
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  /** Resolves with the screen once it contains `needle`; rejects if the program ends first. */
  waitForText(needle: string, signal?: AbortSignal): Promise<string> {
    return this.waitFor(
      (screen) => screen.includes(needle),
      `the screen to show ${JSON.stringify(needle)}`,
      signal
    );
  }

  waitForEnd(signal?: AbortSignal): Promise<PtyEnd> {
    signal?.throwIfAborted();
    return new Promise<PtyEnd>((resolve, reject) => {
      const check = () => {
        if (!this.ended) return;
        cleanup();
        resolve(this.ended);
      };
      const abort = () => {
        cleanup();
        reject(signal!.reason);
      };
      const cleanup = () => {
        this.waiters.delete(check);
        signal?.removeEventListener("abort", abort);
      };
      this.waiters.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  private waitFor(
    condition: (screen: string) => boolean,
    description: string,
    signal?: AbortSignal
  ): Promise<string> {
    signal?.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      const check = () => {
        const screen = this.text();
        if (condition(screen)) {
          cleanup();
          resolve(screen);
        } else if (this.ended) {
          cleanup();
          reject(
            Object.assign(
              new Error(
                `The program ended (${describeEnd(this.ended)}) before ${description}; the screen showed:\n${screen}`
              ),
              { code: "ETERMINALENDED", screen }
            )
          );
        }
      };
      const abort = () => {
        cleanup();
        reject(signal!.reason);
      };
      const cleanup = () => {
        this.waiters.delete(check);
        signal?.removeEventListener("abort", abort);
      };
      this.waiters.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  private notify(): void {
    for (const check of [...this.waiters]) check();
  }
}

export function describeEnd(end: PtyEnd): string {
  return end.signal ? `signal ${end.signal}` : `exit code ${end.exitCode ?? "unknown"}`;
}
