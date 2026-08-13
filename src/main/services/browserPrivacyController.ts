import type {
  BrowserCookieInput,
  ImportedCookie,
  ImportedPassword,
  StoredPassword,
} from "@vibestudio/browser-data";
import { exportCsvPasswords, exportNetscapeCookies } from "@vibestudio/browser-import";
import type { BrowserPrivacyRequest } from "@vibestudio/service-schemas/browserPrivacy";
import type { BrowserCookieProjectionApi } from "./browserCookieProjection.js";
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
      getProjection(): BrowserCookieProjectionApi | null;
    }
  ) {}

  async execute(request: BrowserPrivacyRequest): Promise<unknown> {
    switch (request.action) {
      case "snapshot":
        return this.snapshot(request.origin);
      case "snapshotPage":
        return this.snapshotPage(request);
      case "exportChunk":
        return this.exportChunk(request);
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
      case "endSession":
        return this.deps.vault.endBrowserSession();
      case "clearAllCookies":
        return this.deps.vault.clearAllCookies();
      case "exportPasswords":
        return this.exportPasswords(request.format);
      case "exportCookies":
        return this.exportCookies(request.format);
    }
  }

  /**
   * Mobile relay mutation boundary. Every write is keyed or naturally
   * idempotent and returns only a stable acknowledgement, so a retry after a
   * lost receipt cannot duplicate an effect or invent a different result.
   */
  async executeIdempotent(request: BrowserPrivacyRequest, operationId: string): Promise<unknown> {
    switch (request.action) {
      case "addFormFill":
        await this.deps.vault.addFormFillValue(
          {
            fieldName: request.type,
            type: request.type,
            value: request.value,
            ...(request.displayLabel ? { displayLabel: request.displayLabel } : {}),
          },
          `browser-privacy:${operationId}`
        );
        return { ok: true };
      case "deletePassword":
        await this.deps.vault.deletePassword(request.id);
        return { ok: true };
      case "removeNeverSave":
        await this.deps.vault.removeNeverSavePassword(request.origin);
        return { ok: true };
      case "updateFormFill":
        await this.deps.vault.updateFormFillValue(request.id, { value: request.value });
        return { ok: true };
      case "deleteFormFill":
        await this.deps.vault.deleteFormFillValue(request.id);
        return { ok: true };
      case "clearFormFill":
        await this.deps.vault.clearFormFillValues();
        return { ok: true };
      case "clearOrigin":
        await this.deps.vault.clearCookiesForOrigin(request.origin);
        return { ok: true };
      case "endSession":
        await this.deps.vault.endBrowserSession();
        return { ok: true };
      case "clearAllCookies":
        await this.deps.vault.clearAllCookies();
        return { ok: true };
      case "snapshot":
      case "snapshotPage":
      case "exportChunk":
      case "exportPasswords":
      case "exportCookies":
        return this.execute(request);
    }
  }

  private async snapshotPage(request: Extract<BrowserPrivacyRequest, { action: "snapshotPage" }>) {
    let rows: unknown[];
    let total: number;
    if (request.collection === "passwords")
      ({ items: rows, total } = await this.deps.vault.listPasswordSummariesPage(
        request.offset,
        request.limit
      ));
    else if (request.collection === "neverSave")
      ({ items: rows, total } = await this.deps.vault.getNeverSavePasswordOriginsPage(
        request.offset,
        request.limit
      ));
    else if (request.collection === "formFill")
      ({ items: rows, total } = await this.deps.vault.listFormFillValuesPage(
        request.offset,
        request.limit
      ));
    else
      ({ items: rows, total } = await this.deps.vault.listCookieOriginsPage(
        request.offset,
        request.limit
      ));
    const items = rows;
    const origin = normalizeHttpOrigin(request.origin);
    const inspect = origin
      ? await Promise.all([
          this.deps.vault.getPasswordForSite(origin),
          this.deps.vault.getCookiesForOrigin(origin),
        ]).then(([passwords, cookies]) => ({
          origin,
          passwordCount: passwords.length,
          cookieCount: cookies.length,
        }))
      : { origin: null, passwordCount: 0, cookieCount: 0 };
    return {
      collection: request.collection,
      offset: request.offset,
      items,
      nextOffset: request.offset + items.length < total ? request.offset + items.length : null,
      total,
      inspect,
      diagnostics: this.deps.getProjection()?.diagnostics() ?? null,
    };
  }

  private async exportChunk(request: Extract<BrowserPrivacyRequest, { action: "exportChunk" }>) {
    const exported =
      request.exportKind === "passwords"
        ? await this.exportPasswords(request.format as "csv-chrome" | "csv-firefox" | "json")
        : await this.exportCookies(request.format as "json" | "netscape-txt");
    const bytes = Buffer.from(exported.contentBase64, "base64");
    const end = Math.min(bytes.length, request.offset + request.chunkBytes);
    return {
      filename: exported.filename,
      mimeType: exported.mimeType,
      count: exported.count,
      offset: request.offset,
      chunkBase64: bytes.subarray(request.offset, end).toString("base64"),
      nextOffset: end < bytes.length ? end : null,
      totalBytes: bytes.length,
      sha256: (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"),
    };
  }

  private async snapshot(originInput: string) {
    const [passwords, neverSave, formFill, cookieOrigins] = await Promise.all([
      this.deps.vault.listPasswordSummaries(),
      this.deps.vault.getNeverSavePasswordOrigins(),
      this.deps.vault.listFormFillValues(),
      this.deps.vault.listCookieOrigins(),
    ]);
    const origin = normalizeHttpOrigin(originInput);
    const [sitePasswords, siteCookies] = origin
      ? await Promise.all([
          this.deps.vault.getPasswordForSite(origin),
          this.deps.vault.getCookiesForOrigin(origin),
        ])
      : [[], []];
    return {
      passwords,
      neverSave,
      formFill,
      cookieOrigins,
      inspect: { origin, passwordCount: sitePasswords.length, cookieCount: siteCookies.length },
      diagnostics: this.deps.getProjection()?.diagnostics() ?? null,
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

function normalizeHttpOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}
