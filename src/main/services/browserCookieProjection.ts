import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BrowserCookieInput,
  BrowserCookieKey,
  BrowserCookieMutation,
  BrowserDataClient,
  BrowserEnvironmentIdentity,
  StoredCookie,
} from "@vibestudio/browser-data";
import {
  browserCookiePartitionStorageKey,
  normalizeCookieExpirationSeconds,
} from "@vibestudio/browser-data";
import { browserEnvironmentPartition } from "@vibestudio/shared/panelInterfaces";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
import type { ManagedService } from "@vibestudio/shared/managedService";
import { createDevLogger } from "@vibestudio/dev-log";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import type { EventName } from "@vibestudio/shared/events";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { workspaceProviderExtensionPackageName } from "@vibestudio/workspace/configParser";
import type { ServerClient } from "../serverClient.js";
import { ChromiumCookieJar, type BrowserCookieJar } from "./chromiumCookieJar.js";

const log = createDevLogger("BrowserCookieProjection");

const EXTENSION_WAIT_INTERVAL_MS = 3_000;

function isExtensionUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Extension is not installed|Extension failed to start|Unknown service|ENOEXT|ENOTREADY/i.test(
    message
  );
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function waitForExtensionRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, EXTENSION_WAIT_INTERVAL_MS);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry in the service's background lifecycle while the extension activates. */
async function retryWhileExtensionUnavailable<T>(
  call: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let waitingLogged = false;
  for (;;) {
    if (signal.aborted) throw abortError(signal);
    try {
      return await call();
    } catch (error) {
      if (!isExtensionUnavailableError(error)) throw error;
      if (!waitingLogged) {
        waitingLogged = true;
        log.info(
          "browser-data extension is not ready; cookie projection will attach in background"
        );
      }
      await waitForExtensionRetry(signal);
    }
  }
}

const REVISION_DEBOUNCE_MS = 150;
const FULL_RECONCILE_INTERVAL_MS = 60_000;

/** Mirrors RUNTIME_RESTARTING_ERROR_CODE in src/server/doDispatch.ts. */
const RUNTIME_RESTARTING_ERROR_CODE = "runtime_restarting";

/**
 * True for the typed dispatch failure raised while the server's workerd
 * runtime is mid generation transition. Checked structurally (code/errorCode
 * survive the RPC boundary) with a message fallback for transports that only
 * preserve prose.
 */
function isRuntimeRestartingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, errorCode, message } = error as {
    code?: unknown;
    errorCode?: unknown;
    message?: unknown;
  };
  if (code === RUNTIME_RESTARTING_ERROR_CODE || errorCode === RUNTIME_RESTARTING_ERROR_CODE) {
    return true;
  }
  return typeof message === "string" && message.includes(RUNTIME_RESTARTING_ERROR_CODE);
}

interface OutboxRecord {
  sequence: number;
  mutation: BrowserCookieMutation;
}

export interface BrowserCookieProjectionDiagnostics {
  revision: number;
  hostId: string;
  converged: boolean;
  mismatchCount: number;
  outboxDepth: number;
  lastError?: string;
}

export interface BrowserCookieProjectionApi {
  identity: BrowserEnvironmentIdentity;
  partition: string;
  flush(origins?: string[]): Promise<{ revision: number }>;
  reconcile(): Promise<void>;
  diagnostics(): BrowserCookieProjectionDiagnostics;
  notifyCanonicalRevision(): void;
}

export function createBrowserCookieProjectionService(deps: {
  browserDataClient: BrowserDataClient;
  serverClient: ServerClient;
  hostId: string;
  outboxRoot: string;
  createCookieJar?(partition: string): BrowserCookieJar;
  onInitializing?(): void;
  onUnavailable?(error: unknown): void | Promise<void>;
  onReady?(api: BrowserCookieProjectionApi): void | Promise<void>;
  onStopped?(): void | Promise<void>;
}): ManagedService {
  let projection: BrowserCookieProjection | null = null;
  let stopListening: (() => void) | null = null;
  let initializationController: AbortController | null = null;
  let initializationTask: Promise<void> | null = null;
  let hostIntegrationActive = false;
  const events = new EventsClient({
    stream(targetId, method, args, options) {
      if (targetId !== "main") throw new Error(`Unexpected browser projection target: ${targetId}`);
      const dot = method.indexOf(".");
      return deps.serverClient.stream(method.slice(0, dot), method.slice(dot + 1), args, options);
    },
  });

  const stopHostIntegration = async (): Promise<void> => {
    if (!hostIntegrationActive) return;
    hostIntegrationActive = false;
    await deps.onStopped?.();
  };

  const initialize = async (signal: AbortSignal): Promise<void> => {
    let candidate: BrowserCookieProjection | null = null;
    let candidateStopListening: (() => void) | null = null;
    let attached = false;
    try {
      const identity = await retryWhileExtensionUnavailable(
        () => deps.browserDataClient.getBrowserEnvironment(),
        signal
      );
      if (signal.aborted) throw abortError(signal);

      const partition = browserEnvironmentPartition(identity.environmentKey);
      const cookieJar = deps.createCookieJar?.(partition) ?? new ChromiumCookieJar(partition);
      candidate = new BrowserCookieProjection({
        browserDataClient: deps.browserDataClient,
        cookieJar,
        identity,
        partition,
        hostId: deps.hostId,
        outboxPath: path.join(
          deps.outboxRoot,
          "browser-environments",
          identity.environmentKey,
          "cookie-outbox.json"
        ),
      });
      // The browser-data extension can report its environment before its DO
      // service has been admitted by the workspace workerd. Probe the same
      // operation used by reconciliation and keep the projection in its
      // existing background-attach retry path instead of attaching a broken
      // projection and emitting a reconciliation warning on every startup.
      await retryWhileExtensionUnavailable(
        () => deps.browserDataClient.getCookieSnapshot(),
        signal
      );
      await candidate.start();
      if (signal.aborted) throw abortError(signal);

      // Lifecycle awareness: cookie state lives in a workerd-hosted DO, so
      // reconciliation is pointless while the runtime is offline/restarting.
      // Pause the reconcile loop on the restart signal and resume on the
      // readiness signal — event-driven, no polling clock of its own.
      const stopHealthListening = events.on("server-health" as EventName, (payload) => {
        const workerd =
          payload && typeof payload === "object"
            ? (payload as { workerd?: unknown }).workerd
            : undefined;
        if (workerd === "restarting") {
          candidate?.pauseForRuntimeRestart();
          projection?.pauseForRuntimeRestart();
        } else if (workerd === "running") {
          candidate?.resumeAfterRuntimeRestart();
          projection?.resumeAfterRuntimeRestart();
        }
      });
      // Observability must not become an attachment prerequisite. A recovering
      // event stream may be unavailable during the same restart this listener
      // exists to observe; EventsClient owns its durable resubscription loop.
      void events.subscribe("server-health" as EventName).catch((error) => {
        log.warn(
          `server-health watch will recover in background: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
      if (signal.aborted) throw abortError(signal);

      const config = (await deps.serverClient.call(
        "workspace",
        "getConfig",
        []
      )) as WorkspaceConfig | null;
      if (signal.aborted) throw abortError(signal);
      const broker = config ? workspaceProviderExtensionPackageName(config, "browserData") : null;
      candidateStopListening = stopHealthListening;
      if (broker) {
        const eventName = `extensions:${broker}::data-changed` as EventName;
        const stopDataListening = events.on(eventName, (payload) => {
          if (
            payload &&
            typeof payload === "object" &&
            (payload as { dataType?: unknown }).dataType === "cookies"
          ) {
            candidate?.notifyCanonicalRevision();
            projection?.notifyCanonicalRevision();
          }
        });
        candidateStopListening = () => {
          stopHealthListening();
          stopDataListening();
        };
        void events.subscribe(eventName).catch((error) => {
          log.warn(
            `browser-data watch will recover in background: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
        if (signal.aborted) throw abortError(signal);
      }

      const api = candidate.api();
      hostIntegrationActive = true;
      await deps.onReady?.(api);
      if (signal.aborted) throw abortError(signal);

      projection = candidate;
      candidate = null;
      stopListening = candidateStopListening;
      candidateStopListening = null;
      attached = true;
      log.info("Browser cookie projection attached");
    } catch (error) {
      if (!signal.aborted) {
        await deps.onUnavailable?.(error);
        log.error(
          `Browser environment unavailable; continuing without cookie projection: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } finally {
      candidateStopListening?.();
      if (candidate) await candidate.stop().catch(() => {});
      if (!attached) {
        await events.unsubscribeAll().catch(() => {});
        await stopHostIntegration().catch(() => {});
      }
    }
  };

  return {
    name: "browser-cookie-projection",
    start() {
      deps.onInitializing?.();
      initializationController = new AbortController();
      initializationTask = initialize(initializationController.signal);
      // This service describes eventual attachment, not a boot prerequisite.
      // Returning immediately keeps extension build/approval off the shell's
      // startup critical path.
      return Promise.resolve();
    },
    async stop() {
      initializationController?.abort();
      initializationController = null;
      await initializationTask?.catch(() => {});
      initializationTask = null;
      await projection?.stop();
      projection = null;
      stopListening?.();
      stopListening = null;
      await events.unsubscribeAll().catch(() => {});
      await stopHostIntegration();
    },
  };
}

class BrowserCookieProjection {
  private outbox: OutboxRecord[] = [];
  private nextSequence = 1;
  /**
   * The last complete state observed in Chromium. Browser-originated mutations
   * are changes relative to this baseline, not differences from canonical
   * storage: a cookie that Chromium rejects must remain canonical and retryable.
   */
  private observedBrowser = new Map<string, BrowserCookieInput>();
  private appliedRevision = 0;
  private mismatchCount = 0;
  private lastError: string | undefined;
  private lastLoggedWarning: string | undefined;
  private converged = false;
  private stopped = false;
  /** True while the server's workerd runtime is offline/restarting. */
  private runtimePaused = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private revisionTimer: ReturnType<typeof setTimeout> | null = null;
  private browserChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private operation: Promise<void> = Promise.resolve();
  private readonly operationQueue = new Map<string, Promise<unknown>>();
  private readonly persistenceQueue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      browserDataClient: BrowserDataClient;
      cookieJar: BrowserCookieJar;
      identity: BrowserEnvironmentIdentity;
      partition: string;
      hostId: string;
      outboxPath: string;
    }
  ) {}

  api(): BrowserCookieProjectionApi {
    return {
      identity: this.deps.identity,
      partition: this.deps.partition,
      flush: (origins) => this.flush(origins),
      reconcile: () => this.queueOperation(() => this.reconcileNow()),
      diagnostics: () => this.diagnostics(),
      notifyCanonicalRevision: () => this.notifyCanonicalRevision(),
    };
  }

  async start(): Promise<void> {
    await this.loadOutbox();
    // Subscribe before touching either side. The Electron event is only a dirty
    // signal; the partition-complete CDP snapshot determines what changed.
    await this.deps.cookieJar.start(() => this.notifyBrowserChanged());
    await this.queueOperation(async () => {
      await this.flushOutbox();
      await this.reconcileNow();
    });
    this.startPeriodicReconcile();
  }

  private startPeriodicReconcile(): void {
    if (this.periodicTimer || this.stopped) return;
    this.periodicTimer = setInterval(() => {
      void this.queueOperation(() => this.reconcileNow());
    }, FULL_RECONCILE_INTERVAL_MS);
    this.periodicTimer.unref?.();
  }

  /**
   * The runtime hosting canonical cookie state is offline/restarting: stop
   * the periodic reconcile clock instead of burning every tick on a doomed
   * dispatch. Resumption is lifecycle-driven (readiness event or canonical
   * revision notification), never a retry clock of its own.
   */
  pauseForRuntimeRestart(): void {
    if (this.stopped || this.runtimePaused) return;
    this.runtimePaused = true;
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    log.info("cookie projection paused while the workerd runtime restarts");
  }

  resumeAfterRuntimeRestart(): void {
    if (this.stopped || !this.runtimePaused) return;
    this.runtimePaused = false;
    this.startPeriodicReconcile();
    // Converge immediately on readiness rather than waiting a full interval.
    void this.queueOperation(async () => {
      await this.flushOutbox();
      await this.reconcileNow();
    });
    log.info("cookie projection resumed after workerd runtime restart");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.revisionTimer) clearTimeout(this.revisionTimer);
    if (this.browserChangeTimer) clearTimeout(this.browserChangeTimer);
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    await this.operation.catch(() => {});
    await this.persistOutbox();
    await this.deps.cookieJar.stop();
  }

  async flush(origins?: string[]): Promise<{ revision: number }> {
    await this.queueOperation(async () => {
      await this.flushOutbox();
      await this.reconcileNow(origins);
    });
    if (!this.converged) {
      throw new Error(this.lastError ?? "Cookie projection did not converge");
    }
    return { revision: this.appliedRevision };
  }

  diagnostics(): BrowserCookieProjectionDiagnostics {
    return {
      revision: this.appliedRevision,
      hostId: this.deps.hostId,
      converged: this.converged,
      mismatchCount: this.mismatchCount,
      outboxDepth: this.outbox.length,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  notifyCanonicalRevision(): void {
    // A canonical-data change proves the runtime is serving again; recover the
    // reconcile loop even if the readiness event was missed.
    this.resumeAfterRuntimeRestart();
    if (this.revisionTimer) clearTimeout(this.revisionTimer);
    this.revisionTimer = setTimeout(() => {
      this.revisionTimer = null;
      void this.queueOperation(() => this.reconcileNow());
    }, REVISION_DEBOUNCE_MS);
  }

  private notifyBrowserChanged(): void {
    if (this.stopped) return;
    if (this.browserChangeTimer) clearTimeout(this.browserChangeTimer);
    this.browserChangeTimer = setTimeout(() => {
      this.browserChangeTimer = null;
      void this.queueOperation(() => this.captureBrowserChanges());
    }, REVISION_DEBOUNCE_MS);
  }

  private async captureBrowserChanges(): Promise<void> {
    const browser = await this.deps.cookieJar.snapshot();
    const actual = new Map(browser.cookies.map((cookie) => [cookieKeyString(cookie), cookie]));
    for (const [key, cookie] of actual) {
      const previous = this.observedBrowser.get(key);
      if (previous && cookieContentHash(previous) === cookieContentHash(cookie)) continue;
      this.enqueueMutation({ op: "put", cookie, mutationId: randomUUID() });
    }
    for (const [key, cookie] of this.observedBrowser) {
      if (actual.has(key)) continue;
      this.enqueueMutation({
        op: "delete",
        key: cookieKey(cookie),
        mutationId: randomUUID(),
      });
    }
    this.observedBrowser = actual;
  }

  private enqueueMutation(mutation: BrowserCookieMutation): void {
    this.outbox.push({ sequence: this.nextSequence, mutation });
    this.nextSequence += 1;
    this.converged = false;
    void this.persistOutbox();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.queueOperation(async () => {
        await this.flushOutbox();
        await this.reconcileNow();
      });
    }, REVISION_DEBOUNCE_MS);
  }

  private async flushOutbox(): Promise<void> {
    while (this.outbox.length > 0) {
      const batch = this.outbox.slice(0, 250);
      try {
        await this.deps.browserDataClient.applyCookieMutations({
          mutations: batch.map((entry) => entry.mutation),
        });
      } catch (error) {
        if (isRuntimeRestartingError(error)) this.pauseForRuntimeRestart();
        this.lastError = `Cookie outbox flush failed: ${messageOf(error)}`;
        this.converged = false;
        await this.persistOutbox();
        return;
      }
      this.outbox.splice(0, batch.length);
      await this.persistOutbox();
    }
  }

  private async reconcileNow(origins?: string[]): Promise<void> {
    try {
      const snapshot = await this.deps.browserDataClient.getCookieSnapshot();
      const canonical = origins?.length
        ? snapshot.cookies.filter((cookie) =>
            origins.some((origin) => cookieAppliesToOrigin(cookie, origin))
          )
        : snapshot.cookies;
      const current = (await this.deps.cookieJar.snapshot()).cookies;
      const scopedCurrent = origins?.length
        ? current.filter((cookie) =>
            origins.some((origin) => cookieAppliesToOrigin(cookie, origin))
          )
        : current;
      const currentByKey = new Map(
        scopedCurrent.map((cookie) => [cookieKeyString(cookieKey(cookie)), cookie])
      );

      let writeFailures = 0;
      let firstWriteFailure: string | undefined;
      const recordWriteFailure = (error: unknown) => {
        writeFailures += 1;
        firstWriteFailure ??= messageOf(error);
      };

      for (const cookie of canonical) {
        const key = cookieKeyString(cookie);
        const existing = currentByKey.get(key);
        if (existing && cookieContentHash(existing) === cookie.contentHash) {
          continue;
        }
        try {
          // Chromium protects an existing Secure cookie from being overwritten
          // by an insecure Set-Cookie source. Reconciliation is replacing an
          // exact cookie-jar key, so remove the old materialization through its
          // complete key before setting the canonical version.
          if (existing) {
            await this.deps.cookieJar.remove(cookieKey(existing));
          }
          await this.deps.cookieJar.set(cookie);
        } catch (error) {
          recordWriteFailure(error);
        }
      }

      const expectedKeys = new Set(canonical.map((cookie) => cookieKeyString(cookie)));
      for (const [key, cookie] of currentByKey) {
        if (expectedKeys.has(key)) continue;
        try {
          await this.deps.cookieJar.remove(cookieKey(cookie));
        } catch (error) {
          recordWriteFailure(error);
        }
      }

      const finalCookies = (await this.deps.cookieJar.snapshot()).cookies;
      this.observedBrowser = new Map(
        finalCookies.map((cookie) => [cookieKeyString(cookie), cookie])
      );
      const finalScoped = origins?.length
        ? finalCookies.filter((cookie) =>
            origins.some((origin) => cookieAppliesToOrigin(cookie, origin))
          )
        : finalCookies;
      this.mismatchCount = projectionMismatchCount(canonical, finalScoped);
      this.converged = this.mismatchCount === 0 && this.outbox.length === 0;
      this.appliedRevision = this.converged
        ? snapshot.revision
        : Math.min(this.appliedRevision, snapshot.revision);
      this.lastError = this.converged
        ? undefined
        : `Cookie projection did not converge (${this.mismatchCount} mismatches${
            writeFailures > 0
              ? `, ${writeFailures} write failures; first: ${firstWriteFailure ?? "unknown"}`
              : ""
          })`;
      if (this.converged) this.lastLoggedWarning = undefined;
      else this.warnOnce(this.lastError ?? "Cookie projection did not converge");
    } catch (error) {
      // A runtime generation transition is a lifecycle state, not a fault:
      // pause the loop and let the readiness signal resume it.
      if (isRuntimeRestartingError(error)) this.pauseForRuntimeRestart();
      this.converged = false;
      this.lastError = `Cookie reconciliation failed: ${messageOf(error)}`;
      this.warnOnce(this.lastError);
    }
  }

  private queueOperation(run: () => Promise<void>): Promise<void> {
    const next = serializeByKey(this.operationQueue, "projection", run);
    this.operation = next.then(
      () => undefined,
      (error) => {
        this.lastError = `Cookie projection operation failed: ${messageOf(error)}`;
        this.warnOnce(this.lastError);
        return undefined;
      }
    );
    return next;
  }

  private warnOnce(message: string): void {
    if (message === this.lastLoggedWarning) return;
    this.lastLoggedWarning = message;
    log.warn(message);
  }

  private async loadOutbox(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.deps.outboxPath, "utf8")) as {
        nextSequence?: unknown;
        records?: unknown;
      };
      this.outbox = Array.isArray(parsed.records) ? parsed.records.filter(isOutboxRecord) : [];
      this.nextSequence =
        typeof parsed.nextSequence === "number" && Number.isSafeInteger(parsed.nextSequence)
          ? parsed.nextSequence
          : (this.outbox.at(-1)?.sequence ?? 0) + 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Cookie outbox is unreadable: ${messageOf(error)}`);
      }
    }
  }

  private async persistOutbox(): Promise<void> {
    const payload = JSON.stringify({
      nextSequence: this.nextSequence,
      records: this.outbox,
    });
    const write = serializeByKey(this.persistenceQueue, "outbox", async () => {
      const directory = path.dirname(this.deps.outboxPath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.deps.outboxPath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, payload, { mode: 0o600 });
      await fs.rename(temporary, this.deps.outboxPath);
    });
    try {
      await write;
    } catch (error) {
      this.lastError = `Cookie outbox persistence failed: ${messageOf(error)}`;
      this.converged = false;
      log.warn(this.lastError);
      throw error;
    }
  }
}

function cookieKey(cookie: BrowserCookieKey): BrowserCookieKey {
  return {
    name: cookie.name,
    domain: cookie.domain.toLocaleLowerCase(),
    path: cookie.path || "/",
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

function cookieKeyString(key: BrowserCookieKey): string {
  return `${key.name}\x00${key.domain.toLocaleLowerCase()}\x00${key.path}\x00${browserCookiePartitionStorageKey(
    key.partitionKey
  )}`;
}

/**
 * Fold unflushed local mutations over the last canonical cookie snapshot.
 * Chromium can emit an add followed by a delete before the debounce flush; the
 * pending put is therefore part of the effective state even when canonical
 * storage has never contained it.
 */
export function effectiveCookieContentHash(
  desired: StoredCookie | undefined,
  pending: readonly BrowserCookieMutation[],
  key: BrowserCookieKey
): string | null {
  const target = cookieKeyString(key);
  let hash: string | null = desired?.contentHash ?? null;
  for (const mutation of pending) {
    if (mutation.op === "put") {
      if (cookieKeyString(mutation.cookie) === target) {
        hash = cookieContentHash(mutation.cookie);
      }
    } else if (cookieKeyString(mutation.key) === target) {
      hash = null;
    }
  }
  return hash;
}

export function cookieContentHash(cookie: BrowserCookieInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        cookie.name,
        cookie.value,
        cookie.domain.toLocaleLowerCase(),
        cookie.path,
        browserCookiePartitionStorageKey(cookie.partitionKey),
        cookie.hostOnly,
        cookie.secure,
        cookie.httpOnly,
        cookie.sameSite,
        normalizeCookieExpirationSeconds(cookie.expirationDate) ?? null,
      ])
    )
    .digest("base64");
}

function cookieAppliesToOrigin(
  cookie: Pick<BrowserCookieInput, "domain" | "hostOnly" | "path" | "secure" | "partitionKey">,
  origin: string
): boolean {
  try {
    const url = new URL(origin);
    if (cookie.secure && url.protocol !== "https:") return false;
    if (cookie.partitionKey && cookie.partitionKey.topLevelSite !== url.origin) return false;
    const domain = cookie.domain.replace(/^\./, "").toLocaleLowerCase();
    const host = url.hostname.toLocaleLowerCase();
    return cookie.hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function projectionMismatchCount(canonical: StoredCookie[], browser: BrowserCookieInput[]): number {
  const expected = new Map(
    canonical.map((cookie) => [cookieKeyString(cookie), cookie.contentHash])
  );
  const actual = new Map(
    browser.map((cookie) => [cookieKeyString(cookieKey(cookie)), cookieContentHash(cookie)])
  );
  let mismatches = 0;
  for (const [key, hash] of expected) {
    if (actual.get(key) !== hash) mismatches += 1;
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) mismatches += 1;
  }
  return mismatches;
}

function isOutboxRecord(value: unknown): value is OutboxRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OutboxRecord>;
  return (
    typeof record.sequence === "number" &&
    Number.isSafeInteger(record.sequence) &&
    Boolean(record.mutation) &&
    (record.mutation?.op === "put" || record.mutation?.op === "delete")
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
