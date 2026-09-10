import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Which units in a workspace are the code Vibestudio ships.
 *
 * This settles one question, and a narrow one: whose declaration a unit's
 * manifest is. Admitting a workspace-declared app normally needs a workspace
 * review, and that review is rendered by `apps/shell` — so the shell can never
 * be admitted that way, because the surface that would present the decision is
 * the thing waiting on it. A unit the host build vouches for skips that review.
 * It does NOT skip the launch gate: shipping in the build is not consent to run.
 *
 * Provenance answers it, rather than a signature. The host already pins the
 * distributions it provisions and verifies the fetched tree against that pin,
 * so "this unit arrived unmodified in the tree the host itself designated" is
 * the same assertion a vendor signature was making, rooted in something the
 * host already checks. An inventory is therefore written only for a designated
 * template: a third-party template gets none, so nothing in it can claim to
 * ship with Vibestudio however its files are arranged.
 *
 * The signature it replaces could not be produced without a release key that
 * was never provisioned, so in a packaged build no unit ever verified, the
 * shell was never admitted, and the app could not open. Its development
 * fallback was a plain hash anyone could recompute, and so proved nothing.
 */

const INVENTORY_VERSION = "vibestudio-host-build-units-v1";
const DIGEST_VERSION = "vibestudio-host-build-unit-source-v1";

/** Build outputs and checkouts are not source, and differ between machines. */
const EXCLUDED_ENTRIES = new Set([".git", "node_modules", ".cache"]);

/**
 * Where the inventory lives, relative to a workspace's state directory.
 *
 * Host state, not workspace source: a workspace cannot write its own answer to
 * whether it ships with Vibestudio.
 */
export const HOST_BUILD_UNIT_INVENTORY_FILE = "workspace-creation/host-build-units-v1.json";

export function hostBuildUnitInventoryPath(statePath: string): string {
  return path.join(statePath, ...HOST_BUILD_UNIT_INVENTORY_FILE.split("/"));
}

export interface HostBuildUnitInventory {
  version: typeof INVENTORY_VERSION;
  /** The designated template this tree came from, for diagnostics. */
  templateUrl: string;
  commit: string;
  /**
   * Set when the host designated a local checkout rather than a fetched pin.
   * A developer editing the shell is the vendor in that setup, so holding its
   * source to a digest would gate the shell on a review only the shell can
   * render — the exact deadlock this whole mechanism exists to avoid.
   */
  vouchesWholeTree?: boolean;
  /** Repo path to the digest of that unit's source as the template shipped it. */
  units: Record<string, string>;
}

export function unitSourceDigest(unitDir: string): string {
  const hash = createHash("sha256");
  hash.update(`${DIGEST_VERSION}\0`);
  for (const file of listUnitSourceFiles(unitDir)) {
    const content = fs.readFileSync(file);
    hash.update(toPosixPath(path.relative(unitDir, file)));
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Record what a designated template shipped, from its materialized tree. */
export function buildHostBuildUnitInventory(input: {
  root: string;
  unitRepoPaths: readonly string[];
  templateUrl: string;
  commit: string;
  vouchesWholeTree?: boolean;
}): HostBuildUnitInventory {
  const units: Record<string, string> = {};
  for (const repoPath of [...input.unitRepoPaths].sort()) {
    const unitDir = path.join(input.root, ...repoPath.split("/"));
    if (!fs.existsSync(unitDir)) continue;
    units[repoPath] = unitSourceDigest(unitDir);
  }
  return {
    version: INVENTORY_VERSION,
    templateUrl: input.templateUrl,
    commit: input.commit,
    ...(input.vouchesWholeTree ? { vouchesWholeTree: true } : {}),
    units,
  };
}

export function parseHostBuildUnitInventory(value: unknown): HostBuildUnitInventory | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate["version"] !== INVENTORY_VERSION) return null;
  if (typeof candidate["templateUrl"] !== "string" || typeof candidate["commit"] !== "string") {
    return null;
  }
  const units = candidate["units"];
  if (!units || typeof units !== "object" || Array.isArray(units)) return null;
  for (const digest of Object.values(units as Record<string, unknown>)) {
    if (typeof digest !== "string") return null;
  }
  return {
    version: INVENTORY_VERSION,
    templateUrl: candidate["templateUrl"],
    commit: candidate["commit"],
    ...(candidate["vouchesWholeTree"] === true ? { vouchesWholeTree: true } : {}),
    units: units as Record<string, string>,
  };
}

export function readHostBuildUnitInventory(filePath: string): HostBuildUnitInventory | null {
  try {
    return parseHostBuildUnitInventory(JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown);
  } catch {
    return null;
  }
}

/**
 * Whether this unit's source is what the designated template shipped.
 *
 * A missing inventory means the workspace was not created from a template the
 * host designates, which is the ordinary case for a workspace someone made
 * themselves; nothing in it ships with Vibestudio and that is not a problem.
 */
export function isHostBuildUnitSource(input: {
  inventory: HostBuildUnitInventory | null;
  repoPath: string;
  unitDir: string;
}): boolean {
  const inventory = input.inventory;
  if (!inventory) return false;
  if (inventory.vouchesWholeTree) return true;
  const recorded = inventory.units[normalizeUnitRepoPath(input.repoPath)];
  if (!recorded) return false;
  return recorded === unitSourceDigest(input.unitDir);
}

export function normalizeUnitRepoPath(repoPath: string): string {
  return repoPath
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .replace(/^workspace\//u, "")
    .replace(/\/+$/u, "");
}

function listUnitSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_ENTRIES.has(entry.name)) continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  visit(root);
  return files.sort((left, right) => toPosixPath(left).localeCompare(toPosixPath(right)));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * The host-build gate both unit hosts share.
 *
 * The inventory is read once. It is written while the root template is
 * materialized, before any unit host starts, and it lives in host state rather
 * than workspace source, so nothing a workspace does can change the answer
 * mid-run.
 */
export function createHostBuildUnitGate(input: {
  statePath: string;
  workspacePath: string;
  warn?: (message: string) => void;
}): (repoPath: string) => boolean {
  let inventory: HostBuildUnitInventory | null | undefined;
  const reported = new Set<string>();
  return (repoPath) => {
    if (inventory === undefined) {
      inventory = readHostBuildUnitInventory(hostBuildUnitInventoryPath(input.statePath));
    }
    const normalized = normalizeUnitRepoPath(repoPath);
    const unitDir = path.join(input.workspacePath, ...normalized.split("/"));
    if (isHostBuildUnitSource({ inventory, repoPath: normalized, unitDir })) return true;
    // Quiet about a unit the template never shipped — most units are a
    // workspace's own source and that is the ordinary case. Loud, once, about
    // one it did ship whose bytes have since changed, because the consequence
    // is otherwise invisible: the unit stops being admitted, so anything gated
    // on its admission never starts, and for the shell that means no window.
    if (inventory?.units[normalized] && !reported.has(normalized)) {
      reported.add(normalized);
      (input.warn ?? ((message: string) => console.warn(message)))(
        `[HostBuildUnits] ${normalized} no longer matches the source its template shipped, ` +
          `so it is not admitted as a host-build unit.`
      );
    }
    return false;
  };
}
