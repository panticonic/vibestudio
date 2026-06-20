import {
  DurableObjectBase,
  rpc,
  type LifecyclePrepareInput,
  type LifecyclePrepareResult,
  type LifecycleResumeInput,
} from "@natstack/durable";
import { metaMethods } from "@natstack/shared/serviceSchemas/meta";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";

export class LifecycleProbeDO extends DurableObjectBase {
  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_probe_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        input_json TEXT NOT NULL,
        boot_generation TEXT
      )
    `);
  }

  override async prepareForRestart(input: LifecyclePrepareInput): Promise<LifecyclePrepareResult> {
    this.record("prepare", input);
    return { status: "ready" };
  }

  override async resumeAfterRestart(input: LifecycleResumeInput): Promise<void> {
    this.record("resume", input);
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    this.record("alarm", { firedAt: "redacted" });
  }

  /** Schedule a server-driven alarm `delayMs` from now (negative = already due). */
  scheduleAlarm(delayMs: number): { ok: true } {
    this.ensureReady();
    this.setAlarm(delayMs);
    return { ok: true };
  }

  @rpc({ callers: ["server", "harness", "shell"] })
  lifecycleEvents(): Array<{ kind: string; input: unknown; bootGeneration: string | null }> {
    this.ensureReady();
    return this.sql
      .exec(
        `SELECT kind, input_json, boot_generation
         FROM lifecycle_probe_events
         ORDER BY id`
      )
      .toArray()
      .map((row) => ({
        kind: String(row["kind"]),
        input: JSON.parse(String(row["input_json"])),
        bootGeneration: typeof row["boot_generation"] === "string" ? row["boot_generation"] : null,
      }));
  }

  @rpc({ callers: ["server", "harness", "shell"] })
  currentBootGeneration(): string | null {
    const value = this.env["WORKERD_BOOT_GENERATION"];
    return typeof value === "string" ? value : null;
  }

  /** Hold the inbound request open for `ms`, then return — an empirical probe for
   *  whether real workerd caps a long-held DO `fetch` handler (it should not; a DO
   *  is not a regular Worker with the ~30s wall limit). */
  @rpc({ callers: ["server", "harness", "shell"] })
  async sleepProbe(ms: number): Promise<{ requestedMs: number; ok: true }> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { requestedMs: ms, ok: true };
  }

  /**
   * Decisive probe: after this method RETURNS (request ends), does background work
   * run on its own, and does network I/O work in it? Schedules a task (via
   * `ctx.waitUntil` if present, else a floating promise) that, 3s later, records a
   * timestamp + attempts an `rpc.call`. The caller reads `bgRunResult` after a wait.
   * `ran_at - started_at ≈ 3s` ⇒ ran continuously in the background; `≈` the gap
   * until the next request ⇒ the isolate froze and only resumed when re-woken.
   */
  @rpc({ callers: ["server", "harness", "shell"] })
  async bgRunProbe(delayMs = 3000): Promise<{ hasWaitUntil: boolean }> {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS bg (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`INSERT OR REPLACE INTO bg (k, v) VALUES ('started_at', ?)`, String(Date.now()));
    const wu = (this.ctx as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil;
    const task = (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } catch (e) {
        this.sql.exec(
          `INSERT OR REPLACE INTO bg (k, v) VALUES ('ran_at', ?)`,
          "timer-threw:" + String(e)
        );
        return;
      }
      this.sql.exec(`INSERT OR REPLACE INTO bg (k, v) VALUES ('ran_at', ?)`, String(Date.now()));
      try {
        const meta = createTypedServiceClient("meta", metaMethods, (service, method, args) =>
          this.rpc.call("main", `${service}.${method}`, args)
        );
        await meta.listServices();
        this.sql.exec(`INSERT OR REPLACE INTO bg (k, v) VALUES ('bg_io', 'ok')`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.sql.exec(`INSERT OR REPLACE INTO bg (k, v) VALUES ('bg_io', ?)`, msg.slice(0, 180));
      }
    })();
    if (typeof wu === "function") wu.call(this.ctx, task);
    else void task;
    return { hasWaitUntil: typeof wu === "function" };
  }

  @rpc({ callers: ["server", "harness", "shell"] })
  async bgRunResult(): Promise<Record<string, string>> {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS bg (k TEXT PRIMARY KEY, v TEXT)`);
    const out: Record<string, string> = {};
    for (const row of this.sql.exec(`SELECT k, v FROM bg`).toArray()) {
      out[String(row["k"])] = String(row["v"]);
    }
    return out;
  }

  private record(kind: "prepare" | "resume" | "alarm", input: unknown): void {
    this.ensureReady();
    this.sql.exec(
      `INSERT INTO lifecycle_probe_events (kind, input_json, boot_generation)
       VALUES (?, ?, ?)`,
      kind,
      JSON.stringify(input),
      this.currentBootGeneration()
    );
  }
}

export default {
  fetch() {
    return new Response("lifecycle probe");
  },
};
