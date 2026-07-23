/**
 * Self-throttling forwarder for streamed eval console (used by EvalDO to push live console chunks to
 * the owning agent during a held run). `push` accumulates console text; while a forward is in flight,
 * further lines coalesce into the next chunk — so the flush rate naturally matches the forward
 * round-trip (no timer), giving live rolling output without flooding the channel with one event per
 * line. Forwards are best-effort (a dropped chunk is just a gap; the final result still carries the
 * full console). Closing the streamer aborts any in-flight forward and drops buffered progress. The
 * canonical terminal result must never wait for an incidental progress receiver.
 *
 * Pure (no DO deps) so it lives outside `evalDO.ts` and can be unit-tested under Node.
 */
export class ConsoleStreamer {
  private buffer = "";
  private flushing = false;
  private closed = false;
  private forwardController: AbortController | null = null;

  constructor(private readonly forward: (chunk: string, signal: AbortSignal) => Promise<void>) {}

  push(line: string): void {
    if (this.closed) return;
    this.buffer += (this.buffer ? "\n" : "") + line;
    this.kick();
  }

  private kick(): void {
    if (this.closed || this.flushing || !this.buffer) return;
    const chunk = this.buffer;
    this.buffer = "";
    this.flushing = true;
    const controller = new AbortController();
    this.forwardController = controller;
    void this.forward(chunk, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.forwardController === controller) this.forwardController = null;
        this.flushing = false;
        this.kick(); // drain anything buffered while this forward was in flight
      });
  }

  /** Stop best-effort progress delivery without delaying the canonical terminal result. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = "";
    this.forwardController?.abort();
    this.forwardController = null;
  }
}
