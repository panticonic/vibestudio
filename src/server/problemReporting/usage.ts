import {
  UsagePingSchema,
  type UsageMetric,
  type UsagePing,
} from "@vibestudio/service-schemas/usageAnalytics";
import { ProblemReportingStore } from "./store";
import {
  callerAccountUserId,
  createHostCaller,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { reportDigest } from "@vibestudio/service-schemas/problemReportBundle";
import { USAGE_DESTINATION } from "@vibestudio/service-schemas/usageAnalytics";
import type { EgressProxy } from "../services/egressProxy";

export async function sendUsageTransmission(
  egress: Pick<EgressProxy, "forwardHostFetch">,
  subject: VerifiedCaller["subject"],
  transmission: UsagePing,
  signal: AbortSignal
): Promise<{ accepted: boolean }> {
  signal.throwIfAborted();
  const checked = UsagePingSchema.parse(transmission);
  const body = JSON.stringify(checked);
  const result = await egress.forwardHostFetch({
    caller: createHostCaller("usage-counter", "server", subject),
    operation: {
      service: "problemReports",
      method: "usageTransport",
      resourceKey: "usage",
      preparedStateDigest: await reportDigest(body ?? ""),
    },
    method: "POST",
    url: USAGE_DESTINATION,
    credentialId: null,
    headers: { "content-type": "application/json" },
    body,
    signal,
    responseByteLimit: 1024,
  });
  return { accepted: result.status === 204 };
}

const operations: Record<string, UsageMetric> = {
  "app.openShellSurface": "shell-surface-open",
  "view.browserNavigate": "browser-navigation",
  "runtime.createEntity": "entity-created",
  "runtime.createContext": "context-created",
  "runtime.forkSemanticContext": "context-created",
};

let processStartupCounted = false;
function claimProcessStartup(): boolean {
  if (processStartupCounted) return false;
  processStartupCounted = true;
  return true;
}

/** Best-effort aggregate counters, never a report outbox or an identity-bearing event log. */
export class UsageAnalytics {
  private pending = new Map<string, { revision: number; counts: UsagePing["counts"] }>();
  private active = new Set<Promise<void>>();
  private controllers = new Map<string, Set<AbortController>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private runtimeOwner: string | null = null;
  private stopped = false;
  private startupUsageCounted = false;
  constructor(
    private readonly store: ProblemReportingStore,
    private readonly send: (ping: UsagePing, signal: AbortSignal, owner: string) => Promise<void>,
    private readonly claimStartup = claimProcessStartup
  ) {}
  startup(owner: string): { observed: boolean } {
    if (this.stopped) return { observed: false };
    if (!this.claimStartup()) return { observed: false };
    this.runtimeOwner = owner;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.runtimeOwner) this.record(this.runtimeOwner, "reporting-runtime-minutes");
      this.flush();
    }, 60000);
    this.timer.unref();
    this.recordStartupUsage(owner);
    return { observed: true };
  }
  serviceCompleted(
    outcome: { ctx: ServiceContext; service: string; method: string },
    fallbackOwner?: () => string | null
  ): void {
    const metric = operations[`${outcome.service}.${outcome.method}`];
    if (!metric) return;
    const owner = callerAccountUserId(outcome.ctx.caller) ?? fallbackOwner?.();
    if (owner) this.record(owner, metric);
  }
  record(owner: string, metric: UsageMetric): void {
    if (this.stopped) return;
    const consent = this.store.consent(owner);
    if (consent.state !== "on") return;
    let entry = this.pending.get(owner);
    if (entry?.revision !== consent.revision) {
      if (this.pending.size >= 100 && !entry) return;
      this.pending.set(owner, (entry = { revision: consent.revision, counts: {} }));
    }
    if (metric === "startup") entry.counts.startup = 1;
    else entry.counts[metric] = Math.min(10000, (entry.counts[metric] ?? 0) + 1);
    if (!this.timer) {
      this.timer = setInterval(() => this.flush(), 60000);
      this.timer.unref();
    }
  }
  changed(owner: string): void {
    this.pending.delete(owner);
    for (const controller of this.controllers.get(owner) ?? []) controller.abort();
    if (this.runtimeOwner === owner) this.recordStartupUsage(owner);
  }
  private recordStartupUsage(owner: string): void {
    if (!this.startupUsageCounted && this.store.consent(owner).state === "on") {
      this.startupUsageCounted = true;
      this.record(owner, "startup");
    }
  }
  flush(): void {
    const pending = this.pending;
    this.pending = new Map();
    for (const [owner, entry] of pending) {
      const consent = this.store.consent(owner);
      if (consent.state === "on" && consent.revision === entry.revision)
        this.transmit(owner, { schema: "vibestudio.usage.v1", counts: entry.counts });
    }
  }
  private transmit(owner: string, ping: UsagePing): void {
    if (this.stopped || this.active.size >= 4) return;
    const checked = UsagePingSchema.parse(ping);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10000);
    deadline.unref();
    const controllers = this.controllers.get(owner) ?? new Set();
    controllers.add(controller);
    this.controllers.set(owner, controllers);
    const attempt = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return this.send(checked, controller.signal, owner);
      })
      .catch(() => {
        // Never retry ambiguous acceptance, retain events, or block startup. These are approximate counts.
      })
      .finally(() => {
        clearTimeout(deadline);
        controllers.delete(controller);
        if (!controllers.size) this.controllers.delete(owner);
        this.active.delete(attempt);
      });
    this.active.add(attempt);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.pending.clear();
    for (const controllers of this.controllers.values())
      for (const controller of controllers) controller.abort();
    await Promise.allSettled(this.active);
  }
}
