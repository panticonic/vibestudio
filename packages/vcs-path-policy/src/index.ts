/** Stable filename written beside every materialized workspace context. */
export const CONTEXT_BINDING_FILE = ".vibestudio-context.json";

export const SEMANTIC_VCS_MAX_PATH_UTF8_BYTES = 512;
export const SEMANTIC_VCS_MAX_PATH_SEGMENT_UTF8_BYTES = 255;
/** One snapshot descriptor is admitted and persisted atomically. */
export const VCS_ATOMIC_IMPORT_MAX_DESCRIPTOR_BYTES = 512 * 1024;

const RESERVED_DIRECTORIES: ReadonlySet<string> = new Set([".git", ".gad"]);
const RESERVED_FILES: ReadonlySet<string> = new Set([
  ".env",
  ".npmrc",
  ".secrets.yml",
  "firebase-service-account.json",
  CONTEXT_BINDING_FILE,
]);

export type SemanticVcsPathAdmission =
  | { admissible: true }
  | {
      admissible: false;
      reason: "unsafe" | "too-long" | "platform-reserved";
      message: string;
    };

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

/**
 * The single runtime-neutral repository-relative path admission policy used by
 * semantic ingress, Git snapshots, projection scanning, and materialization.
 */
export function semanticVcsPathAdmission(path: string): SemanticVcsPathAdmission {
  if (path.length === 0) {
    return {
      admissible: false,
      reason: "unsafe",
      message: "semantic VCS path is empty; a path must name a file inside a repository",
    };
  }
  if (
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.includes("\\")
  ) {
    return {
      admissible: false,
      reason: "unsafe",
      message: `semantic VCS path escapes its repository: ${JSON.stringify(path)}`,
    };
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return {
      admissible: false,
      reason: "unsafe",
      message: `semantic VCS path is not canonical: ${JSON.stringify(path)}`,
    };
  }
  const oversizedSegment = segments.find(
    (segment) => utf8Length(segment) > SEMANTIC_VCS_MAX_PATH_SEGMENT_UTF8_BYTES
  );
  if (oversizedSegment !== undefined) {
    return {
      admissible: false,
      reason: "too-long",
      message:
        `semantic VCS path component is ${utf8Length(oversizedSegment)} UTF-8 bytes; maximum is ` +
        SEMANTIC_VCS_MAX_PATH_SEGMENT_UTF8_BYTES,
    };
  }
  const byteLength = utf8Length(path);
  if (byteLength > SEMANTIC_VCS_MAX_PATH_UTF8_BYTES) {
    return {
      admissible: false,
      reason: "too-long",
      message:
        `semantic VCS path is ${byteLength} UTF-8 bytes; maximum is ` +
        SEMANTIC_VCS_MAX_PATH_UTF8_BYTES,
    };
  }
  if (segments.some((segment) => RESERVED_DIRECTORIES.has(segment))) {
    return {
      admissible: false,
      reason: "platform-reserved",
      message: `semantic VCS path enters a platform-reserved directory: ${JSON.stringify(path)}`,
    };
  }
  const basename = segments.at(-1) ?? "";
  if (RESERVED_FILES.has(basename)) {
    return {
      admissible: false,
      reason: "platform-reserved",
      message: `semantic VCS path names a platform-reserved file: ${JSON.stringify(path)}`,
    };
  }
  return { admissible: true };
}

export function assertSemanticVcsPathAdmissible(path: string): void {
  const admission = semanticVcsPathAdmission(path);
  if (!admission.admissible) throw new Error(admission.message);
}
