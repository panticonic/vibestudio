import type {
  BrowserCookieInput,
  ImportedCookie,
  ImportedPassword,
  StoredPassword,
} from "@vibestudio/browser-data";
import { exportCsvPasswords, exportNetscapeCookies } from "@vibestudio/browser-import";
import type { BrowserPrivacyRequest } from "@vibestudio/service-schemas/browserPrivacy";
import type { BrowserCookieProjectionDiagnostics } from "./browserCookieProjection.js";
import type { BrowserVaultNativeClient } from "./browserVaultNativeClient.js";

export interface BrowserPrivacyExport {
  filename: string;
  mimeType: string;
  contentBase64: string;
  count: number;
}

/** Host-only protected-data controller. Callers must provide their own trusted presentation. */
export class BrowserPrivacyController {
  constructor(
    private readonly deps: {
      vault: BrowserVaultNativeClient;
      getDiagnostics(): BrowserCookieProjectionDiagnostics | null;
      applyCookies?: (signal: AbortSignal) => Promise<{ revision: number }>;
    }
  ) {}

  async execute(request: BrowserPrivacyRequest, signal?: AbortSignal): Promise<unknown> {
    switch (request.action) {
      case "diagnostics":
        return this.deps.getDiagnostics();
      case "applyCookies":
        if (!this.deps.applyCookies)
          throw new Error("Cookie application is unavailable on this device");
        return this.deps.applyCookies(signal ?? new AbortController().signal);
      case "snapshot":
        return this.snapshot();
      case "deletePassword":
        return this.deps.vault.deletePassword(request.id);
      case "removeNeverSave":
        return this.deps.vault.removeNeverSavePassword(request.origin);
      case "addFormFill":
        return this.deps.vault.addFormFillValue({
          fieldName: request.type,
          type: request.type,
          value: request.value,
          ...(request.displayLabel ? { displayLabel: request.displayLabel } : {}),
        });
      case "updateFormFill":
        return this.deps.vault.updateFormFillValue(request.id, { value: request.value });
      case "deleteFormFill":
        return this.deps.vault.deleteFormFillValue(request.id);
      case "clearFormFill":
        return this.deps.vault.clearFormFillValues();
      case "clearOrigin":
        return this.deps.vault.clearCookiesForOrigin(request.origin);
      case "clearAllCookies":
        return this.deps.vault.clearAllCookies();
      case "exportPasswords":
        return this.exportPasswords(request.format);
      case "exportCookies":
        return this.exportCookies(request.format);
    }
  }

  private async snapshot() {
    const [passwords, neverSave, formFill, cookieOrigins] = await Promise.all([
      this.deps.vault.listPasswordSummaries(),
      this.deps.vault.getNeverSavePasswordOrigins(),
      this.deps.vault.listFormFillValues(),
      this.deps.vault.listCookieOrigins(),
    ]);
    return {
      passwords,
      neverSave,
      formFill,
      cookieOrigins,
    };
  }

  private async exportPasswords(
    format: "csv-chrome" | "csv-firefox" | "json"
  ): Promise<BrowserPrivacyExport> {
    const summaries = await this.deps.vault.listPasswordSummaries();
    const rows = (
      await Promise.all(
        [...new Set(summaries.map((row) => row.origin_url))].map((origin) =>
          this.deps.vault.getPasswordForSite(origin)
        )
      )
    ).flat();
    const extension = format === "json" ? "json" : "csv";
    return exportResult(
      `vibestudio-passwords.${extension}`,
      extension === "json" ? "application/json" : "text/csv",
      passwordExport(rows, format),
      rows.length
    );
  }

  private async exportCookies(format: "json" | "netscape-txt"): Promise<BrowserPrivacyExport> {
    const { origins } = await this.deps.vault.listCookieOrigins();
    const rows = (
      await Promise.all(origins.map((origin) => this.deps.vault.getCookiesForOrigin(origin)))
    ).flat();
    const extension = format === "json" ? "json" : "txt";
    return exportResult(
      `vibestudio-cookies.${extension}`,
      format === "json" ? "application/json" : "text/plain",
      cookieExport(rows, format),
      rows.length
    );
  }
}

function exportResult(
  filename: string,
  mimeType: string,
  content: string,
  count: number
): BrowserPrivacyExport {
  return {
    filename,
    mimeType,
    contentBase64: Buffer.from(content, "utf8").toString("base64"),
    count,
  };
}

export function passwordExport(
  rows: StoredPassword[],
  format: "csv-chrome" | "csv-firefox" | "json"
): string {
  const passwords: ImportedPassword[] = rows.map((row) => ({
    url: row.origin_url,
    username: row.username,
    password: row.password,
    ...(row.action_url ? { actionUrl: row.action_url } : {}),
    ...(row.realm ? { realm: row.realm } : {}),
  }));
  if (format === "csv-chrome") return exportCsvPasswords(passwords, "chrome");
  if (format === "csv-firefox") return exportCsvPasswords(passwords, "firefox");
  return JSON.stringify(passwords, null, 2);
}

export function cookieExport(
  rows: Array<BrowserCookieInput & { partitionKey?: unknown }>,
  format: "json" | "netscape-txt"
): string {
  if (format === "netscape-txt" && rows.some((cookie) => cookie.partitionKey !== undefined)) {
    throw new Error(
      "Netscape cookie files cannot represent partition keys; use JSON export instead"
    );
  }
  const cookies: ImportedCookie[] = rows.map((cookie) => ({
    name: cookie.name,
    valueStatus: "available",
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey as never } : {}),
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    sourceScheme: (cookie.sourceScheme ?? "unset") as ImportedCookie["sourceScheme"],
    sourcePort: cookie.sourcePort ?? -1,
  }));
  return format === "netscape-txt"
    ? exportNetscapeCookies(cookies)
    : JSON.stringify(cookies, null, 2);
}
