#!/usr/bin/env node
// Single-user regression guard (WP10 §6, decision 3).
//
// The multi-user cutover DELETED the single-user scaffolding — this checker
// keeps it deleted. It greps host + userland source and current operator docs
// for the specific vestiges the cutover removed and fails if any
// regresses back in:
//
//   - "single-user" assertions/justifications (e.g. the old "whole-file
//     last-writer-wins is accepted for this single-user product" comment).
//   - The two-port vestige: `panelPort` / `--panel-port` and
//     `PanelHttpServer.setPort` (panels serve through the single gateway socket).
//   - Hardcoded identities: the "@user" handle, the "Chat Panel" display title,
//     and the fixed git author `panel@vibestudio.local` (commits are authored
//     by the acting user, WP9 §7).
//   - Machine-wide FCM `sendBatch(...)` (push routes per user, WP4 §4.2/§4.3).
//   - JSON identity stores (`devices.json` / `memberships.json` / `users.json`)
//     as sources of truth — identity is ONE hub-owned SQLite DB at
//     `server-auth/identity.db` (WP0 §2/§7).
//
// Historical mentions that DESCRIBE the removal (comments explaining why the
// legacy is gone) are covered by the inline allowlist below — each entry names
// the file, a matching substring, and a reason. Everything else is a violation.
//
// Companion to scripts/check-host-workspace-imports.mjs; wired into
// `pnpm quality:check` as `check:no-single-user`. Dependency-free.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = process.cwd();

const SCANNED_ROOTS = ["src", "packages", "apps", "scripts", "skills", "workspace"];
const SCANNED_FILES = [
  "build.mjs",
  "README.md",
  "STATE_DIRECTORY.md",
  "docs/cli.md",
  "docs/routes.md",
  "docs/trusted-workspace-units.md",
  "docs/webrtc-deployment.md",
  "docs/webrtc-local-e2e.md",
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", "dist-packages", "dist-publish", ".git"]);

// This checker (and the smoke ladder that names the scenarios) describe the
// vestiges; scanning them only produces self-referential noise.
const SELF_FILES = new Set(["scripts/check-no-single-user.mjs", "scripts/full-system-smoke.mjs"]);

/** Same test-context heuristic as the host-boundary checker. */
export function isTestContext(relFile) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relFile) ||
    /(^|\/)(tests|__tests__|__fixtures__|fixtures)\//.test(relFile)
  );
}

/**
 * Guard rules. `pattern` runs per line; `includeTests` opts a rule into test
 * files (tests routinely quote legacy names while asserting their removal, so
 * most rules skip them). Optional `files` restricts a rule to matching paths.
 */
export const RULES = [
  {
    id: "single-user-assertion",
    pattern: /single[-_ .]user/i,
    message:
      'no "single-user" assertion may remain in host source (WP10 §6) — the product is multi-user',
    includeTests: false,
  },
  {
    id: "panel-port-vestige",
    pattern: /\bpanelPort\b|--panel-port/,
    message:
      "the two-port vestige is deleted (WP10 §3) — panels serve through the single gateway socket",
    includeTests: true,
  },
  {
    id: "panel-http-set-port",
    pattern: /\bsetPort\s*\(/,
    message: "PanelHttpServer.setPort was deleted with the two-port vestige (WP10 §3)",
    includeTests: true,
    files: /panelHttpServer/,
  },
  {
    id: "hardcoded-git-author",
    pattern: /panel@vibestudio\.local/,
    message: "commits are authored by the acting user (WP9 §7) — no hardcoded git author",
    includeTests: true,
  },
  {
    id: "hardcoded-user-handle",
    pattern: /["'`]@user["'`]/,
    message: 'the hardcoded "@user" handle is gone (WP6) — handles come from the identity DB',
    includeTests: false,
  },
  {
    id: "hardcoded-chat-panel-identity",
    pattern: /["'`]Chat Panel["'`]/,
    message: 'the hardcoded "Chat Panel" identity is gone (WP6) — surfaces are user-attributed',
    includeTests: false,
  },
  {
    id: "machine-wide-push-batch",
    pattern: /\bsendBatch\s*\(/,
    message:
      "machine-wide FCM sendBatch was retired (WP4 §4.3) — push routes to exact user/device snapshots via sendToTargets",
    includeTests: false,
  },
  {
    id: "user-wide-push-fanout",
    pattern: /\bsendToUsers\s*\(/,
    message:
      "user-wide push fan-out is retired — snapshot exact user/device registrations and use sendToTargets",
    includeTests: true,
  },
  {
    id: "json-identity-store",
    pattern: /(?:^|[^\w./-])(?:devices|memberships|users)\.json\b/,
    message:
      "JSON identity stores are gone (WP0 §2) — identity is the hub-owned SQLite server-auth/identity.db",
    includeTests: false,
  },
  {
    id: "central-data-json",
    pattern: /\bdata\.json\b/,
    message:
      "the machine-wide data.json snapshot is deleted — central workspace/runtime state is row-based SQLite",
    includeTests: false,
  },
  {
    id: "push-registration-json",
    pattern: /\bpush-registrations\.json\b/,
    message:
      "the push JSON registry is deleted — registrations are caller-owned rows in server-auth/push.db",
    includeTests: false,
  },
  {
    id: "workspace-local-server-manager",
    pattern: /\bLocalServerManager\b|\blocalServerManager\b|localServerManager\.[cm]?[jt]s/,
    message: "workspace-scoped desktop servers are deleted — desktop owns one HubProcessManager",
    includeTests: true,
  },
  {
    id: "forced-workspace-process-role",
    pattern: /\bVIBESTUDIO_FORCE_WORKSPACE_SERVER\b/,
    message:
      "the force-workspace-server process switch is deleted — the hub is the sole top-level server mode",
    includeTests: true,
  },
  {
    id: "generic-device-invite",
    pattern: /\bauth\.createPairingInvite\b|\bexchangePairingCode\b|\bremote\s+invite(?![-\w])/,
    message:
      "generic device invites are deleted — use hubControl.pairDevice or hubControl.inviteUser",
    includeTests: false,
  },
  {
    id: "deploy-time-workspace-selection",
    pattern: /\bvibestudio\s+remote\s+deploy\b.*--workspace\b/,
    message:
      "deployment starts a hub — workspace selection happens after pairing through hub control",
    includeTests: false,
  },
  {
    id: "ready-file-credential-secret",
    pattern: /\b(?:adminToken|pairingCodes?)\??\s*:/,
    message:
      "client-facing ready files are secret-free — rootInvites replaces flat pairingCode(s), and adminToken is never exposed",
    includeTests: false,
    files:
      /^(?:src\/main\/|src\/cli\/|scripts\/|workspace\/apps\/mobile\/src\/|workspace\/apps\/shell\/)/,
  },
  {
    id: "human-admin-bootstrap",
    pattern: /\/(?:_r\/s\/)?auth\/issue-device\b|\bvibestudio-admin\.mjs\b|--admin-token\b/,
    message:
      "process admin tokens cannot mint human shell identities — clients must redeem a user-bound device invite",
    includeTests: false,
  },
  {
    id: "nested-hub-credential",
    pattern: /\bhubUrl\b|\bhubCredential\b/,
    message:
      "client hubUrl/nested hub credentials are deleted — store one global device credential plus selected child reach",
    includeTests: false,
    files:
      /^(?:src\/cli\/|src\/main\/services\/(?:remoteCred|deviceCredential)|packages\/service-schemas\/src\/remoteCred|workspace\/apps\/mobile\/src\/)/,
  },
];

/**
 * Intentional mentions: comments describing the REMOVED legacy. An entry with
 * no `substring` covers every hit of that rule in the file.
 */
export const ALLOWLIST = [
  {
    rule: "single-user-assertion",
    file: "src/server/hubServer.ts",
    substring: "single-user artifact",
    reason: "historical comment explaining why the per-child auth store was deleted",
  },
  {
    rule: "json-identity-store",
    file: "src/server/hubServer.ts",
    substring: "store is gone",
    reason: "historical comment stating the per-child devices.json store is gone",
  },
  {
    rule: "single-user-assertion",
    file: "packages/shared/src/centralData.ts",
    substring: "single-user last-writer-wins",
    reason: "comment describing the retired whole-file LWW assumption",
  },
  {
    rule: "single-user-assertion",
    file: "packages/workspace-contracts/src/types.ts",
    substring: "Replaces the single-user",
    reason: "comment describing the retired machine-global lastWorkspaceTarget",
  },
  {
    rule: "hardcoded-git-author",
    file: "packages/git/src/client.ts",
    substring: "identity (WP9",
    reason: "doc comment quoting the REMOVED hardcoded author",
  },
  {
    rule: "hardcoded-git-author",
    file: "packages/git/src/client.ts",
    substring: "human is gone",
    reason: "comment stating the hardcoded author is gone",
  },
  {
    rule: "central-data-json",
    file: "packages/shared/src/centralData.ts",
    substring: "retired machine-wide",
    reason: "module comment states that the data.json snapshot has been deleted",
  },
  {
    rule: "json-identity-store",
    file: "STATE_DIRECTORY.md",
    substring: "There are **no JSON identity stores**",
    reason: "current state documentation explicitly records that the stores are absent",
  },
  {
    rule: "single-user-assertion",
    file: "workspace/apps/shell/components/LazyPanelTreeSidebar.tsx",
    substring: "silently restore the old single-user",
    reason: "invariant comment explains why owner headers may not be dropped",
  },
  {
    rule: "single-user-assertion",
    file: "workspace/apps/mobile/src/state/shellClientAtom.ts",
    substring: "never collapsed to a single-user tree",
    reason: "invariant comment documents the canonical owner-grouped forest",
  },
];

export function isAllowlisted(finding) {
  return ALLOWLIST.some(
    (entry) =>
      entry.rule === finding.rule &&
      entry.file === finding.file &&
      (entry.substring == null || finding.text.includes(entry.substring))
  );
}

/** Collect findings from one file's text. */
export function collectFindings({ text, relFile }) {
  const testContext = isTestContext(relFile);
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    if (testContext && !rule.includeTests) continue;
    if (rule.files && !rule.files.test(relFile)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) {
        findings.push({ file: relFile, line: i + 1, rule: rule.id, text: lines[i].trim() });
      }
    }
  }
  return findings;
}

function shouldSkipDir(current) {
  return IGNORED_DIRS.has(path.basename(current));
}

function* walkSourceFiles(root) {
  const stack = SCANNED_ROOTS.map((dir) => path.join(root, dir));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      if (shouldSkipDir(current)) continue;
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
      continue;
    }
    if (stat.isFile() && SOURCE_EXTENSIONS.has(path.extname(current))) yield current;
  }
  for (const file of SCANNED_FILES.map((f) => path.join(root, f))) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) yield file;
  }
}

export function scanRepository(root = DEFAULT_ROOT) {
  const findings = [];
  for (const absFile of walkSourceFiles(root)) {
    const relFile = path.relative(root, absFile).split(path.sep).join("/");
    if (SELF_FILES.has(relFile)) continue;
    const text = fs.readFileSync(absFile, "utf8");
    findings.push(...collectFindings({ text, relFile }));
  }
  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule)
  );
  return findings;
}

function check(root) {
  const findings = scanRepository(root);
  const violations = findings.filter((f) => !isAllowlisted(f));
  const allowedCount = findings.length - violations.length;

  if (violations.length === 0) {
    console.log(
      `No single-user scaffolding found (${allowedCount} historical mention(s) allowlisted).`
    );
    return 0;
  }

  console.error("Single-user scaffolding regressed (WP10 §6 guard):\n");
  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  for (const rule of RULES) {
    const group = byRule.get(rule.id);
    if (!group) continue;
    console.error(`  ${rule.id} (${group.length}): ${rule.message}`);
    for (const f of group) console.error(`    ${f.file}:${f.line}: ${f.text}`);
    console.error("");
  }
  console.error(
    `Summary: ${violations.length} violation(s) across ${byRule.size} rule(s). ` +
      `Intentional historical mentions belong in the inline ALLOWLIST of scripts/check-no-single-user.mjs.`
  );
  return 1;
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exit(check(DEFAULT_ROOT));
}
