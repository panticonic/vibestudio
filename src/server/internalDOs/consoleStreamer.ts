/**
 * Self-throttling forwarder for streamed eval console (used by EvalDO to push live console chunks to
 * the owning agent during a held run). `push` accumulates console text; while a forward is in flight,
 * further lines coalesce into the next chunk — so the flush rate naturally matches the forward
 * round-trip (no timer), giving live rolling output without flooding the channel with one event per
 * line. Forwards are best-effort (a dropped chunk is just a gap; the final result still carries the
 * full console). `finalFlush` drains the buffer before the run completes, so every chunk lands before
 * the invocation terminal (the chat reducer drops output that arrives after the terminal).
 *
 * Pure (no DO deps) so it lives outside `evalDO.ts` and can be unit-tested under Node.
 */
export class ConsoleStreamer {
  private buffer = "";
  private flushing = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly forward: (chunk: string) => Promise<void>) {}

  push(line: string): void {
    this.buffer += (this.buffer ? "\n" : "") + line;
    this.kick();
  }

  private kick(): void {
    if (this.flushing || !this.buffer) return;
    const chunk = this.buffer;
    this.buffer = "";
    this.flushing = true;
    this.chain = this.forward(chunk)
      .catch(() => undefined)
      .finally(() => {
        this.flushing = false;
        this.kick(); // drain anything buffered while this forward was in flight
      });
  }

  /** Drain remaining buffered console; resolves once every chunk has been forwarded. */
  async finalFlush(): Promise<void> {
    this.kick();
    while (this.flushing) await this.chain;
  }
}
