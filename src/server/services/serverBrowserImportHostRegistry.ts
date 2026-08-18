import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type {
  BrowserCookieInput,
  BrowserImportProvider,
  FormFillValueInput,
  ImportedPassword,
} from "@vibestudio/browser-data";
import { BrowserImportHostProvider } from "../../main/services/browserImportHostProvider.js";
import type {
  BrowserImportProviderFrame,
  BrowserPublicImportDataType,
  BrowserSensitiveImportDataType,
  SensitiveBrowserImportStatus,
} from "../../main/services/browserImportHostProvider.js";
import { SensitiveBrowserImportLedger } from "../../main/services/sensitiveBrowserImportLedger.js";
import { browserEnvironmentIdentityFromContext } from "../browserEnvironmentIdentity.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

interface ScopedHost {
  provider: BrowserImportHostProvider;
}

interface BoundRead {
  provider: BrowserImportHostProvider;
  providerOperationId: string;
  callerKey: string;
  timer: NodeJS.Timeout;
  reading: boolean;
}

interface BoundSensitiveImport {
  provider: BrowserImportHostProvider;
  callerKey: string;
  timer: NodeJS.Timeout;
}

const DEFAULT_HANDLE_TTL_MS = 30 * 60_000;

/**
 * Own the trusted browser reader on the machine that owns the discovered
 * profiles. Raw cookies, passwords, form-fill values, profile paths, and
 * session files never enter the workspace extension: the host reads them and
 * writes protected categories straight into the caller's BrowserVaultDO.
 */
export class ServerBrowserImportHostRegistry {
  private readonly hosts = new Map<string, ScopedHost>();
  private readonly reads = new Map<string, BoundRead>();
  private readonly sensitiveImports = new Map<string, BoundSensitiveImport>();
  private readonly ledgerDir: string;

  constructor(
    private readonly deps: {
      workspaceId: string;
      statePath: string;
      doDispatch: DoDispatcher;
      createProvider?: () => Promise<BrowserImportProvider>;
      readHandleTtlMs?: number;
    }
  ) {
    this.ledgerDir = path.join(deps.statePath, "browser-import", "sensitive-ledgers");
    mkdirSync(this.ledgerDir, { recursive: true, mode: 0o700 });
  }

  startImportRead(
    ctx: ServiceContext,
    sourceId: string,
    dataTypes: BrowserPublicImportDataType[]
  ): string {
    const provider = this.forContext(ctx);
    const providerOperationId = provider.startImport(sourceId, dataTypes);
    const handle = `bir_${randomBytes(24).toString("base64url")}`;
    const entry: BoundRead = {
      provider,
      providerOperationId,
      callerKey: readCallerKey(ctx),
      timer: undefined as never,
      reading: false,
    };
    entry.timer = this.expiryTimer(() => {
      this.reads.delete(handle);
      provider.cancel(providerOperationId);
    });
    this.reads.set(handle, entry);
    return handle;
  }

  async nextImportFrame(ctx: ServiceContext, handle: string): Promise<BrowserImportProviderFrame> {
    const entry = this.requireRead(ctx, handle);
    if (entry.reading) throw invalidReadHandle();
    entry.reading = true;
    try {
      const frame = await entry.provider.nextFrame(entry.providerOperationId);
      if (frame.type === "complete" || frame.type === "error") this.deleteRead(handle, false);
      else this.refreshRead(handle, entry);
      return frame;
    } finally {
      entry.reading = false;
    }
  }

  cancelImportRead(ctx: ServiceContext, handle: string): void {
    this.requireRead(ctx, handle);
    this.deleteRead(handle, true);
  }

  startSensitiveImport(
    ctx: ServiceContext,
    sourceId: string,
    dataTypes: BrowserSensitiveImportDataType[],
    operationId: string
  ): SensitiveBrowserImportStatus {
    const callerKey = readCallerKey(ctx);
    const existing = this.sensitiveImports.get(operationId);
    if (existing && existing.callerKey !== callerKey) throw invalidReadHandle();
    const provider = existing?.provider ?? this.forContext(ctx);
    const status = provider.startSensitiveImport(sourceId, dataTypes, operationId);
    if (!existing) {
      const entry: BoundSensitiveImport = {
        provider,
        callerKey,
        timer: undefined as never,
      };
      entry.timer = this.expiryTimer(() => {
        this.sensitiveImports.delete(operationId);
        if (provider.observeSensitiveImport(operationId).state === "running") {
          provider.cancelSensitiveImport(operationId);
        }
      });
      this.sensitiveImports.set(operationId, entry);
    } else {
      this.refreshSensitive(operationId, existing);
    }
    return status;
  }

  observeSensitiveImport(ctx: ServiceContext, operationId: string): SensitiveBrowserImportStatus {
    const entry = this.requireSensitive(ctx, operationId);
    this.refreshSensitive(operationId, entry);
    return entry.provider.observeSensitiveImport(operationId);
  }

  cancelSensitiveImport(ctx: ServiceContext, operationId: string): SensitiveBrowserImportStatus {
    const entry = this.requireSensitive(ctx, operationId);
    this.refreshSensitive(operationId, entry);
    return entry.provider.cancelSensitiveImport(operationId);
  }

  forContext(ctx: ServiceContext): BrowserImportHostProvider {
    const identity = browserEnvironmentIdentityFromContext(this.deps.workspaceId, ctx);
    const existing = this.hosts.get(identity.environmentKey);
    if (existing) return existing.provider;

    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "BrowserVaultDO",
      objectKey: identity.environmentKey,
    } as const;
    const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
      this.deps.doDispatch.dispatch(ref, method, ...args) as Promise<T>;
    const provider = new BrowserImportHostProvider(
      {
        hostId: `server:${this.deps.workspaceId}`,
        displayName: "Server",
        location: "server",
      },
      {
        ...(this.deps.createProvider ? { createProvider: this.deps.createProvider } : {}),
        browserVault: {
          addCookiesBatch: (input: {
            jobId: string;
            batchIndex: number;
            cookies: BrowserCookieInput[];
          }) => call("addCookiesBatch", input),
          addPasswordsBatch: (passwords: ImportedPassword[], meta: { sourceId: string }) =>
            call("addPasswordsBatch", passwords, meta),
          addFormFillBatch: (values: FormFillValueInput[], meta: { sourceId: string }) =>
            call("addFormFillBatch", values, meta),
        },
        sensitiveImportLedger: new SensitiveBrowserImportLedger(
          path.join(this.ledgerDir, `${identity.environmentKey}.json`)
        ),
      }
    );
    this.hosts.set(identity.environmentKey, { provider });
    return provider;
  }

  stop(): void {
    for (const [handle] of this.reads) this.deleteRead(handle, true);
    for (const entry of this.sensitiveImports.values()) clearTimeout(entry.timer);
    this.sensitiveImports.clear();
    for (const host of this.hosts.values()) host.provider.stop();
    this.hosts.clear();
  }

  private requireRead(ctx: ServiceContext, handle: string): BoundRead {
    const entry = this.reads.get(handle);
    if (!entry || entry.callerKey !== readCallerKey(ctx)) throw invalidReadHandle();
    return entry;
  }

  private requireSensitive(ctx: ServiceContext, operationId: string): BoundSensitiveImport {
    const entry = this.sensitiveImports.get(operationId);
    if (!entry || entry.callerKey !== readCallerKey(ctx)) throw invalidReadHandle();
    return entry;
  }

  private deleteRead(handle: string, cancel: boolean): void {
    const entry = this.reads.get(handle);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.reads.delete(handle);
    if (cancel) entry.provider.cancel(entry.providerOperationId);
  }

  private refreshRead(handle: string, entry: BoundRead): void {
    clearTimeout(entry.timer);
    entry.timer = this.expiryTimer(() => {
      if (this.reads.get(handle) !== entry) return;
      this.reads.delete(handle);
      entry.provider.cancel(entry.providerOperationId);
    });
  }

  private refreshSensitive(operationId: string, entry: BoundSensitiveImport): void {
    clearTimeout(entry.timer);
    entry.timer = this.expiryTimer(() => {
      if (this.sensitiveImports.get(operationId) === entry) {
        this.sensitiveImports.delete(operationId);
        if (entry.provider.observeSensitiveImport(operationId).state === "running") {
          entry.provider.cancelSensitiveImport(operationId);
        }
      }
    });
  }

  private expiryTimer(expire: () => void): NodeJS.Timeout {
    const timer = setTimeout(expire, this.deps.readHandleTtlMs ?? DEFAULT_HANDLE_TTL_MS);
    timer.unref();
    return timer;
  }
}

function readCallerKey(ctx: ServiceContext): string {
  const { runtime, code } = ctx.caller;
  if (!code) throw invalidReadHandle();
  return JSON.stringify([
    runtime.kind,
    runtime.id,
    code.callerKind,
    code.callerId,
    code.repoPath,
    code.effectiveVersion,
    code.executionDigest,
  ]);
}

function invalidReadHandle(): Error {
  return Object.assign(new Error("Browser import read handle is invalid or expired"), {
    code: "EACCES",
  });
}
