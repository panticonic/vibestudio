import type {
  BrowserCookieRecord,
  FormFillType,
  ImportCategoryProgress,
  ImportJobPhase,
} from "../environment.js";

export interface StoredBookmark {
  id: number;
  title: string;
  url: string | null;
  folder_path: string;
  date_added: number;
  date_modified: number | null;
  position: number;
  source_id: string | null;
  import_key: string | null;
  tags: string | null;
  keyword: string | null;
}

export interface StoredHistory {
  id: number;
  url: string;
  title: string | null;
  visit_count: number;
  typed_count: number;
  first_visit: number | null;
  last_visit: number;
}

export interface StoredVisit {
  id: number;
  history_id: number;
  visit_time: number;
  transition: string;
  source: string;
  import_source_id: string;
  panel_id: string;
  title: string | null;
  typed: number;
}

export interface StoredPassword {
  id: number;
  origin_url: string;
  username: string;
  password: string;
  action_url: string;
  realm: string;
  date_created: number | null;
  date_last_used: number | null;
  date_password_changed: number | null;
  times_used: number;
}

/** Decrypted only at the trusted service boundary. */
export interface StoredCookie extends BrowserCookieRecord {
  value: string;
}

export interface StoredFormFill {
  id: number;
  type: FormFillType;
  value: string;
  displayLabel: string | null;
  aliases: string[];
  createdAt: number;
  updatedAt: number;
  useCount: number;
}

export interface StoredSearchEngine {
  id: number;
  name: string;
  keyword: string | null;
  search_url: string;
  suggest_url: string | null;
  favicon_url: string | null;
  is_default: number;
  source_id: string | null;
  import_key: string | null;
}

export interface StoredPageFavicon {
  page_url: string;
  origin: string;
  source_url: string | null;
  png16: Uint8Array | null;
  png32: Uint8Array | null;
  mime_type: "image/png";
  updated_at: number;
}

export interface StoredImportJob {
  job_id: string;
  host_id: string;
  host_label: string;
  source_id: string;
  browser: string;
  phase: ImportJobPhase;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  data_types: string;
  progress: string;
  warnings: string;
  error: string | null;
  resumable: number;
}

export interface ImportJobWrite {
  jobId: string;
  hostId: string;
  hostLabel: string;
  sourceId: string;
  browser: string;
  phase: ImportJobPhase;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  dataTypes: string[];
  progress: ImportCategoryProgress[];
  warnings: string[];
  error?: string;
  resumable: boolean;
}
