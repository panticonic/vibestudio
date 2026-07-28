/**
 * Keeps an asynchronous state projection converged when notifications are
 * merely hints that the authoritative state may have changed.
 *
 * Requests are coalesced, but a request received while a sync is running is
 * never discarded: it is replayed immediately after that sync settles. A
 * non-terminal result may also request a delayed level check, so correctness
 * does not depend on observing every event edge.
 */
export class AsyncStateConvergenceLoop<Result> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private pending = false;
  private generation = 0;

  constructor(
    private readonly sync: () => Promise<Result>,
    private readonly shouldPoll: (result: Result) => boolean,
    private readonly pollDelayMs: number
  ) {}

  start(): void {
    this.stop();
    this.request();
  }

  request(delayMs = 0): void {
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    if (this.timer) {
      // An immediate state-change notification supersedes a delayed level
      // check. Two immediate notifications still coalesce into one sync.
      if (delayMs > 0) return;
      clearTimeout(this.timer);
      this.timer = null;
    }
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      this.inFlight = true;
      let poll = false;
      void this.sync()
        .then((result) => {
          if (generation !== this.generation) return;
          poll = this.shouldPoll(result);
        })
        .finally(() => {
          this.inFlight = false;
          if (generation !== this.generation) return;
          if (this.pending) {
            this.pending = false;
            this.request();
          } else if (poll) {
            this.request(this.pollDelayMs);
          }
        });
    }, delayMs);
  }

  stop(): void {
    this.generation += 1;
    this.pending = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
