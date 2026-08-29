import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type {
  BrowserCookieInput,
  BrowserImportDataType,
  BrowserImportProvider,
  BrowserImportSource,
  FormFillValueInput,
  ImportedBrowserOpenTab,
  ImportedPassword,
  ImportHostSummary,
  ImportPreviewSummary,
} from "@vibestudio/browser-data";
import { ImportHostSummarySchema } from "@vibestudio/browser-data";
import type { BrowserEnvironmentImportRouter } from "../../main/services/browserEnvironmentService.js";
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

interface ImportEndpoint {
  summary: ImportHostSummary;
  listSources(signal?: AbortSignal): Promise<BrowserImportSource[]>;
  preview(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    signal?: AbortSignal
  ): Promise<ImportPreviewSummary>;
  startImport(sourceId: string, dataTypes: BrowserPublicImportDataType[]): string | Promise<string>;
  nextFrame(operationId: string): Promise<BrowserImportProviderFrame>;
  cancel(operationId: string): void | Promise<void>;
  listOpenTabs(sourceId: string, signal?: AbortSignal): Promise<ImportedBrowserOpenTab[]>;
  startSensitiveImport(
    sourceId: string,
    dataTypes: BrowserSensitiveImportDataType[],
    operationId: string
  ): SensitiveBrowserImportStatus | Promise<SensitiveBrowserImportStatus>;
  observeSensitiveImport(
    operationId: string
  ): SensitiveBrowserImportStatus | Promise<SensitiveBrowserImportStatus>;
  cancelSensitiveImport(
    operationId: string
  ): SensitiveBrowserImportStatus | Promise<SensitiveBrowserImportStatus>;
}

export interface BrowserImportDeviceConnection {
  callerId: string;
  call(method: string, args: unknown[]): Promise<unknown>;
}

interface BoundRead {
  endpoint: ImportEndpoint;
  providerOperationId: string;
  callerKey: string;
  timer: NodeJS.Timeout;
  reading: boolean;
}

interface BoundSensitiveImport {
  endpoint: ImportEndpoint;
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
export class ServerBrowserImportHostRegistry implements BrowserEnvironmentImportRouter {
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
      resolveDeviceConnection?(ctx: ServiceContext): BrowserImportDeviceConnection | null;
    }
  ) {
    this.ledgerDir = path.join(deps.statePath, "browser-import", "sensitive-ledgers");
    mkdirSync(this.ledgerDir, { recursive: true, mode: 0o700 });
  }

  async listHosts(ctx: ServiceContext): Promise<ImportHostSummary[]> {
    const server = this.localEndpoint(ctx).summary;
    const connection = this.deps.resolveDeviceConnection?.(ctx);
    if (!connection) return [server];
    try {
      const value = await connection.call("browserEnvironment.listImportHosts", []);
      const devices = ImportHostSummarySchema.array()
        .parse(value)
        .filter((host) => host.location === "device" && host.connected);
      return [...devices, server];
    } catch {
      return [server];
    }
  }

  async listSources(ctx: ServiceContext, hostId: string): Promise<BrowserImportSource[]> {
    return (await this.endpoint(ctx, hostId)).listSources(ctx.signal);
  }

  async preview(
    ctx: ServiceContext,
    hostId: string,
    sourceId: string,
    dataTypes: BrowserImportDataType[]
  ): Promise<ImportPreviewSummary> {
    return (await this.endpoint(ctx, hostId)).preview(sourceId, dataTypes, ctx.signal);
  }

  async startImportRead(
    ctx: ServiceContext,
    hostId: string,
    sourceId: string,
    dataTypes: BrowserPublicImportDataType[]
  ): Promise<string> {
    const endpoint = await this.endpoint(ctx, hostId);
    const providerOperationId = await endpoint.startImport(sourceId, dataTypes);
    const handle = `bir_${randomBytes(24).toString("base64url")}`;
    const entry: BoundRead = {
      endpoint,
      providerOperationId,
      callerKey: readCallerKey(ctx),
      timer: undefined as never,
      reading: false,
    };
    entry.timer = this.expiryTimer(() => {
      this.reads.delete(handle);
      void Promise.resolve(endpoint.cancel(providerOperationId)).catch(() => undefined);
    });
    this.reads.set(handle, entry);
    return handle;
  }

  async nextImportFrame(ctx: ServiceContext, handle: string): Promise<BrowserImportProviderFrame> {
    const entry = this.requireRead(ctx, handle);
    if (entry.reading) throw invalidReadHandle();
    entry.reading = true;
    try {
      const frame = await entry.endpoint.nextFrame(entry.providerOperationId);
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

  async listOpenTabs(
    ctx: ServiceContext,
    hostId: string,
    sourceId: string
  ): Promise<ImportedBrowserOpenTab[]> {
    return (await this.endpoint(ctx, hostId)).listOpenTabs(sourceId, ctx.signal);
  }

  async startSensitiveImport(
    ctx: ServiceContext,
    hostId: string,
    sourceId: string,
    dataTypes: BrowserSensitiveImportDataType[],
    operationId: string
  ): Promise<SensitiveBrowserImportStatus> {
    const callerKey = readCallerKey(ctx);
    const existing = this.sensitiveImports.get(operationId);
    if (existing && existing.callerKey !== callerKey) throw invalidReadHandle();
    const endpoint = existing?.endpoint ?? (await this.endpoint(ctx, hostId));
    const status = await endpoint.startSensitiveImport(sourceId, dataTypes, operationId);
    if (!existing) {
      const entry: BoundSensitiveImport = {
        endpoint,
        callerKey,
        timer: undefined as never,
      };
      entry.timer = this.expiryTimer(() => {
        this.sensitiveImports.delete(operationId);
        void this.cancelIfRunning(endpoint, operationId);
      });
      this.sensitiveImports.set(operationId, entry);
    } else {
      this.refreshSensitive(operationId, existing);
    }
    return status;
  }

  async observeSensitiveImport(
    ctx: ServiceContext,
    operationId: string
  ): Promise<SensitiveBrowserImportStatus> {
    const entry = this.requireSensitive(ctx, operationId);
    this.refreshSensitive(operationId, entry);
    return entry.endpoint.observeSensitiveImport(operationId);
  }

  async cancelSensitiveImport(
    ctx: ServiceContext,
    operationId: string
  ): Promise<SensitiveBrowserImportStatus> {
    const entry = this.requireSensitive(ctx, operationId);
    this.refreshSensitive(operationId, entry);
    return entry.endpoint.cancelSensitiveImport(operationId);
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

  private localEndpoint(ctx: ServiceContext): ImportEndpoint {
    const provider = this.forContext(ctx);
    return {
      summary: provider.summary(),
      listSources: (signal) => provider.listSources(signal),
      preview: (sourceId, dataTypes, signal) => provider.preview(sourceId, dataTypes, signal),
      startImport: (sourceId, dataTypes) => provider.startImport(sourceId, dataTypes),
      nextFrame: (operationId) => provider.nextFrame(operationId),
      cancel: (operationId) => provider.cancel(operationId),
      listOpenTabs: (sourceId, signal) => provider.listOpenTabs(sourceId, signal),
      startSensitiveImport: (sourceId, dataTypes, operationId) =>
        provider.startSensitiveImport(sourceId, dataTypes, operationId),
      observeSensitiveImport: (operationId) => provider.observeSensitiveImport(operationId),
      cancelSensitiveImport: (operationId) => provider.cancelSensitiveImport(operationId),
    };
  }

  private async endpoint(ctx: ServiceContext, hostId: string): Promise<ImportEndpoint> {
    const local = this.localEndpoint(ctx);
    if (local.summary.hostId === hostId) return local;
    const connection = this.deps.resolveDeviceConnection?.(ctx);
    if (!connection) throw unavailableHost(hostId);
    const summaries = ImportHostSummarySchema.array().parse(
      await connection.call("browserEnvironment.listImportHosts", [])
    );
    const summary = summaries.find(
      (candidate) =>
        candidate.hostId === hostId && candidate.location === "device" && candidate.connected
    );
    if (!summary) throw unavailableHost(hostId);
    const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
      connection.call(`browserEnvironment.${method}`, args) as Promise<T>;
    return {
      summary,
      listSources: () => call("listImportSources", hostId),
      preview: (sourceId, dataTypes) => call("previewImportSource", hostId, sourceId, dataTypes),
      startImport: (sourceId, dataTypes) => call("startImportRead", hostId, sourceId, dataTypes),
      nextFrame: (operationId) => call("nextImportFrame", operationId),
      cancel: (operationId) => call("cancelImportRead", operationId),
      listOpenTabs: (sourceId) => call("listImportOpenTabs", hostId, sourceId),
      startSensitiveImport: (sourceId, dataTypes, operationId) =>
        call("startSensitiveImport", hostId, sourceId, dataTypes, operationId),
      observeSensitiveImport: (operationId) => call("observeSensitiveImport", operationId),
      cancelSensitiveImport: (operationId) => call("cancelSensitiveImport", operationId),
    };
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
    if (cancel) {
      void Promise.resolve(entry.endpoint.cancel(entry.providerOperationId)).catch(() => undefined);
    }
  }

  private refreshRead(handle: string, entry: BoundRead): void {
    clearTimeout(entry.timer);
    entry.timer = this.expiryTimer(() => {
      if (this.reads.get(handle) !== entry) return;
      this.reads.delete(handle);
      void Promise.resolve(entry.endpoint.cancel(entry.providerOperationId)).catch(() => undefined);
    });
  }

  private refreshSensitive(operationId: string, entry: BoundSensitiveImport): void {
    clearTimeout(entry.timer);
    entry.timer = this.expiryTimer(() => {
      if (this.sensitiveImports.get(operationId) === entry) {
        this.sensitiveImports.delete(operationId);
        void this.cancelIfRunning(entry.endpoint, operationId);
      }
    });
  }

  private expiryTimer(expire: () => void): NodeJS.Timeout {
    const timer = setTimeout(expire, this.deps.readHandleTtlMs ?? DEFAULT_HANDLE_TTL_MS);
    timer.unref();
    return timer;
  }

  private async cancelIfRunning(endpoint: ImportEndpoint, operationId: string): Promise<void> {
    try {
      if ((await endpoint.observeSensitiveImport(operationId)).state === "running") {
        await endpoint.cancelSensitiveImport(operationId);
      }
    } catch {
      // Expiration is best-effort cleanup; the selected host may have disconnected.
    }
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

function unavailableHost(hostId: string): Error {
  return Object.assign(new Error(`Browser import host is unavailable: ${hostId}`), {
    code: "EACCES",
  });
}
