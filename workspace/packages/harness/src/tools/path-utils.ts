/**
 * Path resolution helpers used by every file tool.
 *
 * Ported from pi-coding-agent's `dist/core/tools/path-utils.js`. Pure logic
 * (no fs / os calls); the macOS-screenshot fallbacks that depended on
 * `accessSync` are gone — workerd has no synchronous fs and the per-context
 * filesystems we operate on don't host macOS screenshots, so the simple
 * `resolveToCwd` path is sufficient. `resolveReadPath` is kept as an alias
 * so the read tool can keep its existing call site.
 */

import { isAbsolute, relative, resolve as resolvePath } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function normalizeVirtualWorkspaceAlias(filePath: string): string {
  if (filePath === "workspace" || filePath === "/workspace") return ".";
  if (filePath.startsWith("workspace/")) return filePath.slice("workspace/".length);
  if (filePath.startsWith("/workspace/")) return filePath.slice("/workspace/".length);
  return filePath;
}

/**
 * Expand `~` and `~/` to a synthetic home directory and normalise unicode
 * whitespace. workerd has no `os.homedir()`, so we treat `~` as a marker
 * that callers can later remap if they need a literal home; for the
 * per-context fs the contextFolderPath is already absolute.
 */
export function expandPath(filePath: string): string {
  const normalized = normalizeVirtualWorkspaceAlias(
    normalizeUnicodeSpaces(normalizeAtPrefix(filePath))
  );
  // Workerd has no os.homedir(); leave ~ alone — callers using per-context
  // sandbox roots never produce these paths anyway.
  return normalized;
}

/**
 * Resolve `filePath` relative to `cwd`. If already absolute (after `~`
 * expansion), returns it unchanged.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) {
    // Agent file tools expose a virtual workspace filesystem, not the host
    // filesystem. Treat conventional absolute-looking paths as virtual-root
    // paths. `/workspace` is a common model/user spelling for that root; the
    // canonical tool spelling remains `.`. Preserve already-resolved paths
    // beneath cwd because internal callers may pass those back to us.
    const withinCwd = relative(cwd, expanded);
    if (withinCwd === "" || (!withinCwd.startsWith("..") && !isAbsolute(withinCwd))) {
      return expanded;
    }
    const virtual = expanded.slice(1);
    return resolvePath(cwd, virtual || ".");
  }
  return resolvePath(cwd, expanded);
}

/**
 * Resolve a path for the read tool. Identical to `resolveToCwd` in the
 * workerd port — the upstream macOS variants depended on `accessSync`,
 * which we don't have.
 */
export function resolveReadPath(filePath: string, cwd: string): string {
  return resolveToCwd(filePath, cwd);
}
