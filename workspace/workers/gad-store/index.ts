import { DurableObjectBase, type DurableObjectContext } from "@workspace/runtime/worker";

type JsonRecord = Record<string, unknown>;

interface RecordSessionInput {
  id: string;
  parentSessionId?: string | null;
  source: string;
  projectPath?: string | null;
  gitBranch?: string | null;
  branchId?: string | null;
  channelId?: string | null;
  contextId?: string | null;
  metadata?: JsonRecord | null;
  startedAt?: string | null;
}

interface RecordTurnInput {
  sessionId: string;
  role: string;
  content: string;
  contentFormat?: string;
  turnIndex?: number;
  tokenCount?: number | null;
  timestamp?: string | null;
  messageIndex?: number | null;
  channelId?: string | null;
}

interface BeginToolCallInput {
  sessionId: string;
  turnId?: number | null;
  toolName: string;
  parameters?: JsonRecord | null;
  isMutation?: boolean;
  gitBranch?: string | null;
  gitCommit?: string | null;
  branchId?: string | null;
  channelId?: string | null;
  contextId?: string | null;
  startedAt?: string | null;
}

interface RecordReadInput {
  toolCallId: number;
  readType?: string;
  filePath?: string | null;
  contentHash: string;
  contentSize?: number | null;
  sourceBlobHash?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  byteOffset?: number | null;
  byteLength?: number | null;
  metadata?: JsonRecord | null;
}

interface RecordMutationInput {
  toolCallId: number;
  filePath: string;
  renamedFromPath?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
  beforeSize?: number | null;
  afterSize?: number | null;
  mutationType: string;
  oldString?: string | null;
  newString?: string | null;
  description?: string | null;
  branchId?: string | null;
}

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromBase64(base64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function base64FromBytes(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

function packVector(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function unpackVector(value: unknown, dim: number): number[] {
  const bytes =
    value instanceof Uint8Array
      ? value
      : Array.isArray(value)
        ? Uint8Array.from(value as number[])
        : typeof value === "string"
          ? bytesFromBase64(value)
          : new Uint8Array(value as ArrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: number[] = [];
  for (let i = 0; i < dim; i++) result.push(view.getFloat32(i * 4, true));
  return result;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function extname(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  return dot > slash ? filePath.slice(dot).toLowerCase() : "";
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "c_sharp",
  ".sh": "bash",
  ".bash": "bash",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".html": "html",
  ".css": "css",
  ".md": "markdown",
};

function detectLanguage(filePath: string): string | null {
  return LANGUAGE_BY_EXT[extname(filePath)] ?? null;
}

function structurePatterns(language: string): Array<{ nodeType: string; regex: RegExp }> {
  if (language === "python") {
    return [
      { nodeType: "function_definition", regex: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm },
      { nodeType: "class_definition", regex: /^\s*class\s+([A-Za-z_][\w]*)\b/gm },
    ];
  }
  if (language === "go") {
    return [
      { nodeType: "function_declaration", regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/gm },
      { nodeType: "type_declaration", regex: /^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/gm },
    ];
  }
  if (language === "rust") {
    return [
      { nodeType: "function_item", regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/gm },
      { nodeType: "struct_item", regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)\b/gm },
      { nodeType: "enum_item", regex: /^\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)\b/gm },
    ];
  }
  return [
    { nodeType: "function_declaration", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm },
    { nodeType: "class_declaration", regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/gm },
    { nodeType: "method_definition", regex: /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[{:]?/gm },
    { nodeType: "variable_declaration", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm },
  ];
}

export class GadWorkspaceDO extends DurableObjectBase {
  static override schemaVersion = 1;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mime_type TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_branch_id TEXT REFERENCES branches(id),
        forked_from_session_id TEXT,
        forked_from_turn_id INTEGER,
        forked_from_message_index INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_by TEXT,
        archived_at TEXT
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_branches_parent ON branches(parent_branch_id)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tracked_files (
        path TEXT NOT NULL,
        git_branch TEXT NOT NULL DEFAULT 'unknown',
        branch_id TEXT,
        current_hash TEXT REFERENCES blobs(hash),
        is_deleted INTEGER NOT NULL DEFAULT 0,
        last_modified TEXT NOT NULL DEFAULT (datetime('now')),
        fs_mtime INTEGER,
        PRIMARY KEY (path, git_branch, branch_id)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_tracked_files_branch_id ON tracked_files(branch_id)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT REFERENCES sessions(id),
        source TEXT NOT NULL,
        project_path TEXT,
        git_branch TEXT,
        branch_id TEXT,
        channel_id TEXT,
        context_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        metadata TEXT
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_context ON sessions(context_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_branch_id ON sessions(branch_id)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_format TEXT NOT NULL DEFAULT 'text',
        turn_index INTEGER NOT NULL,
        token_count INTEGER,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        message_index INTEGER,
        channel_id TEXT
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_turns_session ON conversation_turns(session_id, turn_index)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_turns_channel ON conversation_turns(channel_id)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        turn_id INTEGER REFERENCES conversation_turns(id),
        tool_name TEXT NOT NULL,
        parameters TEXT,
        result_summary TEXT,
        is_mutation INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        git_branch TEXT,
        git_commit TEXT,
        branch_id TEXT,
        channel_id TEXT,
        context_id TEXT
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_time ON tool_calls(started_at)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_branch_id ON tool_calls(branch_id)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS file_versions (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL REFERENCES blobs(hash),
        git_branch TEXT NOT NULL DEFAULT 'unknown',
        git_commit TEXT,
        branch_id TEXT,
        session_id TEXT REFERENCES sessions(id),
        tool_call_id INTEGER REFERENCES tool_calls(id),
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_file_versions_path_branch ON file_versions(path, git_branch)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_file_versions_hash ON file_versions(content_hash)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_file_versions_session ON file_versions(session_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_file_versions_branch_id ON file_versions(branch_id)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tool_call_reads (
        id INTEGER PRIMARY KEY,
        tool_call_id INTEGER NOT NULL REFERENCES tool_calls(id),
        read_type TEXT NOT NULL DEFAULT 'file',
        file_path TEXT,
        content_hash TEXT NOT NULL REFERENCES blobs(hash),
        source_blob_hash TEXT REFERENCES blobs(hash),
        start_line INTEGER,
        end_line INTEGER,
        byte_offset INTEGER,
        byte_length INTEGER,
        metadata TEXT
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_reads_tool_call ON tool_call_reads(tool_call_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_reads_hash ON tool_call_reads(content_hash)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_reads_path ON tool_call_reads(file_path)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_reads_source_blob ON tool_call_reads(source_blob_hash)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tool_call_mutations (
        id INTEGER PRIMARY KEY,
        tool_call_id INTEGER NOT NULL REFERENCES tool_calls(id),
        file_path TEXT NOT NULL,
        renamed_from_path TEXT,
        before_hash TEXT REFERENCES blobs(hash),
        after_hash TEXT REFERENCES blobs(hash),
        mutation_type TEXT NOT NULL,
        old_string TEXT,
        new_string TEXT,
        description TEXT
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mutations_tool_call ON tool_call_mutations(tool_call_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mutations_path ON tool_call_mutations(file_path)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mutations_renamed_from ON tool_call_mutations(renamed_from_path)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mutations_before ON tool_call_mutations(before_hash)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mutations_after ON tool_call_mutations(after_hash)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY,
        content_hash TEXT NOT NULL REFERENCES blobs(hash),
        source_path TEXT,
        title TEXT,
        content TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(id),
        tool_call_id INTEGER REFERENCES tool_calls(id),
        branch_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        superseded_by INTEGER REFERENCES plans(id)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_plans_hash ON plans(content_hash)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_plans_superseded ON plans(superseded_by)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_plans_branch_id ON plans(branch_id)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS parsed_structures (
        id INTEGER PRIMARY KEY,
        file_content_hash TEXT NOT NULL REFERENCES blobs(hash),
        file_path TEXT NOT NULL,
        language TEXT NOT NULL,
        node_type TEXT NOT NULL,
        node_name TEXT,
        content_hash TEXT NOT NULL,
        content_size INTEGER NOT NULL,
        start_byte INTEGER NOT NULL,
        end_byte INTEGER NOT NULL,
        start_row INTEGER NOT NULL,
        start_col INTEGER NOT NULL,
        end_row INTEGER NOT NULL,
        end_col INTEGER NOT NULL,
        parent_node_id INTEGER REFERENCES parsed_structures(id),
        depth INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_parsed_file_hash ON parsed_structures(file_content_hash)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_parsed_content_hash ON parsed_structures(content_hash)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_parsed_name_type ON parsed_structures(node_name, node_type)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_parsed_type ON parsed_structures(node_type)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_parsed_path ON parsed_structures(file_path)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_parsed_parent ON parsed_structures(parent_node_id)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS semantic_chunks (
        content_hash TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        topic_label TEXT,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS semantic_chunk_mentions (
        id INTEGER PRIMARY KEY,
        chunk_hash TEXT NOT NULL REFERENCES semantic_chunks(content_hash),
        attribution TEXT,
        source_session_id TEXT REFERENCES sessions(id),
        source_turn_id INTEGER REFERENCES conversation_turns(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (chunk_hash, attribution, source_session_id, source_turn_id)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_mentions_hash ON semantic_chunk_mentions(chunk_hash)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_mentions_session ON semantic_chunk_mentions(source_session_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS semantic_relations (
        id INTEGER PRIMARY KEY,
        chunk_hash TEXT NOT NULL REFERENCES semantic_chunks(content_hash),
        target_type TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_relations_chunk ON semantic_relations(chunk_hash)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_relations_target ON semantic_relations(target_type, target_hash)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_hash TEXT NOT NULL REFERENCES semantic_chunks(content_hash),
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (chunk_hash, model)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON chunk_embeddings(model)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS turn_embeddings (
        turn_id INTEGER NOT NULL REFERENCES conversation_turns(id),
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (turn_id, model)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_turn_embeddings_model ON turn_embeddings(model)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS branch_snapshots (
        id INTEGER PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id),
        parent_snapshot_id INTEGER REFERENCES branch_snapshots(id),
        session_id TEXT REFERENCES sessions(id),
        turn_id INTEGER REFERENCES conversation_turns(id),
        summary TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_branch_snapshots_branch ON branch_snapshots(branch_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS branch_files (
        branch_id TEXT NOT NULL REFERENCES branches(id),
        path TEXT NOT NULL,
        current_hash TEXT REFERENCES blobs(hash),
        is_deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (branch_id, path)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshot_file_changes (
        snapshot_id INTEGER NOT NULL REFERENCES branch_snapshots(id),
        path TEXT NOT NULL,
        before_hash TEXT REFERENCES blobs(hash),
        after_hash TEXT REFERENCES blobs(hash),
        mutation_type TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, path)
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS blob_policies (
        hash TEXT PRIMARY KEY,
        retention_class TEXT NOT NULL DEFAULT 'workspace',
        privacy_level TEXT NOT NULL DEFAULT 'normal',
        expires_at TEXT,
        redacted_at TEXT,
        redaction_reason TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_blob_policies_retention ON blob_policies(retention_class)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_blob_policies_privacy ON blob_policies(privacy_level)`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_index_jobs (
        id INTEGER PRIMARY KEY,
        job_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(job_type, target_type, target_id)
      )
    `);
  }

  rawSql(sql: string, bindings: unknown[] = []): { rows: JsonRecord[] } {
    this.ensureReady();
    return { rows: this.sql.exec(sql, ...bindings).toArray() as JsonRecord[] };
  }

  ensureBlob(hash: string, size = 0, mimeType?: string | null): void {
    this.ensureReady();
    this.sql.exec(
      `INSERT OR IGNORE INTO blobs (hash, size, mime_type) VALUES (?, ?, ?)`,
      hash,
      size,
      mimeType ?? null,
    );
  }

  ensureBranch(input: {
    id: string;
    name?: string;
    parentBranchId?: string | null;
    forkedFromSessionId?: string | null;
    forkedFromTurnId?: number | null;
    forkedFromMessageIndex?: number | null;
    createdBy?: string | null;
  }): { id: string } {
    this.ensureReady();
    this.sql.exec(
      `INSERT OR IGNORE INTO branches (
         id, name, parent_branch_id, forked_from_session_id,
         forked_from_turn_id, forked_from_message_index, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.name ?? input.id,
      input.parentBranchId ?? null,
      input.forkedFromSessionId ?? null,
      input.forkedFromTurnId ?? null,
      input.forkedFromMessageIndex ?? null,
      input.createdBy ?? null,
    );
    return { id: input.id };
  }

  listBranches(): JsonRecord[] {
    this.ensureReady();
    return this.sql.exec(`
      SELECT b.*,
        (SELECT COUNT(*) FROM branch_files bf WHERE bf.branch_id = b.id AND bf.is_deleted = 0) AS file_count,
        (SELECT COUNT(*) FROM branch_snapshots bs WHERE bs.branch_id = b.id) AS snapshot_count
      FROM branches b
      ORDER BY b.created_at DESC
    `).toArray() as JsonRecord[];
  }

  getBranch(branchId: string): JsonRecord | null {
    this.ensureReady();
    const rows = this.sql.exec(`
      SELECT b.*,
        (SELECT COUNT(*) FROM branch_files bf WHERE bf.branch_id = b.id AND bf.is_deleted = 0) AS file_count,
        (SELECT COUNT(*) FROM branch_snapshots bs WHERE bs.branch_id = b.id) AS snapshot_count
      FROM branches b
      WHERE b.id = ?
    `, branchId).toArray() as JsonRecord[];
    return rows[0] ?? null;
  }

  listBranchFiles(branchId: string): JsonRecord[] {
    this.ensureReady();
    return this.sql.exec(
      `SELECT * FROM branch_files WHERE branch_id = ? ORDER BY path`,
      branchId,
    ).toArray() as JsonRecord[];
  }

  createBranchSnapshot(input: {
    branchId: string;
    parentSnapshotId?: number | null;
    sessionId?: string | null;
    turnId?: number | null;
    summary?: string | null;
  }): { id: number } {
    this.ensureReady();
    this.sql.exec(
      `INSERT INTO branch_snapshots (branch_id, parent_snapshot_id, session_id, turn_id, summary)
       VALUES (?, ?, ?, ?, ?)`,
      input.branchId,
      input.parentSnapshotId ?? null,
      input.sessionId ?? null,
      input.turnId ?? null,
      input.summary ?? null,
    );
    const snapshotId = asNumber(this.sql.exec(`SELECT last_insert_rowid() AS id`).one()["id"]);
    const rows = this.sql.exec(
      `SELECT path, current_hash FROM branch_files WHERE branch_id = ?`,
      input.branchId,
    ).toArray() as JsonRecord[];
    for (const row of rows) {
      this.sql.exec(
        `INSERT OR REPLACE INTO snapshot_file_changes (snapshot_id, path, before_hash, after_hash, mutation_type)
         VALUES (?, ?, NULL, ?, 'snapshot')`,
        snapshotId,
        row["path"],
        row["current_hash"] ?? null,
      );
    }
    return { id: snapshotId };
  }

  listBranchSnapshots(branchId?: string | null): JsonRecord[] {
    this.ensureReady();
    if (branchId) {
      return this.sql.exec(
        `SELECT * FROM branch_snapshots WHERE branch_id = ? ORDER BY created_at DESC`,
        branchId,
      ).toArray() as JsonRecord[];
    }
    return this.sql.exec(`SELECT * FROM branch_snapshots ORDER BY created_at DESC`).toArray() as JsonRecord[];
  }

  forkBranch(input: {
    id: string;
    name?: string;
    parentBranchId: string;
    forkedFromSessionId?: string | null;
    forkedFromTurnId?: number | null;
    forkedFromMessageIndex?: number | null;
    createdBy?: string | null;
  }): { id: string } {
    this.ensureReady();
    this.ensureBranch(input);
    const files = this.sql.exec(
      `SELECT path, current_hash, is_deleted FROM branch_files WHERE branch_id = ?`,
      input.parentBranchId,
    ).toArray() as JsonRecord[];
    for (const file of files) {
      this.sql.exec(
        `INSERT OR REPLACE INTO branch_files (branch_id, path, current_hash, is_deleted, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.id,
        file["path"],
        file["current_hash"] ?? null,
        file["is_deleted"] ?? 0,
        nowIso(),
      );
    }
    return { id: input.id };
  }

  recordSession(input: RecordSessionInput): { id: string } {
    this.ensureReady();
    this.sql.exec(
      `INSERT INTO sessions (
         id, parent_session_id, source, project_path, git_branch, branch_id,
         channel_id, context_id, started_at, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
         source = excluded.source,
         project_path = COALESCE(excluded.project_path, sessions.project_path),
         git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
         branch_id = COALESCE(excluded.branch_id, sessions.branch_id),
         channel_id = COALESCE(excluded.channel_id, sessions.channel_id),
         context_id = COALESCE(excluded.context_id, sessions.context_id),
         metadata = COALESCE(excluded.metadata, sessions.metadata)`,
      input.id,
      input.parentSessionId ?? null,
      input.source,
      input.projectPath ?? null,
      input.gitBranch ?? null,
      input.branchId ?? null,
      input.channelId ?? null,
      input.contextId ?? null,
      input.startedAt ?? nowIso(),
      json(input.metadata),
    );
    return { id: input.id };
  }

  endSession(sessionId: string, endedAt?: string | null): void {
    this.ensureReady();
    this.sql.exec(`UPDATE sessions SET ended_at = ? WHERE id = ?`, endedAt ?? nowIso(), sessionId);
  }

  recordTurn(input: RecordTurnInput): { id: number; turnIndex: number } {
    this.ensureReady();
    const turnIndex = input.turnIndex ?? this.nextTurnIndex(input.sessionId);
    this.sql.exec(
      `INSERT INTO conversation_turns (
         session_id, role, content, content_format, turn_index, token_count,
         timestamp, message_index, channel_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.sessionId,
      input.role,
      input.content,
      input.contentFormat ?? "text",
      turnIndex,
      input.tokenCount ?? null,
      input.timestamp ?? nowIso(),
      input.messageIndex ?? null,
      input.channelId ?? null,
    );
    const row = this.sql.exec(`SELECT last_insert_rowid() AS id`).one();
    return { id: asNumber(row["id"]), turnIndex };
  }

  beginToolCall(input: BeginToolCallInput): { id: number } {
    this.ensureReady();
    this.sql.exec(
      `INSERT INTO tool_calls (
         session_id, turn_id, tool_name, parameters, is_mutation, started_at,
         git_branch, git_commit, branch_id, channel_id, context_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.sessionId,
      input.turnId ?? null,
      input.toolName,
      json(input.parameters),
      input.isMutation ? 1 : 0,
      input.startedAt ?? nowIso(),
      input.gitBranch ?? null,
      input.gitCommit ?? null,
      input.branchId ?? null,
      input.channelId ?? null,
      input.contextId ?? null,
    );
    const row = this.sql.exec(`SELECT last_insert_rowid() AS id`).one();
    return { id: asNumber(row["id"]) };
  }

  completeToolCall(toolCallId: number, resultSummary?: string | null, completedAt?: string | null): void {
    this.ensureReady();
    this.sql.exec(
      `UPDATE tool_calls SET result_summary = ?, completed_at = ? WHERE id = ?`,
      resultSummary ?? null,
      completedAt ?? nowIso(),
      toolCallId,
    );
  }

  recordRead(input: RecordReadInput): { id: number } {
    this.ensureReady();
    this.ensureBlob(input.contentHash, input.contentSize ?? 0);
    if (input.sourceBlobHash) this.ensureBlob(input.sourceBlobHash, 0);
    this.sql.exec(
      `INSERT INTO tool_call_reads (
         tool_call_id, read_type, file_path, content_hash, source_blob_hash,
         start_line, end_line, byte_offset, byte_length, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.toolCallId,
      input.readType ?? "file",
      input.filePath ?? null,
      input.contentHash,
      input.sourceBlobHash ?? null,
      input.startLine ?? null,
      input.endLine ?? null,
      input.byteOffset ?? null,
      input.byteLength ?? null,
      json(input.metadata),
    );
    const row = this.sql.exec(`SELECT last_insert_rowid() AS id`).one();
    return { id: asNumber(row["id"]) };
  }

  recordMutation(input: RecordMutationInput): { id: number } {
    this.ensureReady();
    if (input.beforeHash) this.ensureBlob(input.beforeHash, input.beforeSize ?? 0);
    if (input.afterHash) this.ensureBlob(input.afterHash, input.afterSize ?? 0);
    this.sql.exec(
      `INSERT INTO tool_call_mutations (
         tool_call_id, file_path, renamed_from_path, before_hash, after_hash,
         mutation_type, old_string, new_string, description
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.toolCallId,
      input.filePath,
      input.renamedFromPath ?? null,
      input.beforeHash ?? null,
      input.afterHash ?? null,
      input.mutationType,
      input.oldString ?? null,
      input.newString ?? null,
      input.description ?? null,
    );
    const mutationId = asNumber(this.sql.exec(`SELECT last_insert_rowid() AS id`).one()["id"]);

    const tc = this.sql.exec(
      `SELECT session_id, git_branch, git_commit, branch_id FROM tool_calls WHERE id = ?`,
      input.toolCallId,
    ).toArray()[0] as JsonRecord | undefined;
    const sessionId = (tc?.["session_id"] as string | undefined) ?? null;
    const gitBranch = (tc?.["git_branch"] as string | null | undefined) ?? "unknown";
    const gitCommit = (tc?.["git_commit"] as string | null | undefined) ?? null;
    const branchId = input.branchId ?? (tc?.["branch_id"] as string | null | undefined) ?? null;

    if (input.afterHash) {
      this.sql.exec(
        `INSERT INTO file_versions (path, content_hash, git_branch, git_commit, branch_id, session_id, tool_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.filePath,
        input.afterHash,
        gitBranch,
        gitCommit,
        branchId,
        sessionId,
        input.toolCallId,
      );
      this.sql.exec(
        `INSERT OR REPLACE INTO tracked_files
           (path, git_branch, branch_id, current_hash, is_deleted, last_modified)
         VALUES (?, ?, ?, ?, 0, ?)`,
        input.filePath,
        gitBranch,
        branchId,
        input.afterHash,
        nowIso(),
      );
      if (branchId) {
        this.sql.exec(
          `INSERT OR REPLACE INTO branch_files (branch_id, path, current_hash, is_deleted, updated_at)
           VALUES (?, ?, ?, 0, ?)`,
          branchId,
          input.filePath,
          input.afterHash,
          nowIso(),
        );
      }
    } else {
      this.sql.exec(
        `UPDATE tracked_files SET current_hash = NULL, is_deleted = 1, last_modified = ?
         WHERE path = ? AND git_branch = ? AND branch_id IS ?`,
        nowIso(),
        input.filePath,
        gitBranch,
        branchId,
      );
      if (branchId) {
        this.sql.exec(
          `INSERT OR REPLACE INTO branch_files (branch_id, path, current_hash, is_deleted, updated_at)
           VALUES (?, ?, NULL, 1, ?)`,
          branchId,
          input.filePath,
          nowIso(),
        );
      }
    }

    return { id: mutationId };
  }

  async recordPlan(input: {
    content: string;
    sourcePath?: string | null;
    title?: string | null;
    sessionId?: string | null;
    toolCallId?: number | null;
    branchId?: string | null;
  }): Promise<JsonRecord> {
    this.ensureReady();
    const contentHash = await sha256Hex(input.content);
    this.ensureBlob(contentHash, new TextEncoder().encode(input.content).byteLength, "text/plain");
    this.sql.exec(
      `INSERT INTO plans (content_hash, source_path, title, content, session_id, tool_call_id, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      contentHash,
      input.sourcePath ?? null,
      input.title ?? null,
      input.content,
      input.sessionId ?? null,
      input.toolCallId ?? null,
      input.branchId ?? null,
    );
    const id = asNumber(this.sql.exec(`SELECT last_insert_rowid() AS id`).one()["id"]);
    return this.sql.exec(`SELECT * FROM plans WHERE id = ?`, id).one() as JsonRecord;
  }

  supersedePlan(oldPlanId: number, newPlanId: number): void {
    this.ensureReady();
    this.sql.exec(`UPDATE plans SET superseded_by = ? WHERE id = ?`, newPlanId, oldPlanId);
  }

  listPlans(input: { activeOnly?: boolean; sourcePath?: string | null; branchId?: string | null } = {}): JsonRecord[] {
    this.ensureReady();
    const where: string[] = [];
    const args: unknown[] = [];
    if (input.activeOnly) where.push("superseded_by IS NULL");
    if (input.sourcePath) {
      where.push("source_path = ?");
      args.push(input.sourcePath);
    }
    if (input.branchId) {
      where.push("branch_id = ?");
      args.push(input.branchId);
    }
    return this.sql.exec(
      `SELECT * FROM plans ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`,
      ...args,
    ).toArray() as JsonRecord[];
  }

  getPlanChain(planId: number): JsonRecord[] {
    this.ensureReady();
    return this.sql.exec(
      `WITH RECURSIVE forward(id) AS (
         SELECT ?
         UNION
         SELECT p.superseded_by FROM plans p JOIN forward f ON p.id = f.id
         WHERE p.superseded_by IS NOT NULL
       ),
       backward(id) AS (
         SELECT ?
         UNION
         SELECT p.id FROM plans p JOIN backward b ON p.superseded_by = b.id
       )
       SELECT DISTINCT p.* FROM plans p
       WHERE p.id IN (SELECT id FROM forward UNION SELECT id FROM backward)
       ORDER BY p.created_at, p.id`,
      planId,
      planId,
    ).toArray() as JsonRecord[];
  }

  async createChunk(input: {
    content: string;
    topicLabel?: string | null;
    attribution?: string | null;
    sourceSessionId?: string | null;
    sourceTurnId?: number | null;
    relations?: Array<{ targetType: string; targetHash: string }> | null;
  }): Promise<JsonRecord> {
    this.ensureReady();
    const contentHash = await sha256Hex(input.content);
    this.ensureBlob(contentHash, new TextEncoder().encode(input.content).byteLength, "text/plain");
    this.sql.exec(
      `INSERT OR IGNORE INTO semantic_chunks (content_hash, content, topic_label)
       VALUES (?, ?, ?)`,
      contentHash,
      input.content,
      input.topicLabel ?? null,
    );
    this.addChunkMention({
      chunkHash: contentHash,
      attribution: input.attribution ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceTurnId: input.sourceTurnId ?? null,
    });
    for (const rel of input.relations ?? []) {
      this.relateChunk(contentHash, rel.targetType, rel.targetHash);
    }
    return this.sql.exec(`SELECT * FROM semantic_chunks WHERE content_hash = ?`, contentHash).one() as JsonRecord;
  }

  addChunkMention(input: {
    chunkHash: string;
    attribution?: string | null;
    sourceSessionId?: string | null;
    sourceTurnId?: number | null;
  }): void {
    this.ensureReady();
    this.sql.exec(
      `INSERT OR IGNORE INTO semantic_chunk_mentions
         (chunk_hash, attribution, source_session_id, source_turn_id)
       VALUES (?, ?, ?, ?)`,
      input.chunkHash,
      input.attribution ?? null,
      input.sourceSessionId ?? null,
      input.sourceTurnId ?? null,
    );
  }

  relateChunk(chunkHash: string, targetType: string, targetHash: string): void {
    this.ensureReady();
    this.sql.exec(
      `INSERT INTO semantic_relations (chunk_hash, target_type, target_hash)
       VALUES (?, ?, ?)`,
      chunkHash,
      targetType,
      targetHash,
    );
  }

  listChunks(input: { attribution?: string | null; since?: string | null } = {}): JsonRecord[] {
    this.ensureReady();
    const where: string[] = [];
    const args: unknown[] = [];
    let join = "";
    if (input.since) {
      where.push("sc.first_seen_at >= ?");
      args.push(input.since);
    }
    if (input.attribution) {
      join = "JOIN semantic_chunk_mentions scm ON scm.chunk_hash = sc.content_hash";
      where.push("scm.attribution = ?");
      args.push(input.attribution);
    }
    return this.sql.exec(
      `SELECT DISTINCT sc.* FROM semantic_chunks sc ${join}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY sc.first_seen_at DESC`,
      ...args,
    ).toArray() as JsonRecord[];
  }

  getChunkMentions(chunkHash: string): JsonRecord[] {
    this.ensureReady();
    return this.sql.exec(
      `SELECT * FROM semantic_chunk_mentions WHERE chunk_hash = ? ORDER BY created_at`,
      chunkHash,
    ).toArray() as JsonRecord[];
  }

  getChunksFor(targetType: string, targetHash: string): JsonRecord[] {
    this.ensureReady();
    return this.sql.exec(
      `SELECT DISTINCT sc.*
       FROM semantic_relations sr
       JOIN semantic_chunks sc ON sc.content_hash = sr.chunk_hash
       WHERE sr.target_type = ? AND sr.target_hash = ?
       ORDER BY sc.first_seen_at DESC`,
      targetType,
      targetHash,
    ).toArray() as JsonRecord[];
  }

  getRelationsFor(chunkHash: string): JsonRecord[] {
    this.ensureReady();
    return this.sql.exec(
      `SELECT * FROM semantic_relations WHERE chunk_hash = ? ORDER BY created_at`,
      chunkHash,
    ).toArray() as JsonRecord[];
  }

  walkDependencies(startHash: string, input: { maxDepth?: number; targetTypes?: string[] } = {}): {
    nodes: JsonRecord[];
    edges: Array<{ from: string; to: string; relationType: string }>;
  } {
    this.ensureReady();
    const maxDepth = input.maxDepth ?? 5;
    const targetTypes = input.targetTypes ?? [];
    const nodes = new Map<string, JsonRecord>();
    const edges: Array<{ from: string; to: string; relationType: string }> = [];
    const visited = new Set<string>([startHash]);
    const queue: Array<[string, number]> = [[startHash, 0]];
    const start = this.sql.exec(`SELECT * FROM semantic_chunks WHERE content_hash = ?`, startHash).toArray()[0] as JsonRecord | undefined;
    if (!start) return { nodes: [], edges: [] };
    nodes.set(startHash, { id: startHash, kind: "chunk", ...start });
    while (queue.length > 0) {
      const [chunkHash, depth] = queue.shift()!;
      if (depth >= maxDepth) continue;
      const relations = targetTypes.length
        ? this.sql.exec(
            `SELECT * FROM semantic_relations WHERE chunk_hash = ? AND target_type IN (${targetTypes.map(() => "?").join(",")})`,
            chunkHash,
            ...targetTypes,
          ).toArray() as JsonRecord[]
        : this.sql.exec(`SELECT * FROM semantic_relations WHERE chunk_hash = ?`, chunkHash).toArray() as JsonRecord[];
      for (const rel of relations) {
        const targetKey = `${rel["target_type"]}:${rel["target_hash"]}`;
        if (!nodes.has(targetKey)) nodes.set(targetKey, { id: targetKey, kind: "target", type: rel["target_type"], hash: rel["target_hash"] });
        edges.push({ from: chunkHash, to: targetKey, relationType: String(rel["target_type"]) });
        const related = this.getChunksFor(String(rel["target_type"]), String(rel["target_hash"]));
        for (const chunk of related) {
          const relatedHash = String(chunk["content_hash"]);
          if (visited.has(relatedHash)) continue;
          visited.add(relatedHash);
          nodes.set(relatedHash, { id: relatedHash, kind: "chunk", ...chunk });
          queue.push([relatedHash, depth + 1]);
        }
      }
    }
    return { nodes: [...nodes.values()], edges };
  }

  upsertChunkEmbedding(input: { chunkHash: string; model: string; vector: number[]; dim?: number }): void {
    this.ensureReady();
    const dim = input.dim ?? input.vector.length;
    this.sql.exec(
      `INSERT OR REPLACE INTO chunk_embeddings (chunk_hash, model, dim, vector)
       VALUES (?, ?, ?, ?)`,
      input.chunkHash,
      input.model,
      dim,
      packVector(input.vector),
    );
  }

  upsertTurnEmbedding(input: { turnId: number; model: string; vector: number[]; dim?: number }): void {
    this.ensureReady();
    const dim = input.dim ?? input.vector.length;
    this.sql.exec(
      `INSERT OR REPLACE INTO turn_embeddings (turn_id, model, dim, vector)
       VALUES (?, ?, ?, ?)`,
      input.turnId,
      input.model,
      dim,
      packVector(input.vector),
    );
  }

  findSimilarChunks(input: { model: string; vector: number[]; k?: number }): JsonRecord[] {
    this.ensureReady();
    const k = input.k ?? 10;
    return (this.sql.exec(
      `SELECT chunk_hash, model, dim, vector, created_at FROM chunk_embeddings WHERE model = ?`,
      input.model,
    ).toArray() as JsonRecord[])
      .map((row) => ({
        chunkHash: row["chunk_hash"],
        score: cosineSimilarity(input.vector, unpackVector(row["vector"], asNumber(row["dim"]))),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  findSimilarTurns(input: { model: string; vector: number[]; k?: number }): JsonRecord[] {
    this.ensureReady();
    const k = input.k ?? 10;
    return (this.sql.exec(
      `SELECT turn_id, model, dim, vector, created_at FROM turn_embeddings WHERE model = ?`,
      input.model,
    ).toArray() as JsonRecord[])
      .map((row) => ({
        turnId: row["turn_id"],
        score: cosineSimilarity(input.vector, unpackVector(row["vector"], asNumber(row["dim"]))),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async parseFileVersion(input: {
    filePath: string;
    contentHash: string;
    content: string;
    language?: string | null;
    includeLeaves?: boolean;
  }): Promise<JsonRecord[]> {
    this.ensureReady();
    const existing = this.sql.exec(
      `SELECT * FROM parsed_structures WHERE file_content_hash = ? ORDER BY start_row, depth`,
      input.contentHash,
    ).toArray() as JsonRecord[];
    if (existing.length > 0) return existing;

    const language = input.language ?? detectLanguage(input.filePath);
    if (!language) return [];
    const lines = input.content.split(/\r\n|\r|\n/u);
    const lineStarts: number[] = [];
    let pos = 0;
    for (const line of lines) {
      lineStarts.push(pos);
      pos += line.length + 1;
    }
    for (const { nodeType, regex } of structurePatterns(language)) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(input.content))) {
        const name = match[1] ?? null;
        const startByte = match.index;
        let startRow = 0;
        for (let i = lineStarts.length - 1; i >= 0; i--) {
          if (lineStarts[i]! <= startByte) {
            startRow = i;
            break;
          }
        }
        const line = lines[startRow] ?? "";
        const startCol = Math.max(0, startByte - (lineStarts[startRow] ?? 0));
        const endByte = startByte + match[0].length;
        const contentHash = await sha256Hex(match[0]);
        this.sql.exec(
          `INSERT INTO parsed_structures (
             file_content_hash, file_path, language, node_type, node_name,
             content_hash, content_size, start_byte, end_byte,
             start_row, start_col, end_row, end_col, parent_node_id, depth
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
          input.contentHash,
          input.filePath,
          language,
          nodeType,
          name,
          contentHash,
          match[0].length,
          startByte,
          endByte,
          startRow,
          startCol,
          startRow,
          line.length,
        );
      }
    }
    return this.sql.exec(
      `SELECT * FROM parsed_structures WHERE file_content_hash = ? ORDER BY start_row, depth`,
      input.contentHash,
    ).toArray() as JsonRecord[];
  }

  getStructures(contentHash: string, input: { nodeTypes?: string[]; minDepth?: number; maxDepth?: number } = {}): JsonRecord[] {
    this.ensureReady();
    const where = ["file_content_hash = ?"];
    const args: unknown[] = [contentHash];
    if (input.nodeTypes?.length) {
      where.push(`node_type IN (${input.nodeTypes.map(() => "?").join(",")})`);
      args.push(...input.nodeTypes);
    }
    if (input.minDepth != null) {
      where.push("depth >= ?");
      args.push(input.minDepth);
    }
    if (input.maxDepth != null) {
      where.push("depth <= ?");
      args.push(input.maxDepth);
    }
    return this.sql.exec(
      `SELECT * FROM parsed_structures WHERE ${where.join(" AND ")} ORDER BY start_row, depth`,
      ...args,
    ).toArray() as JsonRecord[];
  }

  findParsedByName(name: string, input: { nodeType?: string | null; filePath?: string | null } = {}): JsonRecord[] {
    this.ensureReady();
    const where = ["node_name = ?"];
    const args: unknown[] = [name];
    if (input.nodeType) {
      where.push("node_type = ?");
      args.push(input.nodeType);
    }
    if (input.filePath) {
      where.push("file_path = ?");
      args.push(input.filePath);
    }
    return this.sql.exec(
      `SELECT * FROM parsed_structures WHERE ${where.join(" AND ")} ORDER BY file_path, start_row`,
      ...args,
    ).toArray() as JsonRecord[];
  }

  getStructuresInRange(fileHash: string, startLine: number, endLine: number): JsonRecord[] {
    this.ensureReady();
    return this.sql.exec(
      `SELECT * FROM parsed_structures
       WHERE file_content_hash = ? AND start_row <= ? AND end_row >= ?
       ORDER BY depth, start_row`,
      fileHash,
      endLine,
      startLine,
    ).toArray() as JsonRecord[];
  }

  getSupportedLanguages(): string[] {
    return [...new Set(Object.values(LANGUAGE_BY_EXT))];
  }

  async indexTurn(turnId: number): Promise<JsonRecord | null> {
    this.ensureReady();
    const turn = this.sql.exec(`SELECT * FROM conversation_turns WHERE id = ?`, turnId).toArray()[0] as JsonRecord | undefined;
    if (!turn) return null;
    const content = String(turn["content"] ?? "").trim();
    if (!content) return null;
    const chunk = await this.createChunk({
      content: content.length > 1000 ? `${content.slice(0, 997)}...` : content,
      topicLabel: `${turn["role"]} turn ${turn["turn_index"]}`,
      attribution: "conversation_turn",
      sourceSessionId: String(turn["session_id"]),
      sourceTurnId: turnId,
    });
    const plan = this.extractPlanCandidate(content);
    const sourcePath = `turn:${turnId}`;
    const existingPlan = this.sql.exec(`SELECT id FROM plans WHERE source_path = ?`, sourcePath).toArray()[0] as JsonRecord | undefined;
    if (plan && !existingPlan) {
      const row = await this.recordPlan({
        content: plan.content,
        title: plan.title,
        sessionId: String(turn["session_id"]),
        sourcePath,
      });
      this.relateChunk(String(chunk["content_hash"]), "plan", String(row["id"]));
    }
    return chunk;
  }

  private extractPlanCandidate(content: string): { title: string; content: string } | null {
    const lines = content.split(/\r?\n/u);
    const actionable = lines
      .map((line) => line.trim())
      .filter((line) => /^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)(.{8,})/u.test(line))
      .slice(0, 30);
    const hasPlanSignal = /\b(?:plan|todo|steps?|implement|fix|change|port|refactor)\b/iu.test(content);
    if (!hasPlanSignal || actionable.length < 2) return null;
    const heading = lines.find((line) => /^\s{0,3}#{1,3}\s+\S/u.test(line))
      ?.replace(/^\s{0,3}#{1,3}\s+/u, "")
      .trim();
    const title = heading ?? actionable[0]!.replace(/^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u, "").slice(0, 120);
    return { title, content: actionable.join("\n") };
  }

  async indexFileVersion(input: { path: string; contentHash: string; content: string }): Promise<{ structures: JsonRecord[]; chunk: JsonRecord }> {
    this.ensureReady();
    const structures = await this.parseFileVersion({
      filePath: input.path,
      contentHash: input.contentHash,
      content: input.content,
    });
    const names = structures.map((row) => row["node_name"]).filter(Boolean).slice(0, 20).join(", ");
    const chunk = await this.createChunk({
      content: `File ${input.path}${names ? ` defines ${names}` : " was indexed"}.`,
      topicLabel: `File ${input.path}`,
      attribution: "file_index",
      relations: [
        { targetType: "blob", targetHash: input.contentHash },
        ...structures.slice(0, 50).map((row) => ({ targetType: "parsed_structure", targetHash: String(row["content_hash"]) })),
      ],
    });
    return { structures, chunk };
  }

  async indexSession(sessionId: string): Promise<{ turnsIndexed: number; fileVersionsIndexed: number }> {
    this.ensureReady();
    let turnsIndexed = 0;
    let fileVersionsIndexed = 0;
    for (const row of this.sql.exec(`SELECT id FROM conversation_turns WHERE session_id = ?`, sessionId).toArray() as JsonRecord[]) {
      if (await this.indexTurn(asNumber(row["id"]))) turnsIndexed++;
    }
    for (const row of this.sql.exec(`SELECT path, content_hash FROM file_versions WHERE session_id = ?`, sessionId).toArray() as JsonRecord[]) {
      await this.createChunk({
        content: `File version ${row["path"]} recorded in session ${sessionId}.`,
        topicLabel: `File version ${row["path"]}`,
        attribution: "file_version",
        sourceSessionId: sessionId,
        relations: [{ targetType: "blob", targetHash: String(row["content_hash"]) }],
      });
      fileVersionsIndexed++;
    }
    return { turnsIndexed, fileVersionsIndexed };
  }

  getReviewContext(input: { filePath?: string | null; sessionId?: string | null; branchId?: string | null; limit?: number }): JsonRecord {
    this.ensureReady();
    const limit = input.limit ?? 50;
    const result: JsonRecord = {};
    if (input.sessionId) {
      result["turns"] = this.sql.exec(
        `SELECT id, turn_index, role, SUBSTR(content, 1, 1200) AS preview, timestamp
         FROM conversation_turns WHERE session_id = ? ORDER BY turn_index LIMIT ?`,
        input.sessionId,
        limit,
      ).toArray();
      result["toolCalls"] = this.sql.exec(
        `SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id LIMIT ?`,
        input.sessionId,
        limit,
      ).toArray();
      result["plans"] = this.sql.exec(
        `SELECT * FROM plans WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
        input.sessionId,
        limit,
      ).toArray();
    }
    if (input.filePath) {
      result["mutations"] = this.sql.exec(
        `SELECT tcm.*, tc.session_id, tc.turn_id, tc.started_at
         FROM tool_call_mutations tcm JOIN tool_calls tc ON tc.id = tcm.tool_call_id
         WHERE tcm.file_path = ? ORDER BY tc.started_at DESC LIMIT ?`,
        input.filePath,
        limit,
      ).toArray();
      result["versions"] = this.sql.exec(
        `SELECT * FROM file_versions WHERE path = ? ORDER BY recorded_at DESC LIMIT ?`,
        input.filePath,
        limit,
      ).toArray();
    }
    if (input.branchId) {
      result["branch"] = this.getBranch(input.branchId);
      result["branchFiles"] = this.sql.exec(
        `SELECT * FROM branch_files WHERE branch_id = ? ORDER BY updated_at DESC LIMIT ?`,
        input.branchId,
        limit,
      ).toArray();
      result["snapshots"] = this.listBranchSnapshots(input.branchId);
    }
    return result;
  }

  setBlobPolicy(input: {
    hash: string;
    retentionClass?: string | null;
    privacyLevel?: string | null;
    expiresAt?: string | null;
    redactionReason?: string | null;
  }): JsonRecord {
    this.ensureReady();
    this.sql.exec(
      `INSERT INTO blob_policies (hash, retention_class, privacy_level, expires_at, redaction_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET
         retention_class = excluded.retention_class,
         privacy_level = excluded.privacy_level,
         expires_at = excluded.expires_at,
         redaction_reason = excluded.redaction_reason,
         updated_at = excluded.updated_at`,
      input.hash,
      input.retentionClass ?? "workspace",
      input.privacyLevel ?? "normal",
      input.expiresAt ?? null,
      input.redactionReason ?? null,
      nowIso(),
    );
    return this.sql.exec(`SELECT * FROM blob_policies WHERE hash = ?`, input.hash).one() as JsonRecord;
  }

  redactBlob(hash: string, reason?: string | null): JsonRecord {
    this.ensureReady();
    this.setBlobPolicy({ hash, retentionClass: "redacted", privacyLevel: "redacted", redactionReason: reason ?? null });
    this.sql.exec(
      `UPDATE blob_policies SET redacted_at = ?, redaction_reason = COALESCE(?, redaction_reason) WHERE hash = ?`,
      nowIso(),
      reason ?? null,
      hash,
    );
    return this.sql.exec(`SELECT * FROM blob_policies WHERE hash = ?`, hash).one() as JsonRecord;
  }

  getBlobPolicy(hash: string): JsonRecord | null {
    this.ensureReady();
    const rows = this.sql.exec(`SELECT * FROM blob_policies WHERE hash = ?`, hash).toArray() as JsonRecord[];
    return rows[0] ?? null;
  }

  listBlobReferences(input: { includeUnreferenced?: boolean } = {}): JsonRecord[] {
    this.ensureReady();
    const referencedSql = `
      SELECT content_hash AS hash, 'file_versions' AS source FROM file_versions
      UNION SELECT current_hash AS hash, 'tracked_files' FROM tracked_files WHERE current_hash IS NOT NULL
      UNION SELECT current_hash AS hash, 'branch_files' FROM branch_files WHERE current_hash IS NOT NULL
      UNION SELECT before_hash AS hash, 'tool_call_mutations' FROM tool_call_mutations WHERE before_hash IS NOT NULL
      UNION SELECT after_hash AS hash, 'tool_call_mutations' FROM tool_call_mutations WHERE after_hash IS NOT NULL
      UNION SELECT content_hash AS hash, 'tool_call_reads' FROM tool_call_reads
      UNION SELECT source_blob_hash AS hash, 'tool_call_reads' FROM tool_call_reads WHERE source_blob_hash IS NOT NULL
      UNION SELECT content_hash AS hash, 'plans' FROM plans
      UNION SELECT content_hash AS hash, 'semantic_chunks' FROM semantic_chunks
    `;
    if (!input.includeUnreferenced) {
      return this.sql.exec(referencedSql).toArray() as JsonRecord[];
    }
    return this.sql.exec(`
      WITH refs AS (${referencedSql})
      SELECT b.hash, b.size, b.mime_type, p.retention_class, p.privacy_level, p.expires_at,
             CASE WHEN r.hash IS NULL THEN 0 ELSE 1 END AS referenced
      FROM blobs b
      LEFT JOIN (SELECT DISTINCT hash FROM refs) r ON r.hash = b.hash
      LEFT JOIN blob_policies p ON p.hash = b.hash
      ORDER BY referenced, b.created_at DESC
    `).toArray() as JsonRecord[];
  }

  getStatus(): { metric: string; value: number }[] {
    this.ensureReady();
    const count = (table: string) => asNumber(this.sql.exec(`SELECT COUNT(*) AS value FROM ${table}`).one()["value"]);
    return [
      { metric: "Tracked files", value: count("tracked_files") },
      { metric: "File versions", value: count("file_versions") },
      { metric: "Sessions", value: count("sessions") },
      { metric: "Conversation turns", value: count("conversation_turns") },
      { metric: "Tool calls", value: count("tool_calls") },
      { metric: "Semantic chunks", value: count("semantic_chunks") },
      { metric: "Parsed structures", value: count("parsed_structures") },
      { metric: "Plans", value: count("plans") },
      { metric: "Branches", value: count("branches") },
    ];
  }

  private nextTurnIndex(sessionId: string): number {
    const row = this.sql.exec(
      `SELECT COALESCE(MAX(turn_index) + 1, 0) AS next FROM conversation_turns WHERE session_id = ?`,
      sessionId,
    ).one();
    return asNumber(row["next"]);
  }
}

export default {
  async fetch(_request: Request) {
    return new Response("gad workspace durable-object service", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
