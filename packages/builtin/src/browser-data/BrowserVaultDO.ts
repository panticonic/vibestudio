import { DurableObjectBase, schemaRpc, type DurableObjectContext } from "@vibestudio/durable";
import { browserVaultMethods } from "@vibestudio/service-schemas/browserData";
import {
  ApplyCookieMutationsRequestSchema,
  BROWSER_VAULT_SCHEMA,
  FORM_FILL_TYPES,
  isPersistableFormFillType,
  browserCookiePartitionFromStorageKey,
  browserCookiePartitionStorageKey,
  normalizeBrowserCookiePartitionKey,
  normalizeCookieExpirationSeconds,
  type ApplyCookieMutationsRequest,
  type BrowserCookieInput,
  type BrowserCookieKey,
  type BrowserCookieRecord,
  type FormFillSuggestionQuery,
  type FormFillType,
  type FormFillValueInput,
  type ImportedPassword,
  type StoredCookie,
} from "@vibestudio/browser-data";

const BATCH_SIZE = 500;

interface ImportSourceMeta {
  sourceId: string;
}

interface PreparedCookiePut {
  input: BrowserCookieInput;
  encryptedValue: string;
  contentHash: string;
}

export class BrowserVaultDO extends DurableObjectBase {
  static override rpcMethods = browserVaultMethods;
  static override schemaVersion = 1;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected override rpcSchemaCodeSource(): string | null {
    const value = this.env["BROWSER_DATA_BROKER_SOURCE"];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("BrowserVaultDO requires BROWSER_DATA_BROKER_SOURCE");
    }
    return value;
  }

  protected createTables(): void {
    this.executeSchema(BROWSER_VAULT_SCHEMA);
  }

  protected override requiredTables(): readonly string[] {
    return [
      "passwords",
      "password_never_save",
      "cookie_state",
      "cookies",
      "cookie_mutations",
      "form_fill_values",
    ];
  }

  // -- Passwords -----------------------------------------------------------

  @schemaRpc()
  async getPasswords() {
    return Promise.all(
      this.sql
        .exec(`SELECT * FROM passwords ORDER BY date_last_used DESC`)
        .toArray()
        .map((row) => this.passwordRow(row))
    );
  }

  @schemaRpc()
  async getPasswordForSite(url: string) {
    const origin = this.httpOrigin(url);
    if (!origin) return [];
    const rows = this.sql
      .exec(
        `SELECT * FROM passwords WHERE origin_url = ?
         ORDER BY COALESCE(date_last_used, date_created, 0) DESC, times_used DESC`,
        origin
      )
      .toArray();
    return Promise.all(rows.map((row) => this.passwordRow(row)));
  }

  @schemaRpc()
  async addPassword(password: ImportedPassword): Promise<number> {
    const origin = this.httpOrigin(password.url);
    if (!origin) throw new Error("Password URL must use http or https");
    const encrypted = await this.encryptPasswordFields(password.username, password.password);
    const now = Date.now();
    const result = this.sql
      .exec(
        `INSERT INTO passwords
          (origin_url, username_hash, username_encrypted, password_encrypted, action_url, realm,
           date_created, date_last_used, date_password_changed, times_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin_url, username_hash, action_url, realm) DO UPDATE SET
           username_encrypted = excluded.username_encrypted,
           password_encrypted = excluded.password_encrypted,
           date_last_used = excluded.date_last_used,
           date_password_changed = excluded.date_password_changed,
           times_used = excluded.times_used
         RETURNING id`,
        origin,
        encrypted.usernameHash,
        encrypted.usernameEncrypted,
        encrypted.passwordEncrypted,
        password.actionUrl ?? "",
        password.realm ?? "",
        password.dateCreated ?? now,
        password.dateLastUsed ?? null,
        password.datePasswordChanged ?? now,
        password.timesUsed ?? 0
      )
      .one();
    return Number(result["id"]);
  }

  @schemaRpc()
  async updatePassword(id: number, partial: Partial<ImportedPassword>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (partial.username !== undefined) {
      sets.push("username_hash = ?", "username_encrypted = ?");
      params.push(
        await this.hashSecret(partial.username),
        await this.encryptText(partial.username)
      );
    }
    if (partial.password !== undefined) {
      sets.push("password_encrypted = ?", "date_password_changed = ?");
      params.push(await this.encryptText(partial.password), Date.now());
    }
    if (partial.actionUrl !== undefined) {
      sets.push("action_url = ?");
      params.push(partial.actionUrl);
    }
    if (partial.realm !== undefined) {
      sets.push("realm = ?");
      params.push(partial.realm);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.sql.exec(`UPDATE passwords SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }

  @schemaRpc()
  deletePassword(id: number): void {
    this.sql.exec(`DELETE FROM passwords WHERE id = ?`, id);
  }

  @schemaRpc()
  addNeverSave(origin: string): void {
    const normalized = this.httpOrigin(origin);
    if (!normalized) throw new Error("Never-save origin must use http or https");
    this.sql.exec(
      `INSERT OR IGNORE INTO password_never_save(origin, date_added) VALUES (?, ?)`,
      normalized,
      Date.now()
    );
  }

  @schemaRpc()
  isNeverSave(origin: string): boolean {
    const normalized = this.httpOrigin(origin);
    if (!normalized) return false;
    return (
      this.sql.exec(`SELECT 1 FROM password_never_save WHERE origin = ?`, normalized).toArray()
        .length > 0
    );
  }

  @schemaRpc()
  getNeverSaveOrigins(): string[] {
    return this.sql
      .exec(`SELECT origin FROM password_never_save ORDER BY origin`)
      .toArray()
      .map((row) => String(row["origin"]));
  }

  @schemaRpc()
  removeNeverSave(origin: string): void {
    const normalized = this.httpOrigin(origin);
    if (normalized) this.sql.exec(`DELETE FROM password_never_save WHERE origin = ?`, normalized);
  }

  @schemaRpc()
  updateLastUsed(id: number): void {
    this.sql.exec(
      `UPDATE passwords SET date_last_used = ?, times_used = times_used + 1 WHERE id = ?`,
      Date.now(),
      id
    );
  }

  // -- Structured form fill ------------------------------------------------

  @schemaRpc()
  async getFormFillSuggestions(query: FormFillSuggestionQuery) {
    if (query.type !== undefined && !FORM_FILL_TYPES.includes(query.type)) {
      throw new Error("Unknown form-fill type");
    }
    const fieldName = query.fieldName;
    if (fieldName !== undefined) this.requireFormFillFieldName(fieldName);
    if (query.type === undefined && fieldName === undefined) {
      throw new Error("A form-fill query requires a field name or semantic type");
    }
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const fieldKeys = [
      ...(query.type === undefined ? [] : [this.formFillFieldKey(query.type, "")]),
      ...(fieldName === undefined ? [] : [this.formFillFieldKey(undefined, fieldName)]),
    ];
    const uniqueFieldKeys = [...new Set(fieldKeys)];
    const placeholders = uniqueFieldKeys.map(() => "?").join(", ");
    const rows = this.sql
      .exec(
        `SELECT * FROM form_fill_values WHERE field_key IN (${placeholders})
         ORDER BY use_count DESC, updated_at DESC LIMIT ?`,
        ...uniqueFieldKeys,
        limit * 4
      )
      .toArray();
    const values = await Promise.all(rows.map((row) => this.formFillRow(row)));
    const prefix = query.prefix?.toLocaleLowerCase();
    return (
      prefix ? values.filter((entry) => entry.value.toLocaleLowerCase().startsWith(prefix)) : values
    ).slice(0, limit);
  }

  @schemaRpc()
  async addFormFillValue(input: FormFillValueInput, sourceId?: string): Promise<number> {
    if (input.type !== undefined && !FORM_FILL_TYPES.includes(input.type)) {
      throw new Error("Unknown form-fill type");
    }
    if (input.type !== undefined && !isPersistableFormFillType(input.type)) {
      throw new Error(`Form-fill type ${input.type} is not reusable form history`);
    }
    const fieldName = this.requireFormFillFieldName(input.fieldName);
    const value = input.value;
    const now = Date.now();
    const fieldKey = this.formFillFieldKey(input.type, fieldName);
    const valueHash = await this.hashSecret(value);
    const encrypted = await this.encryptText(value);
    const existing = this.sql
      .exec(
        `SELECT field_name, aliases FROM form_fill_values
         WHERE field_key = ? AND value_hash = ?`,
        fieldKey,
        valueHash
      )
      .toArray()[0];
    const aliases = JSON.stringify(
      this.normalizedAliases([
        ...(existing ? [String(existing["field_name"])] : []),
        ...(existing ? this.parseStringArray(existing["aliases"]) : []),
        fieldName,
        ...(input.aliases ?? []),
      ])
    );
    const row = this.sql
      .exec(
        `INSERT INTO form_fill_values
          (field_name, field_key, type, value_hash, value_encrypted, display_label, aliases,
           created_at, updated_at, use_count, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(field_key, value_hash) DO UPDATE SET
           value_encrypted = excluded.value_encrypted,
           display_label = COALESCE(excluded.display_label, form_fill_values.display_label),
           aliases = excluded.aliases,
           updated_at = MAX(form_fill_values.updated_at, excluded.updated_at),
           use_count = MAX(form_fill_values.use_count, excluded.use_count),
           source_id = COALESCE(excluded.source_id, form_fill_values.source_id)
         RETURNING id`,
        fieldName,
        fieldKey,
        input.type ?? null,
        valueHash,
        encrypted,
        input.displayLabel?.trim() || null,
        aliases,
        input.createdAt ?? now,
        input.updatedAt ?? now,
        input.useCount ?? 0,
        sourceId ?? null
      )
      .one();
    return Number(row["id"]);
  }

  @schemaRpc()
  async updateFormFillValue(
    id: number,
    partial: Partial<Pick<FormFillValueInput, "value" | "displayLabel" | "aliases">>
  ): Promise<void> {
    const sets = ["updated_at = ?"];
    const values: unknown[] = [Date.now()];
    if (partial.value !== undefined) {
      const value = partial.value.trim();
      if (!value) throw new Error("Form-fill value cannot be empty");
      sets.push("value_hash = ?", "value_encrypted = ?");
      values.push(await this.hashSecret(value), await this.encryptText(value));
    }
    if (partial.displayLabel !== undefined) {
      sets.push("display_label = ?");
      values.push(partial.displayLabel.trim() || null);
    }
    if (partial.aliases !== undefined) {
      sets.push("aliases = ?");
      values.push(JSON.stringify(this.normalizedAliases(partial.aliases)));
    }
    values.push(id);
    this.sql.exec(`UPDATE form_fill_values SET ${sets.join(", ")} WHERE id = ?`, ...values);
  }

  @schemaRpc()
  markFormFillValueUsed(id: number): void {
    this.sql.exec(
      `UPDATE form_fill_values SET use_count = use_count + 1, updated_at = ? WHERE id = ?`,
      Date.now(),
      id
    );
  }

  @schemaRpc()
  deleteFormFillValue(id: number): void {
    this.sql.exec(`DELETE FROM form_fill_values WHERE id = ?`, id);
  }

  @schemaRpc()
  clearFormFillValues(): number {
    this.sql.exec(`DELETE FROM form_fill_values`);
    return this.changes();
  }

  // -- Canonical cookie jar -------------------------------------------------

  @schemaRpc()
  async applyCookieMutations(request: ApplyCookieMutationsRequest): Promise<{ revision: number }> {
    const parsed = ApplyCookieMutationsRequestSchema.parse(request);
    const prepared = new Map<number, PreparedCookiePut>();
    for (const [index, mutation] of parsed.mutations.entries()) {
      if (mutation.op !== "put") continue;
      const input = this.normalizeCookie(mutation.cookie);
      prepared.set(index, {
        input,
        encryptedValue: await this.encryptText(input.value),
        contentHash: await this.cookieContentHash(input),
      });
    }

    let revision = this.currentCookieRevision();
    this.ctx.storage.transactionSync(() => {
      for (const [index, mutation] of parsed.mutations.entries()) {
        const alreadyApplied = this.sql
          .exec(
            `SELECT applied_revision FROM cookie_mutations WHERE mutation_id = ?`,
            mutation.mutationId
          )
          .toArray();
        const applied = alreadyApplied[0];
        if (applied) {
          revision = Math.max(revision, Number(applied["applied_revision"]));
          continue;
        }

        let changed = false;
        if (mutation.op === "put") {
          const item = prepared.get(index);
          if (!item) throw new Error(`Cookie mutation ${index} was not prepared`);
          const existing = this.cookieRowForKey(item.input);
          changed = !existing || String(existing["content_hash"]) !== item.contentHash;
          if (changed) {
            revision += 1;
            this.sql.exec(
              `INSERT INTO cookies
                (name, domain, path, partition_key, encrypted_value, content_hash, host_only,
                 secure, http_only, same_site, expiration_date, source_scheme, source_port,
                 created_at, last_accessed, revision)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(name, domain, path, partition_key) DO UPDATE SET
                 encrypted_value = excluded.encrypted_value,
                 content_hash = excluded.content_hash,
                 host_only = excluded.host_only,
                 secure = excluded.secure,
                 http_only = excluded.http_only,
                 same_site = excluded.same_site,
                 expiration_date = excluded.expiration_date,
                 source_scheme = excluded.source_scheme,
                 source_port = excluded.source_port,
                 last_accessed = excluded.last_accessed,
                 revision = excluded.revision`,
              item.input.name,
              item.input.domain,
              item.input.path,
              browserCookiePartitionStorageKey(item.input.partitionKey),
              item.encryptedValue,
              item.contentHash,
              item.input.hostOnly ? 1 : 0,
              item.input.secure ? 1 : 0,
              item.input.httpOnly ? 1 : 0,
              item.input.sameSite,
              item.input.expirationDate ?? null,
              item.input.sourceScheme ?? null,
              item.input.sourcePort ?? null,
              item.input.createdAt ?? Date.now(),
              item.input.lastAccessed ?? null,
              revision
            );
          }
        } else {
          const key = this.normalizeCookieKey(mutation.key);
          const result = this.sql.exec(
            `DELETE FROM cookies
             WHERE name = ? AND domain = ? AND path = ? AND partition_key = ?`,
            key.name,
            key.domain,
            key.path,
            browserCookiePartitionStorageKey(key.partitionKey)
          );
          changed =
            Number((result as unknown as { changes?: number }).changes ?? this.changes()) > 0;
          if (changed) revision += 1;
        }
        if (changed) this.setCookieRevision(revision);
        this.sql.exec(
          `INSERT INTO cookie_mutations(mutation_id, applied_revision, applied_at)
           VALUES (?, ?, ?)`,
          mutation.mutationId,
          revision,
          Date.now()
        );
      }
    });
    return { revision };
  }

  @schemaRpc()
  async getCookieSnapshot(_query: { sinceRevision?: number } = {}) {
    const now = Date.now() / 1_000;
    const rows = this.sql
      .exec(
        `SELECT * FROM cookies
         WHERE expiration_date IS NULL OR expiration_date > ?
         ORDER BY domain, path, name, partition_key`,
        now
      )
      .toArray();
    const cookies = (await Promise.all(rows.map((row) => this.cookieRow(row)))).filter(
      (cookie) => cookie.expirationDate === undefined || cookie.expirationDate > now
    );
    return { revision: this.currentCookieRevision(), cookies };
  }

  @schemaRpc()
  async getCookiesForOrigin(origin: string): Promise<StoredCookie[]> {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    const snapshot = await this.getCookieSnapshot();
    return snapshot.cookies.filter((cookie) => this.cookieMatchesUrl(cookie, url));
  }

  @schemaRpc()
  clearCookiesForOrigin(origin: string): number {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return 0;
    const keys = this.sql
      .exec(`SELECT name, domain, path, partition_key FROM cookies`)
      .toArray()
      .filter((row) =>
        this.cookieMatchesUrl(
          {
            domain: String(row["domain"]),
            hostOnly: !String(row["domain"]).startsWith("."),
            path: String(row["path"]),
            secure: false,
          },
          url
        )
      );
    return this.deleteCookieRows(keys);
  }

  @schemaRpc()
  clearAllCookies(): number {
    const rows = this.sql.exec(`SELECT name, domain, path, partition_key FROM cookies`).toArray();
    return this.deleteCookieRows(rows);
  }

  @schemaRpc()
  endBrowserSession(): number {
    const rows = this.sql
      .exec(`SELECT name, domain, path, partition_key FROM cookies WHERE expiration_date IS NULL`)
      .toArray();
    return this.deleteCookieRows(rows);
  }

  @schemaRpc()
  getCookieSiteSummary(origin: string) {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { origin, cookieCount: 0, revision: this.currentCookieRevision() };
    }
    const rows = this.sql.exec(`SELECT domain, path, secure, host_only FROM cookies`).toArray();
    return {
      origin: url.origin,
      cookieCount: rows.filter((row) =>
        this.cookieMatchesUrl(
          {
            domain: String(row["domain"]),
            hostOnly: Number(row["host_only"]) === 1,
            path: String(row["path"]),
            secure: Number(row["secure"]) === 1,
          },
          url
        )
      ).length,
      revision: this.currentCookieRevision(),
    };
  }

  @schemaRpc()
  async addCookiesBatch(input: {
    jobId: string;
    batchIndex: number;
    cookies: BrowserCookieInput[];
  }): Promise<{ revision: number }> {
    return this.applyCookieMutations({
      mutations: input.cookies.map((cookie, index) => ({
        op: "put" as const,
        cookie,
        mutationId: `${input.jobId}:cookies:${input.batchIndex}:${index}`,
      })),
    });
  }

  @schemaRpc()
  async addPasswordsBatch(passwords: ImportedPassword[], meta: ImportSourceMeta): Promise<number> {
    const prepared = await Promise.all(
      passwords.map(async (password) => ({
        password,
        origin: this.httpOrigin(password.url),
        encrypted: await this.encryptPasswordFields(password.username, password.password),
      }))
    );
    return this.runBatch(prepared.length, (index) => {
      const item = prepared[index];
      if (!item) throw new Error(`Password batch item ${index} is unavailable`);
      if (!item.origin) return;
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO passwords
          (origin_url, username_hash, username_encrypted, password_encrypted, action_url, realm,
           date_created, date_last_used, date_password_changed, times_used, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin_url, username_hash, action_url, realm) DO UPDATE SET
           username_encrypted = excluded.username_encrypted,
           password_encrypted = CASE
             WHEN COALESCE(excluded.date_password_changed, 0)
                >= COALESCE(passwords.date_password_changed, 0)
             THEN excluded.password_encrypted ELSE passwords.password_encrypted END,
           date_last_used = MAX(passwords.date_last_used, excluded.date_last_used),
           date_password_changed =
             MAX(passwords.date_password_changed, excluded.date_password_changed),
           times_used = MAX(passwords.times_used, excluded.times_used),
           source_id = excluded.source_id`,
        item.origin,
        item.encrypted.usernameHash,
        item.encrypted.usernameEncrypted,
        item.encrypted.passwordEncrypted,
        item.password.actionUrl ?? "",
        item.password.realm ?? "",
        item.password.dateCreated ?? now,
        item.password.dateLastUsed ?? 0,
        item.password.datePasswordChanged ?? 0,
        item.password.timesUsed ?? 0,
        meta.sourceId
      );
    });
  }

  @schemaRpc()
  async addFormFillBatch(values: FormFillValueInput[], meta: ImportSourceMeta): Promise<number> {
    let stored = 0;
    for (const value of values) {
      await this.addFormFillValue(value, meta.sourceId);
      stored += 1;
    }
    return stored;
  }

  // -- Helpers -------------------------------------------------------------

  private normalizeCookie(input: BrowserCookieInput): BrowserCookieInput {
    const key = this.normalizeCookieKey(input);
    return {
      ...input,
      ...key,
      sameSite: input.sameSite,
      expirationDate: normalizeCookieExpirationSeconds(input.expirationDate),
      sourcePort: input.sourcePort === undefined ? undefined : Math.trunc(input.sourcePort),
    };
  }

  private normalizeCookieKey(key: BrowserCookieKey): BrowserCookieKey {
    const name = key.name.trim();
    const domain = key.domain.trim().toLocaleLowerCase();
    const path = key.path.startsWith("/") ? key.path : `/${key.path}`;
    if (!name || !domain) throw new Error("Cookie name and domain are required");
    return {
      name,
      domain,
      path,
      ...(key.partitionKey
        ? { partitionKey: normalizeBrowserCookiePartitionKey(key.partitionKey) }
        : {}),
    };
  }

  private cookieRowForKey(key: BrowserCookieKey): Record<string, unknown> | null {
    return (
      this.sql
        .exec(
          `SELECT * FROM cookies
           WHERE name = ? AND domain = ? AND path = ? AND partition_key = ?`,
          key.name,
          key.domain,
          key.path,
          browserCookiePartitionStorageKey(key.partitionKey)
        )
        .toArray()[0] ?? null
    );
  }

  private async cookieRow(row: Record<string, unknown>): Promise<StoredCookie> {
    const encryptedValue = String(row["encrypted_value"]);
    const value = await this.decryptText(encryptedValue);
    const expirationDate = normalizeCookieExpirationSeconds(
      row["expiration_date"] == null ? undefined : Number(row["expiration_date"])
    );
    const partitionKey = browserCookiePartitionFromStorageKey(String(row["partition_key"] ?? ""));
    const cookie = {
      name: String(row["name"]),
      domain: String(row["domain"]),
      path: String(row["path"]),
      ...(partitionKey ? { partitionKey } : {}),
      value,
      hostOnly: Number(row["host_only"]) === 1,
      secure: Number(row["secure"]) === 1,
      httpOnly: Number(row["http_only"]) === 1,
      sameSite: String(row["same_site"]) as BrowserCookieRecord["sameSite"],
      ...(expirationDate === undefined ? {} : { expirationDate }),
      ...(row["source_scheme"] == null ? {} : { sourceScheme: String(row["source_scheme"]) }),
      ...(row["source_port"] == null ? {} : { sourcePort: Number(row["source_port"]) }),
    } satisfies BrowserCookieInput;
    return {
      ...cookie,
      encryptedValue,
      // Projection equality covers only attributes Chromium can materialize.
      // Recompute at the trusted boundary so rows written by an older hash
      // definition converge without a destructive data migration.
      contentHash: await this.cookieContentHash(cookie),
      createdAt: Number(row["created_at"]),
      ...(row["last_accessed"] == null ? {} : { lastAccessed: Number(row["last_accessed"]) }),
      revision: Number(row["revision"]),
    };
  }

  private cookieMatchesUrl(
    cookie: Pick<BrowserCookieInput, "domain" | "hostOnly" | "path" | "secure">,
    url: URL
  ): boolean {
    if (cookie.secure && url.protocol !== "https:") return false;
    const domain = cookie.domain.replace(/^\./, "").toLocaleLowerCase();
    const host = url.hostname.toLocaleLowerCase();
    const domainMatches = cookie.hostOnly
      ? host === domain
      : host === domain || host.endsWith(`.${domain}`);
    if (!domainMatches) return false;
    const path = cookie.path || "/";
    return url.pathname === path || url.pathname.startsWith(path.endsWith("/") ? path : `${path}/`);
  }

  private async cookieContentHash(cookie: BrowserCookieInput): Promise<string> {
    return this.sha256(
      JSON.stringify([
        cookie.name,
        cookie.value,
        cookie.domain,
        cookie.path,
        browserCookiePartitionStorageKey(cookie.partitionKey),
        cookie.hostOnly,
        cookie.secure,
        cookie.httpOnly,
        cookie.sameSite,
        normalizeCookieExpirationSeconds(cookie.expirationDate) ?? null,
      ])
    );
  }

  private currentCookieRevision(): number {
    const row = this.sql.exec(`SELECT revision FROM cookie_state WHERE singleton = 1`).one();
    return Number(row["revision"]);
  }

  private setCookieRevision(revision: number): void {
    this.sql.exec(`UPDATE cookie_state SET revision = ? WHERE singleton = 1`, revision);
  }

  private deleteCookieRows(rows: Record<string, unknown>[]): number {
    if (rows.length === 0) return 0;
    this.ctx.storage.transactionSync(() => {
      let revision = this.currentCookieRevision();
      for (const row of rows) {
        this.sql.exec(
          `DELETE FROM cookies
           WHERE name = ? AND domain = ? AND path = ? AND partition_key = ?`,
          row["name"],
          row["domain"],
          row["path"],
          row["partition_key"] ?? ""
        );
        revision += 1;
      }
      this.setCookieRevision(revision);
    });
    return rows.length;
  }

  private async formFillRow(row: Record<string, unknown>) {
    return {
      id: Number(row["id"]),
      fieldName: String(row["field_name"]),
      type: row["type"] == null ? null : (String(row["type"]) as FormFillType),
      value: await this.decryptText(String(row["value_encrypted"])),
      displayLabel: row["display_label"] == null ? null : String(row["display_label"]),
      aliases: this.parseStringArray(row["aliases"]),
      createdAt: Number(row["created_at"]),
      updatedAt: Number(row["updated_at"]),
      useCount: Number(row["use_count"]),
    };
  }

  private async passwordRow(row: Record<string, unknown>) {
    return {
      id: Number(row["id"]),
      origin_url: String(row["origin_url"]),
      username: await this.decryptText(String(row["username_encrypted"])),
      password: await this.decryptText(String(row["password_encrypted"])),
      action_url: String(row["action_url"]),
      realm: String(row["realm"]),
      date_created: row["date_created"] == null ? null : Number(row["date_created"]),
      date_last_used: row["date_last_used"] == null ? null : Number(row["date_last_used"]),
      date_password_changed:
        row["date_password_changed"] == null ? null : Number(row["date_password_changed"]),
      times_used: Number(row["times_used"]),
    };
  }

  private async encryptPasswordFields(username: string, password: string) {
    return {
      usernameHash: await this.hashSecret(username),
      usernameEncrypted: await this.encryptText(username),
      passwordEncrypted: await this.encryptText(password),
    };
  }

  private async hashSecret(value: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      this.masterKeyBytes(),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
    return this.bytesToBase64(new Uint8Array(signature));
  }

  private async sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return this.bytesToBase64(new Uint8Array(digest));
  }

  private async encryptText(plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await this.aesKey(),
      new TextEncoder().encode(plaintext)
    );
    const packed = new Uint8Array(iv.length + ciphertext.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(ciphertext), iv.length);
    return this.bytesToBase64(packed);
  }

  private async decryptText(encoded: string): Promise<string> {
    const packed = this.base64ToBytes(encoded);
    if (packed.byteLength < 13) throw new Error("Invalid encrypted browser-data value");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: packed.slice(0, 12) },
      await this.aesKey(),
      packed.slice(12)
    );
    return new TextDecoder().decode(plaintext);
  }

  private async aesKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", this.masterKeyBytes(), { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  private masterKeyBytes(): Uint8Array<ArrayBuffer> {
    const existing = this.getStateValue("browser_data_master_key");
    if (existing) return this.base64ToBytes(existing);
    const key = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32)));
    this.setStateValue("browser_data_master_key", this.bytesToBase64(key));
    return key;
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  private base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
    const binary = atob(encoded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  private httpOrigin(raw: string): string | null {
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
    } catch {
      return null;
    }
  }

  private normalizedAliases(aliases: string[] | undefined): string[] {
    const unique = new Map<string, string>();
    for (const alias of aliases ?? []) {
      const trimmed = alias.trim();
      if (trimmed.length === 0 || trimmed.length > 1_000) continue;
      const key = this.normalizeFormFillFieldName(trimmed);
      if (!unique.has(key)) unique.set(key, trimmed);
    }
    return [...unique.values()].slice(0, 50);
  }

  private requireFormFillFieldName(fieldName: string): string {
    if (typeof fieldName !== "string") throw new Error("Form-fill field name must be text");
    if (fieldName.length > 1_000) throw new Error("Form-fill field name is too long");
    return fieldName;
  }

  private normalizeFormFillFieldName(fieldName: string): string {
    return fieldName.trim().normalize("NFKC").toLocaleLowerCase();
  }

  private formFillFieldKey(type: FormFillType | undefined, fieldName: string): string {
    return type ? `type:${type}` : `field:${this.normalizeFormFillFieldName(fieldName)}`;
  }

  private parseStringArray(value: unknown): string[] {
    const parsed = this.parseJson<unknown>(value, []);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  }

  private parseJson<T>(value: unknown, fallback: T): T {
    if (typeof value !== "string") return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private async runBatch(total: number, apply: (index: number) => void): Promise<number> {
    for (let start = 0; start < total; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, total);
      this.ctx.storage.transactionSync(() => {
        for (let index = start; index < end; index += 1) apply(index);
      });
      if (end < total) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return total;
  }

  private changes(): number {
    const row = this.sql.exec(`SELECT changes() AS count`).one();
    return Number(row["count"] ?? 0);
  }

  private executeSchema(
    schema: string,
    sql: { exec(query: string, ...bindings: unknown[]): unknown } = this.sql
  ): void {
    let buffer: string[] = [];
    let inTrigger = false;
    for (const line of schema.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("/**") || trimmed.startsWith("*")) continue;
      if (/^CREATE TRIGGER\b/i.test(trimmed)) inTrigger = true;
      buffer.push(line);
      if ((inTrigger && /^END;$/i.test(trimmed)) || (!inTrigger && trimmed.endsWith(";"))) {
        sql.exec(buffer.join("\n"));
        buffer = [];
        inTrigger = false;
      }
    }
    if (buffer.length > 0) sql.exec(buffer.join("\n"));
  }
}
