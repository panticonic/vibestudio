import { mkdirSync } from "node:fs";
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
import { SensitiveBrowserImportLedger } from "../../main/services/sensitiveBrowserImportLedger.js";
import { browserEnvironmentIdentityFromContext } from "../browserEnvironmentIdentity.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

interface ScopedHost {
  provider: BrowserImportHostProvider;
}

/**
 * Own the trusted browser reader on the machine that owns the discovered
 * profiles. Raw cookies, passwords, form-fill values, profile paths, and
 * session files never enter the workspace extension: the host reads them and
 * writes protected categories straight into the caller's BrowserVaultDO.
 */
export class ServerBrowserImportHostRegistry {
  private readonly hosts = new Map<string, ScopedHost>();
  private readonly ledgerDir: string;

  constructor(
    private readonly deps: {
      workspaceId: string;
      statePath: string;
      doDispatch: DoDispatcher;
      createProvider?: () => Promise<BrowserImportProvider>;
    }
  ) {
    this.ledgerDir = path.join(deps.statePath, "browser-import", "sensitive-ledgers");
    mkdirSync(this.ledgerDir, { recursive: true, mode: 0o700 });
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
    for (const host of this.hosts.values()) host.provider.stop();
    this.hosts.clear();
  }
}
