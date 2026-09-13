import { createHash } from "node:crypto";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";

export const WORKSPACE_CONFIG_DIGEST_PREFIX = "v1-sha256:" as const;

export function workspaceConfigDigest(config: WorkspaceConfig): string {
  return `${WORKSPACE_CONFIG_DIGEST_PREFIX}${createHash("sha256")
    .update(canonicalJson(config), "utf8")
    .digest("hex")}`;
}

export function changedWorkspaceConfigPaths(
  current: WorkspaceConfig,
  next: WorkspaceConfig
): string[] {
  const changed = new Set<string>();
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (left === undefined && right === undefined) return;
    if (left === undefined || right === undefined) {
      // A whole container appearing or disappearing still changed only the
      // leaves inside it. Reporting the container instead would put the first
      // write to any section outside every scope naming a path within it —
      // which is how declaring a workspace's first Git remote became
      // impossible, the section itself being absent until that moment.
      const present = asRecord(left === undefined ? right : left);
      const keys = present ? Object.keys(present).sort() : [];
      if (keys.length === 0) {
        changed.add(path);
        return;
      }
      for (const key of keys) {
        const child = path ? `${path}.${key}` : key;
        if (left === undefined) visit(undefined, present![key], child);
        else visit(present![key], undefined, child);
      }
      return;
    }
    if (canonicalJson(left) === canonicalJson(right)) return;
    const leftRecord =
      left && typeof left === "object" && !Array.isArray(left)
        ? (left as Record<string, unknown>)
        : null;
    const rightRecord =
      right && typeof right === "object" && !Array.isArray(right)
        ? (right as Record<string, unknown>)
        : null;
    if (!leftRecord || !rightRecord) {
      changed.add(path);
      return;
    }
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    if (keys.length === 0) {
      changed.add(path);
      return;
    }
    for (const key of keys) visit(leftRecord[key], rightRecord[key], path ? `${path}.${key}` : key);
  };
  visit(current, next, "");
  return [...changed].filter(Boolean).sort();
}

export function assertWorkspaceConfigPathScope(
  changedPaths: readonly string[],
  allowedPathScope: readonly string[]
): void {
  const allowed = [...new Set(allowedPathScope)].sort();
  for (const path of changedPaths) {
    if (allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) continue;
    throw new Error(`Prepared workspace-config mutation changes ${path} outside its allowed scope`);
  }
}
