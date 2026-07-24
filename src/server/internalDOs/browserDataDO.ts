import {
  DurableObjectBase,
  rpc,
  type DurableObjectContext,
  type DurableObjectSchemaMigration,
} from "@vibestudio/durable";
import type { RpcAuthorityPolicy } from "@vibestudio/rpc";
import { allOf, anyOf, capability, relationship } from "@vibestudio/shared/authorization";
import {
  ApplyCookieMutationsRequestSchema,
  BROWSER_DATA_SCHEMA,
  FORM_FILL_TYPES,
  type ApplyCookieMutationsRequest,
  type BrowserCookieInput,
  type BrowserCookieKey,
  type BrowserCookieRecord,
  type BrowserDownloadRecord,
  type FormFillSuggestionQuery,
  type FormFillValueInput,
  type ImportedBookmark,
  type ImportedHistoryEntry,
  type ImportedHistoryVisit,
  type ImportedPassword,
  type ImportedSearchEngine,
  type ImportJobWrite,
  type PageFavicon,
  type RecordHistoryVisitRequest,
  type StoredCookie,
  type UpdateHistoryTitleRequest,
} from "@vibestudio/browser-data";

const BATCH_SIZE = 500;
const MAX_FAVICON_BYTES = 128 * 1024;

interface ImportSourceMeta {
  sourceId: string;
}

interface HistoryVisitWrite {
  visitTime: number;
  transition: string;
  source: "vibestudio" | "import";
  importSourceId: string;
  panelId: string;
  title?: string;
  typed: boolean;
}

interface PreparedCookiePut {
  input: BrowserCookieInput;
  encryptedValue: string;
  contentHash: string;
}

function browserDataAuthority(sensitivity: RpcAuthorityPolicy["sensitivity"]): RpcAuthorityPolicy {
  return {
    effect: {
      kind: "semantic",
      capability:
        sensitivity === "read"
          ? "browser-data.read"
          : sensitivity === "destructive"
            ? "browser-data.delete"
            : "browser-data.write",
    },
    tier: "gated",
    sensitivity,
    requires: (self) => {
      const brokerRepoPath = (self as BrowserDataDO).brokerRepoPath();
      const requirements = [capability("host", "$method"), capability("user", "$method")];
      if (brokerRepoPath !== null) {
        requirements.push(
          allOf(capability("code", "$method"), relationship("code-source", brokerRepoPath))
        );
      }
      return anyOf(...requirements);
    },
  };
}

export class BrowserDataDO extends DurableObjectBase {
  static override schemaVersion = 7;

  protected override schemaProductionBaseline() {
    return { version: 1, name: "browser-data-v1" } as const;
  }

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  brokerRepoPath(): string | null {
    const value = this.env["BROWSER_DATA_BROKER_SOURCE"];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  protected createTables(): void {
    this.executeSchema(BROWSER_DATA_SCHEMA);
  }

  protected override schemaMigrations(): readonly DurableObjectSchemaMigration[] {
    // Versions 2–4 are retained only so existing ledgers remain recognizable.
    // The repository is pre-release; v5 deliberately drops all browser state
    // and requires a fresh import instead of translating profile-scoped data.
    return [
      {
        version: 2,
        name: "preserve-history-visit-provenance",
        validateSource: () => {},
        migrate: () => {},
      },
      {
        version: 3,
        name: "preserve-import-source-identity",
        validateSource: () => {},
        migrate: () => {},
      },
      {
        version: 4,
        name: "preserve-import-runs-and-secret-metadata",
        validateSource: () => {},
        migrate: () => {},
      },
      {
        version: 5,
        name: "canonical-browser-environment-cutover",
        validateSource: () => {},
        migrate: (sql) => {
          for (const trigger of ["history_ai", "history_ad", "history_au"]) {
            sql.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
          }
          for (const table of [
            "history_fts",
            "import_run_summaries",
            "import_runs",
            "import_log",
            "permissions",
            "autofill",
            "cookies",
            "password_never_save",
            "passwords",
            "history_visits",
            "history",
            "bookmarks",
            "favicons",
            "search_engines",
            "cookie_state",
            "cookie_mutations",
            "form_fill_values",
            "page_favicons",
            "import_jobs",
            "import_batches",
          ]) {
            sql.exec(`DROP TABLE IF EXISTS ${table}`);
          }
          this.executeSchema(BROWSER_DATA_SCHEMA, sql);
        },
      },
      {
        version: 6,
        name: "browser-site-preferences",
        validateSource: () => {},
        migrate: (sql) => {
          sql.exec(`CREATE TABLE IF NOT EXISTS site_preferences (
            origin TEXT PRIMARY KEY,
            zoom_factor REAL NOT NULL DEFAULT 1.0
              CHECK (zoom_factor >= 0.25 AND zoom_factor <= 5.0),
            updated_at INTEGER NOT NULL
          )`);
        },
      },
      {
        version: 7,
        name: "canonical-download-metadata",
        validateSource: () => {},
        migrate: (sql) => {
          sql.exec(`CREATE TABLE IF NOT EXISTS downloads (
            id TEXT PRIMARY KEY,
            environment_key TEXT NOT NULL,
            host_id TEXT NOT NULL,
            panel_id TEXT,
            origin TEXT,
            url TEXT NOT NULL,
            filename TEXT NOT NULL,
            save_path TEXT NOT NULL,
            received_bytes INTEGER NOT NULL,
            total_bytes INTEGER NOT NULL,
            state TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )`);
          sql.exec(`CREATE INDEX IF NOT EXISTS idx_downloads_host_updated
            ON downloads(host_id, updated_at DESC)`);
        },
      },
    ];
  }

  protected override requiredTables(): readonly string[] {
    return [
      "page_favicons",
      "site_preferences",
      "bookmarks",
      "history",
      "history_visits",
      "passwords",
      "password_never_save",
      "cookie_state",
      "cookies",
      "cookie_mutations",
      "form_fill_values",
      "search_engines",
      "import_jobs",
      "import_batches",
      "downloads",
    ];
  }

  @rpc(browserDataAuthority("write"))
  upsertDownloadRecord(record: BrowserDownloadRecord): void {
    if (!record.id || !record.environmentKey || !record.hostId) {
      throw new Error("Download metadata identity is incomplete");
    }
    const url = new URL(record.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Download metadata URL must use HTTP(S)");
    }
    if (
      !["progressing", "paused", "completed", "cancelled", "interrupted"].includes(record.state)
    ) {
      throw new Error("Download metadata state is invalid");
    }
    this.sql.exec(
      `INSERT INTO downloads
        (id, environment_key, host_id, panel_id, origin, url, filename, save_path,
         received_bytes, total_bytes, state, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         received_bytes = excluded.received_bytes,
         total_bytes = excluded.total_bytes,
         state = excluded.state,
         updated_at = excluded.updated_at`,
      record.id,
      record.environmentKey,
      record.hostId,
      record.panelId ?? null,
      record.origin ?? null,
      url.href,
      record.filename,
      record.savePath,
      Math.max(0, record.receivedBytes),
      Math.max(0, record.totalBytes),
      record.state,
      record.startedAt,
      record.updatedAt
    );
  }

  @rpc(browserDataAuthority("read"))
  listDownloadRecords(hostId: string): BrowserDownloadRecord[] {
    return this.sql
      .exec(`SELECT * FROM downloads WHERE host_id = ? ORDER BY updated_at DESC LIMIT 500`, hostId)
      .toArray()
      .map((row) => ({
        id: String(row["id"]),
        environmentKey: String(row["environment_key"]),
        hostId: String(row["host_id"]),
        ...(row["panel_id"] == null ? {} : { panelId: String(row["panel_id"]) }),
        ...(row["origin"] == null ? {} : { origin: String(row["origin"]) }),
        url: String(row["url"]),
        filename: String(row["filename"]),
        savePath: String(row["save_path"]),
        receivedBytes: Number(row["received_bytes"]),
        totalBytes: Number(row["total_bytes"]),
        state: String(row["state"]) as BrowserDownloadRecord["state"],
        startedAt: Number(row["started_at"]),
        updatedAt: Number(row["updated_at"]),
      }));
  }

  // -- Site preferences ----------------------------------------------------

  @rpc(browserDataAuthority("read"))
  getSitePreferences(origin: string): { origin: string; zoomFactor: number; updatedAt?: number } {
    const normalized = this.requireHttpOrigin(origin);
    const row = this.sql
      .exec(`SELECT zoom_factor, updated_at FROM site_preferences WHERE origin = ?`, normalized)
      .toArray()[0];
    return {
      origin: normalized,
      zoomFactor: row ? Number(row["zoom_factor"]) : 1,
      ...(row ? { updatedAt: Number(row["updated_at"]) } : {}),
    };
  }

  @rpc(browserDataAuthority("write"))
  setSiteZoom(origin: string, zoomFactor: number): void {
    const normalized = this.requireHttpOrigin(origin);
    if (!Number.isFinite(zoomFactor) || zoomFactor < 0.25 || zoomFactor > 5) {
      throw new Error("Browser zoom factor must be between 0.25 and 5");
    }
    this.sql.exec(
      `INSERT INTO site_preferences(origin, zoom_factor, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(origin) DO UPDATE SET
         zoom_factor = excluded.zoom_factor,
         updated_at = excluded.updated_at`,
      normalized,
      zoomFactor,
      Date.now()
    );
  }

  // -- Bookmarks -----------------------------------------------------------

  @rpc(browserDataAuthority("read"))
  getBookmarks(folderPath = "/") {
    return this.sql
      .exec(`SELECT * FROM bookmarks WHERE folder_path = ? ORDER BY position, title`, folderPath)
      .toArray();
  }

  @rpc(browserDataAuthority("read"))
  getAllBookmarks() {
    return this.sql.exec(`SELECT * FROM bookmarks ORDER BY folder_path, position, title`).toArray();
  }

  @rpc(browserDataAuthority("write"))
  addBookmark(bookmark: {
    title: string;
    url?: string;
    folderPath?: string;
    dateAdded?: number;
    tags?: string;
    keyword?: string;
    position?: number;
  }): number {
    const result = this.sql
      .exec(
        `INSERT INTO bookmarks
          (title, url, folder_path, date_added, position, tags, keyword)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        bookmark.title,
        bookmark.url ?? null,
        bookmark.folderPath ?? "/",
        bookmark.dateAdded ?? Date.now(),
        bookmark.position ?? 0,
        bookmark.tags ?? null,
        bookmark.keyword ?? null
      )
      .one();
    return Number(result["id"]);
  }

  @rpc(browserDataAuthority("write"))
  updateBookmark(id: number, partial: Record<string, unknown>): void {
    this.updateByMap(
      "bookmarks",
      id,
      {
        title: "title",
        url: "url",
        folderPath: "folder_path",
        tags: "tags",
        keyword: "keyword",
        position: "position",
      },
      partial,
      { date_modified: Date.now() }
    );
  }

  @rpc(browserDataAuthority("destructive"))
  deleteBookmark(id: number): void {
    this.sql.exec(`DELETE FROM bookmarks WHERE id = ?`, id);
  }

  @rpc(browserDataAuthority("write"))
  moveBookmark(id: number, folderPath: string, position: number): void {
    this.sql.exec(
      `UPDATE bookmarks SET folder_path = ?, position = ?, date_modified = ? WHERE id = ?`,
      folderPath,
      position,
      Date.now(),
      id
    );
  }

  @rpc(browserDataAuthority("read"))
  searchBookmarks(query: string) {
    const pattern = `%${this.escapeLikePattern(query)}%`;
    return this.sql
      .exec(
        `SELECT * FROM bookmarks
         WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'
         ORDER BY date_modified DESC, date_added DESC LIMIT 100`,
        pattern,
        pattern
      )
      .toArray();
  }

  // -- History -------------------------------------------------------------

  @rpc(browserDataAuthority("read"))
  getHistory(query: {
    search?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    offset?: number;
  }) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.search) {
      const pattern = `%${this.escapeLikePattern(query.search)}%`;
      clauses.push(`(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern);
    }
    if (query.startTime !== undefined) {
      clauses.push("last_visit >= ?");
      params.push(query.startTime);
    }
    if (query.endTime !== undefined) {
      clauses.push("last_visit <= ?");
      params.push(query.endTime);
    }
    params.push(Math.min(Math.max(query.limit ?? 100, 1), 1_000), Math.max(query.offset ?? 0, 0));
    return this.sql
      .exec(
        `SELECT * FROM history ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY last_visit DESC LIMIT ? OFFSET ?`,
        ...params
      )
      .toArray();
  }

  @rpc(browserDataAuthority("read"))
  searchHistory(query: string, limit = 50) {
    return this.getHistory({ search: query, limit });
  }

  @rpc(browserDataAuthority("read"))
  searchHistoryForAutocomplete(query: { query: string; limit?: number }) {
    return this.getHistory({ search: query.query, limit: query.limit ?? 20 });
  }

  @rpc(browserDataAuthority("write"))
  recordHistoryVisit(request: RecordHistoryVisitRequest): number {
    const visitTime = request.visitTime ?? Date.now();
    const historyId = this.ensureHistoryRow(request.url, request.title, visitTime);
    this.insertHistoryVisit(historyId, {
      visitTime,
      transition: request.transition ?? "link",
      source: request.source ?? "vibestudio",
      importSourceId: "",
      panelId: request.panelId ?? "",
      title: request.title,
      typed: request.typed === true,
    });
    this.recomputeHistorySummary(historyId);
    return historyId;
  }

  @rpc(browserDataAuthority("write"))
  updateHistoryTitle(request: UpdateHistoryTitleRequest): void {
    const title = request.title.trim();
    if (!title) return;
    this.sql.exec(`UPDATE history SET title = ? WHERE url = ?`, title, request.url);
    this.sql.exec(
      `UPDATE history_visits SET title = ? WHERE id = (
         SELECT history_visits.id
         FROM history_visits
         JOIN history ON history.id = history_visits.history_id
         WHERE history.url = ? AND history_visits.visit_time <= ?
         ORDER BY history_visits.visit_time DESC, history_visits.id DESC
         LIMIT 1
       )`,
      title,
      request.url,
      request.observedAt ?? Date.now()
    );
  }

  @rpc(browserDataAuthority("destructive"))
  deleteHistoryEntry(id: number): void {
    this.sql.exec(`DELETE FROM history WHERE id = ?`, id);
  }

  @rpc(browserDataAuthority("destructive"))
  deleteHistoryRange(start: number, end: number): number {
    const affected = this.sql
      .exec(
        `SELECT DISTINCT history_id AS id FROM history_visits
         WHERE visit_time >= ? AND visit_time <= ?`,
        start,
        end
      )
      .toArray()
      .map((row) => Number(row["id"]));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM history_visits WHERE visit_time >= ? AND visit_time <= ?`,
        start,
        end
      );
      for (const id of affected) {
        const count = Number(
          this.sql
            .exec(`SELECT COUNT(*) AS count FROM history_visits WHERE history_id = ?`, id)
            .one()["count"]
        );
        if (count === 0) this.sql.exec(`DELETE FROM history WHERE id = ?`, id);
        else this.recomputeHistorySummary(id);
      }
    });
    return affected.length;
  }

  @rpc(browserDataAuthority("destructive"))
  clearAllHistory(): void {
    this.sql.exec(`DELETE FROM history_visits`);
    this.sql.exec(`DELETE FROM history`);
  }

  // -- Passwords -----------------------------------------------------------

  @rpc(browserDataAuthority("read"))
  async getPasswords() {
    return Promise.all(
      this.sql
        .exec(`SELECT * FROM passwords ORDER BY date_last_used DESC`)
        .toArray()
        .map((row) => this.passwordRow(row))
    );
  }

  @rpc(browserDataAuthority("read"))
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

  @rpc(browserDataAuthority("write"))
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

  @rpc(browserDataAuthority("write"))
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

  @rpc(browserDataAuthority("destructive"))
  deletePassword(id: number): void {
    this.sql.exec(`DELETE FROM passwords WHERE id = ?`, id);
  }

  @rpc(browserDataAuthority("write"))
  addNeverSave(origin: string): void {
    const normalized = this.httpOrigin(origin);
    if (!normalized) throw new Error("Never-save origin must use http or https");
    this.sql.exec(
      `INSERT OR IGNORE INTO password_never_save(origin, date_added) VALUES (?, ?)`,
      normalized,
      Date.now()
    );
  }

  @rpc(browserDataAuthority("read"))
  isNeverSave(origin: string): boolean {
    const normalized = this.httpOrigin(origin);
    if (!normalized) return false;
    return (
      this.sql.exec(`SELECT 1 FROM password_never_save WHERE origin = ?`, normalized).toArray()
        .length > 0
    );
  }

  @rpc(browserDataAuthority("read"))
  getNeverSaveOrigins(): string[] {
    return this.sql
      .exec(`SELECT origin FROM password_never_save ORDER BY origin`)
      .toArray()
      .map((row) => String(row["origin"]));
  }

  @rpc(browserDataAuthority("destructive"))
  removeNeverSave(origin: string): void {
    const normalized = this.httpOrigin(origin);
    if (normalized) this.sql.exec(`DELETE FROM password_never_save WHERE origin = ?`, normalized);
  }

  @rpc(browserDataAuthority("write"))
  updateLastUsed(id: number): void {
    this.sql.exec(
      `UPDATE passwords SET date_last_used = ?, times_used = times_used + 1 WHERE id = ?`,
      Date.now(),
      id
    );
  }

  // -- Structured form fill ------------------------------------------------

  @rpc(browserDataAuthority("read"))
  async getFormFillSuggestions(query: FormFillSuggestionQuery) {
    if (!FORM_FILL_TYPES.includes(query.type)) throw new Error("Unknown form-fill type");
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const rows = this.sql
      .exec(
        `SELECT * FROM form_fill_values WHERE type = ?
         ORDER BY use_count DESC, updated_at DESC LIMIT ?`,
        query.type,
        limit * 4
      )
      .toArray();
    const values = await Promise.all(rows.map((row) => this.formFillRow(row)));
    const prefix = query.prefix?.toLocaleLowerCase();
    return (
      prefix ? values.filter((entry) => entry.value.toLocaleLowerCase().startsWith(prefix)) : values
    ).slice(0, limit);
  }

  @rpc(browserDataAuthority("write"))
  async addFormFillValue(input: FormFillValueInput, sourceId?: string): Promise<number> {
    if (!FORM_FILL_TYPES.includes(input.type)) throw new Error("Unknown form-fill type");
    const value = input.value.trim();
    if (!value) throw new Error("Form-fill value cannot be empty");
    const now = Date.now();
    const valueHash = await this.hashSecret(value);
    const encrypted = await this.encryptText(value);
    const aliases = JSON.stringify(this.normalizedAliases(input.aliases));
    const row = this.sql
      .exec(
        `INSERT INTO form_fill_values
          (type, value_hash, value_encrypted, display_label, aliases, created_at, updated_at,
           use_count, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(type, value_hash) DO UPDATE SET
           value_encrypted = excluded.value_encrypted,
           display_label = COALESCE(excluded.display_label, form_fill_values.display_label),
           aliases = excluded.aliases,
           updated_at = MAX(form_fill_values.updated_at, excluded.updated_at),
           use_count = MAX(form_fill_values.use_count, excluded.use_count),
           source_id = COALESCE(excluded.source_id, form_fill_values.source_id)
         RETURNING id`,
        input.type,
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

  @rpc(browserDataAuthority("write"))
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

  @rpc(browserDataAuthority("write"))
  markFormFillValueUsed(id: number): void {
    this.sql.exec(
      `UPDATE form_fill_values SET use_count = use_count + 1, updated_at = ? WHERE id = ?`,
      Date.now(),
      id
    );
  }

  @rpc(browserDataAuthority("destructive"))
  deleteFormFillValue(id: number): void {
    this.sql.exec(`DELETE FROM form_fill_values WHERE id = ?`, id);
  }

  @rpc(browserDataAuthority("destructive"))
  clearFormFillValues(): number {
    this.sql.exec(`DELETE FROM form_fill_values`);
    return this.changes();
  }

  // -- Canonical cookie jar -------------------------------------------------

  @rpc(browserDataAuthority("write"))
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
              item.input.partitionKey ?? "",
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
            key.partitionKey ?? ""
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

  @rpc(browserDataAuthority("read"))
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
    const cookies = await Promise.all(rows.map((row) => this.cookieRow(row)));
    return { revision: this.currentCookieRevision(), cookies };
  }

  @rpc(browserDataAuthority("read"))
  async getCookiesForOrigin(origin: string): Promise<StoredCookie[]> {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    const snapshot = await this.getCookieSnapshot();
    return snapshot.cookies.filter((cookie) => this.cookieMatchesUrl(cookie, url));
  }

  @rpc(browserDataAuthority("destructive"))
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

  @rpc(browserDataAuthority("destructive"))
  clearAllCookies(): number {
    const rows = this.sql.exec(`SELECT name, domain, path, partition_key FROM cookies`).toArray();
    return this.deleteCookieRows(rows);
  }

  @rpc(browserDataAuthority("destructive"))
  endBrowserSession(): number {
    const rows = this.sql
      .exec(`SELECT name, domain, path, partition_key FROM cookies WHERE expiration_date IS NULL`)
      .toArray();
    return this.deleteCookieRows(rows);
  }

  @rpc(browserDataAuthority("read"))
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

  // -- Search engines and favicons -----------------------------------------

  @rpc(browserDataAuthority("read"))
  getSearchEngines() {
    return this.sql.exec(`SELECT * FROM search_engines ORDER BY is_default DESC, name`).toArray();
  }

  @rpc(browserDataAuthority("write"))
  setDefaultEngine(id: number): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE search_engines SET is_default = 0`);
      this.sql.exec(`UPDATE search_engines SET is_default = 1 WHERE id = ?`, id);
    });
  }

  @rpc(browserDataAuthority("write"))
  putPageFavicon(favicon: PageFavicon): void {
    const page = new URL(favicon.pageUrl);
    const origin = new URL(favicon.origin);
    if (
      (page.protocol !== "http:" && page.protocol !== "https:") ||
      page.origin !== origin.origin ||
      favicon.mimeType !== "image/png"
    ) {
      throw new Error("Favicon page association must use one matching HTTP(S) origin");
    }
    this.assertFaviconBytes(favicon.png16);
    this.assertFaviconBytes(favicon.png32);
    if (!favicon.png16 && !favicon.png32) throw new Error("Favicon has no raster data");
    this.sql.exec(
      `INSERT INTO page_favicons
        (page_url, origin, source_url, png16, png32, mime_type, updated_at)
       VALUES (?, ?, ?, ?, ?, 'image/png', ?)
       ON CONFLICT(page_url) DO UPDATE SET
         origin = excluded.origin,
         source_url = excluded.source_url,
         png16 = excluded.png16,
         png32 = excluded.png32,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= page_favicons.updated_at`,
      page.href,
      origin.origin,
      favicon.sourceUrl ?? null,
      favicon.png16 ?? null,
      favicon.png32 ?? null,
      favicon.updatedAt
    );
  }

  @rpc(browserDataAuthority("read"))
  getPageFavicon(pageUrl: string) {
    const page = new URL(pageUrl);
    if (page.protocol !== "http:" && page.protocol !== "https:") return null;
    const exact = this.sql
      .exec(`SELECT * FROM page_favicons WHERE page_url = ?`, page.href)
      .toArray()[0];
    if (exact) return exact;
    return (
      this.sql
        .exec(
          `SELECT * FROM page_favicons WHERE origin = ? ORDER BY updated_at DESC LIMIT 1`,
          page.origin
        )
        .toArray()[0] ?? null
    );
  }

  // -- Import storage ------------------------------------------------------

  @rpc(browserDataAuthority("write"))
  upsertImportJob(job: ImportJobWrite): void {
    this.sql.exec(
      `INSERT INTO import_jobs
        (job_id, host_id, host_label, source_id, browser, phase, started_at, updated_at,
         finished_at, data_types, progress, warnings, error, resumable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         phase = excluded.phase,
         updated_at = excluded.updated_at,
         finished_at = excluded.finished_at,
         progress = excluded.progress,
         warnings = excluded.warnings,
         error = excluded.error,
         resumable = excluded.resumable`,
      job.jobId,
      job.hostId,
      job.hostLabel,
      job.sourceId,
      job.browser,
      job.phase,
      job.startedAt,
      job.updatedAt,
      job.finishedAt ?? null,
      JSON.stringify(job.dataTypes),
      JSON.stringify(job.progress),
      JSON.stringify(job.warnings),
      job.error ?? null,
      job.resumable ? 1 : 0
    );
  }

  @rpc(browserDataAuthority("read"))
  getImportJob(jobId: string) {
    const row = this.sql.exec(`SELECT * FROM import_jobs WHERE job_id = ?`, jobId).toArray()[0];
    return row ? this.importJobRow(row) : null;
  }

  @rpc(browserDataAuthority("read"))
  listImportJobs() {
    return this.sql
      .exec(`SELECT * FROM import_jobs ORDER BY updated_at DESC LIMIT 100`)
      .toArray()
      .map((row) => this.importJobRow(row));
  }

  @rpc(browserDataAuthority("write"))
  recordImportBatch(input: {
    jobId: string;
    dataType: string;
    batchIndex: number;
    idempotencyKey: string;
    itemCount: number;
  }): { stored: boolean } {
    const existing = this.sql
      .exec(`SELECT 1 FROM import_batches WHERE idempotency_key = ?`, input.idempotencyKey)
      .toArray();
    if (existing.length > 0) return { stored: false };
    this.sql.exec(
      `INSERT INTO import_batches
        (job_id, data_type, batch_index, idempotency_key, item_count, stored_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.jobId,
      input.dataType,
      input.batchIndex,
      input.idempotencyKey,
      input.itemCount,
      Date.now()
    );
    return { stored: true };
  }

  @rpc(browserDataAuthority("write"))
  async addBookmarksBatch(bookmarks: ImportedBookmark[], meta: ImportSourceMeta): Promise<number> {
    return this.runBatch(bookmarks.length, (index) => {
      const bookmark = bookmarks[index];
      if (!bookmark) throw new Error(`Bookmark batch item ${index} is unavailable`);
      const folderPath = `/${bookmark.folder.join("/")}`.replace(/\/+/g, "/");
      const importKey = this.importKey("bookmark", meta.sourceId, [
        bookmark.sourceId ?? "",
        bookmark.url,
        folderPath,
      ]);
      this.sql.exec(
        `INSERT INTO bookmarks
          (title, url, folder_path, date_added, date_modified, position, source_id, import_key,
           tags, keyword)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(import_key) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           folder_path = excluded.folder_path,
           date_modified = MAX(bookmarks.date_modified, excluded.date_modified),
           tags = excluded.tags,
           keyword = excluded.keyword`,
        bookmark.title,
        bookmark.url,
        folderPath,
        bookmark.dateAdded,
        bookmark.dateModified ?? bookmark.dateAdded,
        index,
        meta.sourceId,
        importKey,
        bookmark.tags?.join(",") ?? null,
        bookmark.keyword ?? null
      );
    });
  }

  @rpc(browserDataAuthority("write"))
  async addHistoryBatch(entries: ImportedHistoryEntry[], meta: ImportSourceMeta): Promise<number> {
    return this.runBatch(entries.length, (index) => {
      const entry = entries[index];
      if (!entry) throw new Error(`History batch item ${index} is unavailable`);
      const visits = this.importedVisitsForEntry(entry);
      for (const visit of visits) {
        const historyId = this.ensureHistoryRow(entry.url, entry.title, visit.visitTime);
        this.insertHistoryVisit(historyId, {
          visitTime: visit.visitTime,
          transition: visit.transition ?? entry.transition ?? "link",
          source: "import",
          importSourceId: meta.sourceId,
          panelId: "",
          title: entry.title,
          typed: visit.typed ?? false,
        });
        this.recomputeHistorySummary(historyId);
      }
    });
  }

  @rpc(browserDataAuthority("write"))
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

  @rpc(browserDataAuthority("write"))
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

  @rpc(browserDataAuthority("write"))
  async addFormFillBatch(values: FormFillValueInput[], meta: ImportSourceMeta): Promise<number> {
    let stored = 0;
    for (const value of values) {
      await this.addFormFillValue(value, meta.sourceId);
      stored += 1;
    }
    return stored;
  }

  @rpc(browserDataAuthority("write"))
  async addSearchEnginesBatch(
    engines: ImportedSearchEngine[],
    meta: ImportSourceMeta
  ): Promise<number> {
    return this.runBatch(engines.length, (index) => {
      const engine = engines[index];
      if (!engine) throw new Error(`Search-engine batch item ${index} is unavailable`);
      const importKey = this.importKey("search-engine", meta.sourceId, [
        engine.sourceId ?? "",
        engine.searchUrl,
      ]);
      if (engine.isDefault) this.sql.exec(`UPDATE search_engines SET is_default = 0`);
      this.sql.exec(
        `INSERT INTO search_engines
          (name, keyword, search_url, suggest_url, favicon_url, is_default, source_id, import_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(import_key) DO UPDATE SET
           name = excluded.name,
           keyword = excluded.keyword,
           search_url = excluded.search_url,
           suggest_url = excluded.suggest_url,
           favicon_url = excluded.favicon_url,
           is_default = excluded.is_default`,
        engine.name,
        engine.keyword ?? null,
        engine.searchUrl,
        engine.suggestUrl ?? null,
        engine.faviconUrl ?? null,
        engine.isDefault ? 1 : 0,
        meta.sourceId,
        importKey
      );
    });
  }

  @rpc(browserDataAuthority("write"))
  async addFaviconsBatch(favicons: PageFavicon[]): Promise<number> {
    return this.runBatch(favicons.length, (index) => {
      const favicon = favicons[index];
      if (!favicon) throw new Error(`Favicon batch item ${index} is unavailable`);
      return this.putPageFavicon(favicon);
    });
  }

  // -- Helpers -------------------------------------------------------------

  private ensureHistoryRow(url: string, title: string | undefined, observedAt: number): number {
    const row = this.sql
      .exec(
        `INSERT INTO history(url, title, visit_count, typed_count, first_visit, last_visit)
         VALUES (?, ?, 0, 0, NULL, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = CASE WHEN excluded.title IS NOT NULL AND excluded.title != ''
             THEN excluded.title ELSE history.title END,
           last_visit = MAX(history.last_visit, excluded.last_visit)
         RETURNING id`,
        url,
        title?.trim() || null,
        observedAt
      )
      .one();
    return Number(row["id"]);
  }

  private insertHistoryVisit(historyId: number, visit: HistoryVisitWrite): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO history_visits
        (history_id, visit_time, transition, source, import_source_id, panel_id, title, typed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      historyId,
      visit.visitTime,
      visit.transition,
      visit.source,
      visit.importSourceId,
      visit.panelId,
      visit.title ?? null,
      visit.typed ? 1 : 0
    );
  }

  private recomputeHistorySummary(historyId: number): void {
    this.sql.exec(
      `UPDATE history SET
         visit_count = (SELECT COUNT(*) FROM history_visits WHERE history_id = ?),
         typed_count = (SELECT COALESCE(SUM(typed), 0) FROM history_visits WHERE history_id = ?),
         first_visit = (SELECT MIN(visit_time) FROM history_visits WHERE history_id = ?),
         last_visit = (SELECT MAX(visit_time) FROM history_visits WHERE history_id = ?),
         title = COALESCE(
           (SELECT title FROM history_visits
            WHERE history_id = ? AND title IS NOT NULL AND title != ''
            ORDER BY visit_time DESC LIMIT 1),
           title
         )
       WHERE id = ?`,
      historyId,
      historyId,
      historyId,
      historyId,
      historyId,
      historyId
    );
  }

  private importedVisitsForEntry(entry: ImportedHistoryEntry): ImportedHistoryVisit[] {
    if (entry.visits?.length) {
      return entry.visits
        .filter((visit) => Number.isFinite(visit.visitTime) && visit.visitTime > 0)
        .sort((a, b) => a.visitTime - b.visitTime);
    }
    if (!Number.isFinite(entry.lastVisitTime) || entry.lastVisitTime <= 0) return [];
    const count = Math.max(1, entry.visitCount || 1);
    const first =
      entry.firstVisitTime && Number.isFinite(entry.firstVisitTime)
        ? Math.min(entry.firstVisitTime, entry.lastVisitTime)
        : entry.lastVisitTime;
    if (count === 1 || first === entry.lastVisitTime) {
      return [{ visitTime: entry.lastVisitTime, transition: entry.transition }];
    }
    const step = (entry.lastVisitTime - first) / (count - 1);
    return Array.from({ length: count }, (_, index) => ({
      visitTime: Math.round(first + step * index),
      transition: entry.transition,
      typed: index < (entry.typedCount ?? 0),
    }));
  }

  private normalizeCookie(input: BrowserCookieInput): BrowserCookieInput {
    const key = this.normalizeCookieKey(input);
    return {
      ...input,
      ...key,
      sameSite: input.sameSite,
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
      ...(key.partitionKey ? { partitionKey: key.partitionKey } : {}),
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
          key.partitionKey ?? ""
        )
        .toArray()[0] ?? null
    );
  }

  private async cookieRow(row: Record<string, unknown>): Promise<StoredCookie> {
    const encryptedValue = String(row["encrypted_value"]);
    return {
      name: String(row["name"]),
      domain: String(row["domain"]),
      path: String(row["path"]),
      ...(String(row["partition_key"] ?? "") ? { partitionKey: String(row["partition_key"]) } : {}),
      encryptedValue,
      value: await this.decryptText(encryptedValue),
      contentHash: String(row["content_hash"]),
      hostOnly: Number(row["host_only"]) === 1,
      secure: Number(row["secure"]) === 1,
      httpOnly: Number(row["http_only"]) === 1,
      sameSite: String(row["same_site"]) as BrowserCookieRecord["sameSite"],
      ...(row["expiration_date"] == null ? {} : { expirationDate: Number(row["expiration_date"]) }),
      ...(row["source_scheme"] == null ? {} : { sourceScheme: String(row["source_scheme"]) }),
      ...(row["source_port"] == null ? {} : { sourcePort: Number(row["source_port"]) }),
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
        cookie.partitionKey ?? "",
        cookie.hostOnly,
        cookie.secure,
        cookie.httpOnly,
        cookie.sameSite,
        cookie.expirationDate ?? null,
        cookie.sourceScheme ?? null,
        cookie.sourcePort ?? null,
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
      type: String(row["type"]),
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

  private importJobRow(row: Record<string, unknown>) {
    return {
      jobId: String(row["job_id"]),
      hostId: String(row["host_id"]),
      hostLabel: String(row["host_label"]),
      sourceId: String(row["source_id"]),
      browser: String(row["browser"]),
      phase: String(row["phase"]),
      startedAt: Number(row["started_at"]),
      updatedAt: Number(row["updated_at"]),
      ...(row["finished_at"] == null ? {} : { finishedAt: Number(row["finished_at"]) }),
      requestedDataTypes: this.parseStringArray(row["data_types"]),
      progress: this.parseJson(row["progress"], []),
      warnings: this.parseStringArray(row["warnings"]),
      ...(row["error"] == null ? {} : { error: String(row["error"]) }),
      resumable: Number(row["resumable"]) === 1,
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

  private requireHttpOrigin(raw: string): string {
    const origin = this.httpOrigin(raw);
    if (!origin) throw new Error("Origin must use HTTP(S)");
    return origin;
  }

  private normalizedAliases(aliases: string[] | undefined): string[] {
    return [
      ...new Set(
        (aliases ?? [])
          .map((alias) => alias.trim().toLocaleLowerCase())
          .filter((alias) => alias.length > 0 && alias.length <= 200)
      ),
    ].slice(0, 50);
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

  private assertFaviconBytes(value: Uint8Array | undefined): void {
    if (value && value.byteLength > MAX_FAVICON_BYTES) {
      throw new Error(`Favicon exceeds ${MAX_FAVICON_BYTES} bytes`);
    }
  }

  private importKey(kind: string, sourceId: string, parts: string[]): string {
    return [kind, sourceId, ...parts].join("\x00");
  }

  private updateByMap(
    table: string,
    id: number,
    map: Record<string, string>,
    partial: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(map)) {
      if (partial[field] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(partial[field]);
      }
    }
    for (const [column, value] of Object.entries(extra)) {
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.sql.exec(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`, ...values);
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

  private escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
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
