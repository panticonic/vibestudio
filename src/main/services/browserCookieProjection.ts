import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { session, type Cookie, type Session } from "electron";
import type {
  BrowserCookieInput,
  BrowserCookieKey,
  BrowserCookieMutation,
  BrowserDataClient,
  BrowserEnvironmentIdentity,
  StoredCookie,
} from "@vibestudio/browser-data";
import { browserEnvironmentPartition } from "@vibestudio/shared/panelInterfaces";
import type { ManagedService } from "@vibestudio/shared/managedService";
import { createDevLogger } from "@vibestudio/dev-log";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import type { EventName } from "@vibestudio/shared/events";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { workspaceProviderExtensionPackageName } from "@vibestudio/workspace/configParser";
import type { ServerClient } from "../serverClient.js";

const log = createDevLogger("BrowserCookieProjection");

const EXTENSION_WAIT_TIMEOUT_MS = 5 * 60_000;
const EXTENSION_WAIT_INTERVAL_MS = 3_000;

function isExtensionUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Extension is not installed|Extension failed to start|ENOEXT|ENOTREADY/i.test(message);
}

/** Retry a browser-data call while the extension is still installing/activating. */
async function retryWhileExtensionUnavailable<T>(call: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + EXTENSION_WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!isExtensionUnavailableError(error) || Date.now() >= deadline) throw error;
      log.info("browser-data extension not ready yet; retrying");
      await new Promise((resolve) => setTimeout(resolve, EXTENSION_WAIT_INTERVAL_MS));
    }
  }
}

const REVISION_DEBOUNCE_MS = 150;
const FULL_RECONCILE_INTERVAL_MS = 60_000;

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
  setActivePartition(partition: string): void;
  onReady?(api: BrowserCookieProjectionApi): void | Promise<void>;
  onStopped?(): void | Promise<void>;
}): ManagedService {
  let projection: BrowserCookieProjection | null = null;
  let stopListening: (() => void) | null = null;
  const events = new EventsClient({
    stream(targetId, method, args, options) {
      if (targetId !== "main") throw new Error(`Unexpected browser projection target: ${targetId}`);
      const dot = method.indexOf(".");
      return deps.serverClient.stream(method.slice(0, dot), method.slice(dot + 1), args, options);
    },
  });
  return {
    name: "browser-cookie-projection",
    async start() {
      // On a workspace's first boot the browser-data extension is still
      // building/awaiting install approval; its provider methods report
      // ENOEXT/ENOTREADY until activation completes. That is a normal cold
      // start, not a fatal condition — wait it out instead of failing the
      // whole app bootstrap.
      let identity: BrowserEnvironmentIdentity;
      try {
        identity = await retryWhileExtensionUnavailable(() =>
          deps.browserDataClient.getBrowserEnvironment()
        );
      } catch (error) {
        // A browser environment is an enhancement (cookie/session projection
        // for browser panels), not a requirement for the shell to run — e.g. a
        // session without a verified user cannot resolve one. Degrade to
        // no-projection instead of failing app bootstrap.
        log.error(
          `Browser environment unavailable; continuing without cookie projection: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return null;
      }
      const partition = browserEnvironmentPartition(identity.environmentKey);
      deps.setActivePartition(partition);
      projection = new BrowserCookieProjection({
        browserDataClient: deps.browserDataClient,
        browserSession: session.fromPartition(partition),
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
      await projection.start();
      const config = (await deps.serverClient.call(
        "workspace",
        "getConfig",
        []
      )) as WorkspaceConfig | null;
      const broker = config ? workspaceProviderExtensionPackageName(config, "browserData") : null;
      if (broker) {
        const eventName = `extensions:${broker}::data-changed` as EventName;
        stopListening = events.on(eventName, (payload) => {
          if (
            payload &&
            typeof payload === "object" &&
            (payload as { dataType?: unknown }).dataType === "cookies"
          ) {
            projection?.notifyCanonicalRevision();
          }
        });
        await events.subscribe(eventName);
      }
      const api = projection.api();
      await deps.onReady?.(api);
      return api;
    },
    async stop() {
      await projection?.stop();
      stopListening?.();
      stopListening = null;
      await events.unsubscribeAll().catch(() => {});
      projection = null;
      await deps.onStopped?.();
    },
  };
}

class BrowserCookieProjection {
  private outbox: OutboxRecord[] = [];
  private nextSequence = 1;
  private desired = new Map<string, StoredCookie>();
  private appliedRevision = 0;
  private mismatchCount = 0;
  private lastError: string | undefined;
  private converged = false;
  private stopped = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private revisionTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private operation: Promise<void> = Promise.resolve();
  private persistence: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      browserDataClient: BrowserDataClient;
      browserSession: Session;
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
    // Subscribe before touching either side: Electron change notifications are
    // lossy around restore, so startup always follows with full convergence.
    this.deps.browserSession.cookies.on("changed", this.onCookieChanged);
    await this.queueOperation(async () => {
      await this.flushOutbox();
      await this.reconcileNow();
    });
    this.periodicTimer = setInterval(() => {
      void this.queueOperation(() => this.reconcileNow());
    }, FULL_RECONCILE_INTERVAL_MS);
    this.periodicTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.deps.browserSession.cookies.off("changed", this.onCookieChanged);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.revisionTimer) clearTimeout(this.revisionTimer);
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    await this.operation.catch(() => {});
    await this.persistOutbox();
  }

  async flush(origins?: string[]): Promise<{ revision: number }> {
    await this.queueOperation(async () => {
      await this.flushOutbox();
      await this.reconcileNow(origins);
    });
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
    if (this.revisionTimer) clearTimeout(this.revisionTimer);
    this.revisionTimer = setTimeout(() => {
      this.revisionTimer = null;
      void this.queueOperation(() => this.reconcileNow());
    }, REVISION_DEBOUNCE_MS);
  }

  private readonly onCookieChanged = (
    _event: Electron.Event,
    cookie: Cookie,
    _cause: "explicit" | "overwrite" | "expired" | "evicted" | "expired-overwrite",
    removed: boolean
  ): void => {
    if (this.stopped || !cookie.domain) return;
    const key = cookieKey(cookie);
    const keyString = cookieKeyString(key);
    const effectiveHash = effectiveCookieContentHash(
      this.desired.get(keyString),
      this.outbox.map((entry) => entry.mutation),
      key
    );
    if (removed) {
      if (effectiveHash === null) return;
      this.enqueueMutation({ op: "delete", key, mutationId: randomUUID() });
      return;
    }
    const input = electronCookieInput(cookie);
    if (effectiveHash === cookieContentHash(input)) return;
    this.enqueueMutation({ op: "put", cookie: input, mutationId: randomUUID() });
  };

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
      this.desired = new Map(snapshot.cookies.map((cookie) => [cookieKeyString(cookie), cookie]));
      const current = await this.deps.browserSession.cookies.get({});
      const scopedCurrent = origins?.length
        ? current.filter((cookie) =>
            origins.some((origin) => cookieAppliesToOrigin(electronCookieInput(cookie), origin))
          )
        : current;
      const currentByKey = new Map(
        scopedCurrent
          .filter((cookie): cookie is Cookie & { domain: string } => Boolean(cookie.domain))
          .map((cookie) => [cookieKeyString(cookieKey(cookie)), cookie])
      );

      for (const cookie of canonical) {
        const existing = currentByKey.get(cookieKeyString(cookie));
        if (existing && cookieContentHash(electronCookieInput(existing)) === cookie.contentHash) {
          continue;
        }
        await this.deps.browserSession.cookies.set(toElectronCookie(cookie));
      }

      const expectedKeys = new Set(canonical.map((cookie) => cookieKeyString(cookie)));
      for (const [key, cookie] of currentByKey) {
        if (expectedKeys.has(key)) continue;
        await this.deps.browserSession.cookies.remove(
          cookieUrl(electronCookieInput(cookie)),
          cookie.name
        );
      }

      const finalCookies = await this.deps.browserSession.cookies.get({});
      const finalScoped = origins?.length
        ? finalCookies.filter((cookie) =>
            origins.some((origin) => cookieAppliesToOrigin(electronCookieInput(cookie), origin))
          )
        : finalCookies;
      this.mismatchCount = projectionMismatchCount(canonical, finalScoped);
      this.converged = this.mismatchCount === 0 && this.outbox.length === 0;
      this.appliedRevision = this.converged
        ? snapshot.revision
        : Math.min(this.appliedRevision, snapshot.revision);
      this.lastError = this.converged
        ? undefined
        : `Cookie projection did not converge (${this.mismatchCount} mismatches)`;
      if (!this.converged) {
        log.warn(this.lastError ?? "Cookie projection did not converge");
      }
    } catch (error) {
      this.converged = false;
      this.lastError = `Cookie reconciliation failed: ${messageOf(error)}`;
      log.warn(this.lastError);
    }
  }

  private queueOperation(run: () => Promise<void>): Promise<void> {
    const next = this.operation.then(run, run);
    this.operation = next.catch(() => {});
    return next;
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
    const write = this.persistence.then(async () => {
      const directory = path.dirname(this.deps.outboxPath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.deps.outboxPath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, payload, { mode: 0o600 });
      await fs.rename(temporary, this.deps.outboxPath);
    });
    this.persistence = write.catch(() => {});
    await write;
  }
}

function electronCookieInput(cookie: Cookie): BrowserCookieInput {
  const secure = cookie.secure === true;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: (cookie.domain ?? "").toLocaleLowerCase(),
    hostOnly: cookie.hostOnly === true,
    path: cookie.path || "/",
    secure,
    httpOnly: cookie.httpOnly === true,
    sameSite: cookie.sameSite,
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
    sourceScheme: secure ? "secure" : "non_secure",
    sourcePort: secure ? 443 : 80,
  };
}

function cookieKey(cookie: Cookie): BrowserCookieKey {
  return {
    name: cookie.name,
    domain: (cookie.domain ?? "").toLocaleLowerCase(),
    path: cookie.path || "/",
  };
}

function cookieKeyString(key: BrowserCookieKey): string {
  return `${key.name}\x00${key.domain.toLocaleLowerCase()}\x00${key.path}\x00${key.partitionKey ?? ""}`;
}

/**
 * Fold unflushed local mutations over the last canonical cookie snapshot.
 * Electron can emit an add followed by a delete before the debounce flush; the
 * pending put is therefore part of the effective state even though `desired`
 * has never contained it.
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
        cookie.partitionKey ?? "",
        cookie.hostOnly,
        cookie.secure,
        cookie.httpOnly,
        cookie.sameSite,
        cookie.expirationDate ?? null,
        cookie.sourceScheme ?? null,
        cookie.sourcePort ?? null,
      ])
    )
    .digest("base64");
}

export function toElectronCookie(cookie: StoredCookie): Electron.CookiesSetDetails {
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  };
}

function cookieUrl(cookie: Pick<BrowserCookieInput, "domain" | "path" | "secure">): string {
  return `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${
    cookie.path || "/"
  }`;
}

function cookieAppliesToOrigin(
  cookie: Pick<BrowserCookieInput, "domain" | "hostOnly" | "path" | "secure">,
  origin: string
): boolean {
  try {
    const url = new URL(origin);
    if (cookie.secure && url.protocol !== "https:") return false;
    const domain = cookie.domain.replace(/^\./, "").toLocaleLowerCase();
    const host = url.hostname.toLocaleLowerCase();
    return cookie.hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function projectionMismatchCount(canonical: StoredCookie[], electron: Cookie[]): number {
  const expected = new Map(
    canonical.map((cookie) => [cookieKeyString(cookie), cookie.contentHash])
  );
  const actual = new Map(
    electron
      .filter((cookie) => Boolean(cookie.domain))
      .map((cookie) => [
        cookieKeyString(cookieKey(cookie)),
        cookieContentHash(electronCookieInput(cookie)),
      ])
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
