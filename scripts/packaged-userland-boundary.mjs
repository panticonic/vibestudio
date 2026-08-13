import * as fs from "node:fs";
import * as path from "node:path";

// These are external-Base projection roots. A packaged host may carry its own
// `packages/` sources and generated host artifacts, but it must never contain
// an in-tree semantic workspace or one of the unambiguous Base roots below.
const FORBIDDEN_TOP_LEVEL = new Set([
  "about",
  "apps",
  "extensions",
  "meta",
  "panels",
  "projects",
  "skills",
  "templates",
  "types",
  "workers",
  "workspace",
]);

function normalizeEntry(entry) {
  return entry.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

export function assertNoBundledUserlandPaths(entries, label) {
  const violations = [...entries]
    .map(normalizeEntry)
    .filter(Boolean)
    .filter((entry) => FORBIDDEN_TOP_LEVEL.has(entry.split("/", 1)[0]))
    .sort();
  if (violations.length > 0) {
    throw new Error(
      `${label} contains bundled workspace/Base source: ${violations.slice(0, 20).join(", ")}`
    );
  }
}

export function listRelativeTree(root) {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      entries.push(path.relative(root, absolute));
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return entries;
}

export function assertNoBundledUserlandSource(root, label = root) {
  assertNoBundledUserlandPaths(listRelativeTree(root), label);
}
