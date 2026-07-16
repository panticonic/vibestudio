/**
 * The one semantic workspace file-path admission policy.
 *
 * This module is deliberately pure and runtime-neutral. Semantic command
 * ingress, external snapshot adapters, filesystem scanners, and the host
 * materialization sink all call this same predicate. A path therefore cannot
 * be accepted by one side of the semantic/host boundary and silently ignored
 * or rejected by the other.
 */

import { CONTEXT_BINDING_FILE } from "../contextBinding.js";

/**
 * Keeps every coordinate comfortably below filesystem and Durable Object row
 * limits. The bound is UTF-8 bytes, not JavaScript code units.
 */
export const SEMANTIC_VCS_MAX_PATH_UTF8_BYTES = 512;
export const SEMANTIC_VCS_MAX_PATH_SEGMENT_UTF8_BYTES = 255;

/** Names which collide with metadata written inside every materialized repo. */
const RESERVED_DIRECTORIES: ReadonlySet<string> = new Set([".git", ".gad"]);

/** Host metadata and exact credential-bearing file conventions. */
const RESERVED_FILES: ReadonlySet<string> = new Set([
  // Exact names automatically consumed by common project tooling. Unlike
  // `.env.example` or `.npmrc.example`, these may carry live credentials and
  // can influence host-side builds merely by being materialized.
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

const reservedFileName = (segment: string): boolean => RESERVED_FILES.has(segment);

/**
 * Classify one repository-relative semantic file path.
 *
 * Ordinary project names such as `dist/`, `out/`, `release/`, `coverage/`,
 * `node_modules/`, `.cache/`, archives, logs, and environment templates are
 * intentionally admissible. Vibestudio does not turn conventions into semantic
 * facts. Only paths that collide with materializer metadata and exact
 * credential-bearing filenames are reserved.
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
  if (reservedFileName(basename)) {
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
