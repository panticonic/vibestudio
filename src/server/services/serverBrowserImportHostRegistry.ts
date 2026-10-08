import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type {
  BrowserCookieInput,
  BrowserImportAcquisitionOption,
  BrowserImportAcquisitionResult,
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
  listAcquisitionOptions(signal?: AbortSignal): Promise<BrowserImportAcquisitionOption[]>;
  beginAcquisition(
    acquisitionId: string,
    signal?: AbortSignal
  ): Promise<BrowserImportAcquisitionResult>;
  releaseSource(sourceId: string): void | Promise<void>;
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
  call(method: string, args: unknown[], options?: { signal?: AbortSignal }): Promise<unknown>;
}

interface BoundRead {
  endpoint: ImportEndpoint;
  providerOperationId: string;
  callerKey: string;
  reading: boolean;
}

interface BoundSensitiveImport {
  applicationContext: ServiceContext;
  endpoint: ImportEndpoint;
  environmentKey: string;
  callerKey: string;
}

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

  async listAcquisitionOptions(
    ctx: ServiceContext,
    hostId: string
  ): Promise<BrowserImportAcquisitionOption[]> {
    return (await this.endpoint(ctx, hostId)).listAcquisitionOptions(ctx.signal);
  }

  async beginAcquisition(
    ctx: ServiceContext,
    hostId: string,
    acquisitionId: string
  ): Promise<BrowserImportAcquisitionResult> {
    return (await this.endpoint(ctx, hostId)).beginAcquisition(acquisitionId, ctx.signal);
  }

  async releaseSource(ctx: ServiceContext, hostId: string, sourceId: string): Promise<void> {
    await (await this.endpoint(ctx, hostId)).releaseSource(sourceId);
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
      reading: false,
    };
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
      return frame;
    } finally {
      entry.reading = false;
    }
  }

  cancelImportRead(ctx: ServiceContext, handle: string): Promise<void> {
    this.requireRead(ctx, handle);
    return this.deleteRead(handle, true);
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
    const environmentKey = browserEnvironmentIdentityFromContext(
      this.deps.workspaceId,
      ctx
    ).environmentKey;
    const existing = this.sensitiveImports.get(operationId);
    if (existing && existing.environmentKey !== environmentKey) throw invalidReadHandle();
    if (existing && existing.endpoint.summary.hostId !== hostId) throw invalidReadHandle();
    const endpoint = await this.endpoint(ctx, hostId);
    const binding = { endpoint, environmentKey, callerKey, applicationContext: ctx };
    // Bind the verified initiating context before launching: a saved import can
    // reach application synchronously without opening its original source.
    this.sensitiveImports.set(operationId, binding);
    try {
      return await endpoint.startSensitiveImport(sourceId, dataTypes, operationId);
    } catch (error) {
      if (this.sensitiveImports.get(operationId) === binding) {
        if (existing) this.sensitiveImports.set(operationId, existing);
        else this.sensitiveImports.delete(operationId);
      }
      throw error;
    }
  }

  async observeSensitiveImport(
    ctx: ServiceContext,
    operationId: string
  ): Promise<SensitiveBrowserImportStatus> {
    const entry = this.requireSensitive(ctx, operationId);
    return entry.endpoint.observeSensitiveImport(operationId);
  }

  async cancelSensitiveImport(
    ctx: ServiceContext,
    operationId: string
  ): Promise<SensitiveBrowserImportStatus> {
    const entry = this.requireSensitive(ctx, operationId);
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
        applyCookies: async (signal, operationId) => {
          signal.throwIfAborted();
          const binding = this.sensitiveImports.get(operationId);
          const connection = binding
            ? this.deps.resolveDeviceConnection?.(binding.applicationContext)
            : null;
          if (!connection) throw new Error("Open a browser device to apply saved cookies");
          await connection.call("browserEnvironment.applyCookies", [], { signal });
          signal.throwIfAborted();
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
      listAcquisitionOptions: (signal) => provider.listAcquisitionOptions(signal),
      beginAcquisition: (acquisitionId, signal) => provider.beginAcquisition(acquisitionId, signal),
      releaseSource: (sourceId) => provider.releaseSource(sourceId),
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
      listAcquisitionOptions: () => call("listImportAcquisitionOptions", hostId),
      beginAcquisition: (acquisitionId) => call("beginImportAcquisition", hostId, acquisitionId),
      releaseSource: (sourceId) => call("releaseImportSource", hostId, sourceId),
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

  async stop(): Promise<void> {
    const cancelled = [...this.reads.keys()].map((handle) => this.deleteRead(handle, true));
    this.sensitiveImports.clear();
    const settled = await Promise.allSettled([
      ...cancelled,
      ...[...this.hosts.values()].map((host) => host.provider.stop()),
    ]);
    this.hosts.clear();
    const failures = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Browser import shutdown failed"
      );
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

  private deleteRead(handle: string, cancel: boolean): Promise<void> {
    const entry = this.reads.get(handle);
    if (!entry) return Promise.resolve();
    this.reads.delete(handle);
    return cancel
      ? Promise.resolve().then(() => entry.endpoint.cancel(entry.providerOperationId))
      : Promise.resolve();
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
  return Object.assign(new Error("Browser import read handle is invalid"), {
    code: "EACCES",
  });
}

function unavailableHost(hostId: string): Error {
  return Object.assign(new Error(`Browser import host is unavailable: ${hostId}`), {
    code: "EACCES",
  });
}
