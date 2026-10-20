import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard for the process-ownership design. Every detached process group
 * is started through the ownership library (`Ownership.spawn`, `spawnDetached`,
 * `adopt`), whose reaper retires it however its owner ends. A raw
 * `detached: true` anywhere else is an unowned group, and the mechanisms the
 * library replaced must not return.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const SCANNED_ROOTS = ["src", "hosts", "scripts", "packages", "services", "tests/setup"];
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "dist-publish",
  "templates",
  ".cache",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".cjs", ".js"]);

/** The library itself is the one place that may write `detached: true`. */
const LIBRARY_FILE = /^packages\/shared\/src\/(ownership[A-Za-z]*|reaper)\.(mjs|d\.mts|test\.ts)$/u;

/**
 * Files that may carry an `// ownership-exempt(<reason>)` marker. Each is a
 * process that must NOT be owned by its starter, or guest code under test. A
 * new entry needs the same justification as these.
 */
const EXEMPT_FILES: Readonly<Record<string, string>> = {
  "hosts/terminal/localServer.ts":
    "until-stop survivor: the retained local server outlives the CLI",
  "src/node/openExternalBrowser.ts": "external-application: the user's browser outlives Vibestudio",
  "src/node/openExternalBrowser.test.ts": "external-application: asserts that launcher's contract",
  "packages/process-adapter/src/isolation/workspace.integration.test.ts":
    "sandbox-guest: guest code under test, contained by the sandbox",
  "scripts/isolation-feasibility/guest.cjs":
    "sandbox-guest: guest code under test, contained by the sandbox",
};

const RAW_DETACHED = /\bdetached\s*:\s*(true\b|process\.platform|platform\b|!)/u;
const RAW_GROUP_KILL = /\bprocess\.kill\(\s*-/u;
const EXEMPT_MARKER = /ownership-exempt\(([^)]+)\)/u;
/** How far above a raw `detached` its marker may sit (a comment block). */
const MARKER_WINDOW = 6;

/** Modules and mechanisms the ownership library replaced. */
const REMOVED = [
  /owned-process-tree/u,
  /owned-process-identity/u,
  /ownedProcessRegistration/u,
  /\bOwnedProcessGroup\b/u,
  /shared\/ownedProcessGroup/u,
  /development-client-lifecycle/u,
  /parent-owned-(main|command|stop)/u,
  /\bforwardTerminationSignals\b/u,
  /\bterminateOwnedProcessTree\b/u,
  /\bbindProcessLifetimeToParent\b/u,
  /\bforwardParentSignals\b/u,
  /\brunParentOwnedMain\b/u,
  /\bworkspaceChildOwners\b/u,
  /\bwaitForStopped\b/u,
  /\breclaimStaleManagedInstance\b/u,
  /dev\/terminationSignals/u,
  /\.\/terminationSignals/u,
] as const;

const THIS_FILE = "tests/ownership-guard.test.ts";

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of fs.readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* sourceFiles(relative);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield relative;
    }
  }
}

const files = SCANNED_ROOTS.filter((root) => fs.existsSync(path.join(repoRoot, root))).flatMap(
  (root) => [...sourceFiles(root)]
);
const sources = new Map(
  files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), "utf8")])
);

function findings(pattern: RegExp, allowed: (file: string) => boolean): string[] {
  const found: string[] = [];
  for (const [file, source] of sources) {
    if (file === THIS_FILE || allowed(file)) continue;
    source.split("\n").forEach((line, index) => {
      if (pattern.test(line)) found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe("process ownership guard", () => {
  it("scans the repository's source", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(sources.has("packages/shared/src/ownership.mjs")).toBe(true);
    expect(sources.has("src/dev/runSystemTest.ts")).toBe(true);
  });

  it("starts no detached process group outside the ownership library or a marked exemption", () => {
    const unowned: string[] = [];
    for (const [file, source] of sources) {
      if (file === THIS_FILE || LIBRARY_FILE.test(file)) continue;
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        if (!RAW_DETACHED.test(line)) return;
        const window = lines.slice(Math.max(0, index - MARKER_WINDOW), index + 1).join("\n");
        const reason = EXEMPT_MARKER.exec(window)?.[1]?.trim();
        if (reason && file in EXEMPT_FILES) return;
        unowned.push(
          `${file}:${index + 1}: ${line.trim()}${
            reason ? ` (marker ${reason} in a file that is not in EXEMPT_FILES)` : ""
          }`
        );
      });
    }
    expect(unowned, "raw `detached` group outside the ownership library").toEqual([]);
  });

  it("keeps every exemption real: each exempt file still has a marked raw detached", () => {
    for (const file of Object.keys(EXEMPT_FILES)) {
      const source = sources.get(file);
      expect(source, `${file} exists`).toBeDefined();
      expect(RAW_DETACHED.test(source!), `${file} still needs its exemption`).toBe(true);
      expect(EXEMPT_MARKER.test(source!), `${file} marks its exemption`).toBe(true);
    }
  });

  it("signals no process group by raw negative pid outside the library", () => {
    expect(
      findings(
        RAW_GROUP_KILL,
        (file) =>
          LIBRARY_FILE.test(file) ||
          file === "packages/shared/src/ownedProcessIdentity.mjs" ||
          // Tests observe and clean up their own fixtures' groups.
          /\.test\.[cm]?[jt]sx?$/u.test(file)
      )
    ).toEqual([]);
  });

  it("does not import or mention a removed ownership mechanism", () => {
    const offenders = REMOVED.flatMap((pattern) => findings(pattern, () => false));
    expect(offenders).toEqual([]);
  });
});
