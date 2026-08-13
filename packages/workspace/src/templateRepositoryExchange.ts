import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalTemplateYaml,
  parseTemplateManifestContent,
  rootRuntimeFromTemplateManifest,
  validateTemplateSnapshotInventory,
} from "@vibestudio/workspace/templateManifest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

export type ExchangeDirection = "export" | "import";

export interface TemplateExchangeArguments {
  workspace: string;
  checkout: string;
  direction: ExchangeDirection;
  apply: boolean;
  operationId: string | null;
}

interface FileValue {
  bytes: Buffer;
  mode: number;
  digest: string;
}

interface BaselineEntry {
  path: string;
  digest: string;
  mode: number;
}

interface BaselineManifest {
  format: "vibestudio-template-exchange-baseline/1";
  entries: BaselineEntry[];
  digest: string;
}

export interface ExchangePathResult {
  path: string;
  status: "equal" | "update" | "delete" | "target-changed" | "conflict";
  baseline: string | null;
  source: string | null;
  target: string | null;
}

export interface TemplateExchangePlan {
  format: "vibestudio-template-exchange-plan/1";
  direction: ExchangeDirection;
  workspace: string;
  checkout: string;
  source: string;
  target: string;
  manifestDigest: string;
  baselineDigest: string | null;
  projection: string[];
  paths: ExchangePathResult[];
  conflicts: string[];
  untouched: string[];
  operationId: string;
}

export interface ExchangeReceipt {
  format: "vibestudio-template-exchange-receipt/1";
  operationId: string;
  direction: ExchangeDirection;
  manifestDigest: string;
  baselineBefore: string | null;
  baselineAfter: string;
  written: Array<{ path: string; digest: string; mode: number }>;
  deleted: string[];
  preserved: string[];
  completedAt: string;
}

export interface PendingTemplateExchange {
  baseline: Array<{ path: string; bytes: Buffer; mode: number; digest: string }>;
  written: ExchangeReceipt["written"];
  deleted: string[];
  preserved: string[];
}

const EXCHANGE_DIR = "vibestudio/template-exchange";

export function parseTemplateExchangeArguments(argv: readonly string[]): TemplateExchangeArguments {
  let workspace: string | undefined;
  let checkout: string | undefined;
  let direction: ExchangeDirection | undefined;
  let apply = false;
  let operationId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace") workspace = argv[++index];
    else if (argument === "--checkout") checkout = argv[++index];
    else if (argument === "--direction") {
      const value = argv[++index];
      if (value !== "export" && value !== "import") {
        throw new Error("--direction must be export or import");
      }
      direction = value;
    } else if (argument === "--apply") apply = true;
    else if (argument === "--operation-id") operationId = argv[++index];
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!workspace || !checkout || !direction) {
    throw new Error(
      "Usage: project-template-repository --workspace DIR --checkout GIT_DIR --direction export|import [--apply --operation-id SHA256]"
    );
  }
  if (operationId !== undefined && !/^[a-f0-9]{64}$/u.test(operationId)) {
    throw new Error("--operation-id must be a lowercase SHA-256 digest");
  }
  if (apply !== (operationId !== undefined)) {
    throw new Error("--apply and --operation-id must be provided together");
  }
  return {
    workspace: path.resolve(workspace),
    checkout: path.resolve(checkout),
    direction,
    apply,
    operationId: operationId ?? null,
  };
}

function walkFiles(root: string, relative = ""): string[] {
  if (!fs.existsSync(path.join(root, relative))) return [];
  return fs
    .readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name === ".git") return [];
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walkFiles(root, child) : [child];
    })
    .sort();
}

function assertRoots(workspace: string, checkout: string): void {
  if (
    workspace === checkout ||
    checkout.startsWith(`${workspace}${path.sep}`) ||
    workspace.startsWith(`${checkout}${path.sep}`)
  ) {
    throw new Error("Template workspace and checkout must be separate trees");
  }
  const git = path.join(checkout, ".git");
  if (!fs.statSync(checkout).isDirectory() || !fs.existsSync(git)) {
    throw new Error(`Template checkout is not a Git checkout: ${checkout}`);
  }
}

function gitDirectory(checkout: string): string {
  const marker = path.join(checkout, ".git");
  const stat = fs.statSync(marker);
  if (stat.isDirectory()) return marker;
  const content = fs.readFileSync(marker, "utf8").trim();
  const match = /^gitdir: (.+)$/u.exec(content);
  if (!match) throw new Error(`Invalid Git checkout marker: ${marker}`);
  return path.resolve(checkout, match[1]!);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readValue(root: string, relative: string): FileValue | null {
  const absolute = path.join(root, ...relative.split("/"));
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Template projection contains a non-regular file: ${relative}`);
    }
    const bytes = fs.readFileSync(absolute);
    return { bytes, mode: stat.mode & 0o777, digest: digest(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function same(left: FileValue | null, right: FileValue | null): boolean {
  return left?.digest === right?.digest && left?.mode === right?.mode;
}

function projection(root: string): {
  files: string[];
  manifestDigest: string;
  flattenedRoot: boolean;
} {
  const manifestPath = path.join(root, "meta/template.yml");
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = parseTemplateManifestContent(
    manifestBytes.toString("utf8"),
    WORKSPACE_SYSTEM_EPOCH
  );
  const files = walkFiles(root);
  const flattenedRoot = manifest.dependencies.length === 0;
  const projected = [
    ...new Set([
      ...files.filter(
        (file) =>
          file === "meta/template.yml" ||
          manifest.inventory.files.includes(file) ||
          manifest.inventory.repositories.some((repository) => file.startsWith(`${repository}/`))
      ),
      ...(flattenedRoot ? ["meta/vibestudio.yml"] : []),
    ]),
  ].sort();
  validateTemplateSnapshotInventory(manifest.inventory, projected);
  return { files: projected, manifestDigest: digest(manifestBytes), flattenedRoot };
}

function generatedValue(root: string, relative: string): FileValue | null {
  if (relative !== "meta/vibestudio.yml") return readValue(root, relative);
  const manifestPath = path.join(root, "meta/template.yml");
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = parseTemplateManifestContent(
    fs.readFileSync(manifestPath, "utf8"),
    WORKSPACE_SYSTEM_EPOCH
  );
  if (manifest.dependencies.length > 0) return null;
  const bytes = Buffer.from(canonicalTemplateYaml(rootRuntimeFromTemplateManifest(manifest)));
  return { bytes, mode: 0o644, digest: digest(bytes) };
}

function baselinePaths(checkout: string): {
  root: string;
  manifest: string;
  files: string;
  receipts: string;
} {
  const root = path.join(gitDirectory(checkout), EXCHANGE_DIR);
  return {
    root,
    manifest: path.join(root, "baseline.json"),
    files: path.join(root, "baseline"),
    receipts: path.join(root, "receipts"),
  };
}

function canonicalBaseline(entries: BaselineEntry[]): Omit<BaselineManifest, "digest"> {
  return { format: "vibestudio-template-exchange-baseline/1", entries };
}

function loadBaseline(checkout: string): {
  manifest: BaselineManifest | null;
  values: Map<string, FileValue>;
} {
  const locations = baselinePaths(checkout);
  if (!fs.existsSync(locations.manifest)) return { manifest: null, values: new Map() };
  const parsed = JSON.parse(fs.readFileSync(locations.manifest, "utf8")) as BaselineManifest;
  if (
    parsed.format !== "vibestudio-template-exchange-baseline/1" ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("Template exchange baseline has an invalid format");
  }
  const expected = digest(Buffer.from(JSON.stringify(canonicalBaseline(parsed.entries))));
  if (parsed.digest !== expected) throw new Error("Template exchange baseline digest is invalid");
  const values = new Map<string, FileValue>();
  for (const entry of parsed.entries) {
    const value = readValue(locations.files, entry.path);
    if (!value || value.digest !== entry.digest || value.mode !== entry.mode) {
      throw new Error(`Template exchange baseline content is invalid: ${entry.path}`);
    }
    values.set(entry.path, value);
  }
  return { manifest: parsed, values };
}

export function planTemplateRepositoryExchange(input: {
  workspace: string;
  checkout: string;
  direction: ExchangeDirection;
}): TemplateExchangePlan {
  const workspace = fs.realpathSync(path.resolve(input.workspace));
  const checkout = fs.realpathSync(path.resolve(input.checkout));
  assertRoots(workspace, checkout);
  const source = input.direction === "export" ? workspace : checkout;
  const target = input.direction === "export" ? checkout : workspace;
  const selected = projection(source);
  const baseline = loadBaseline(checkout);
  const targetProjection = fs.existsSync(path.join(target, "meta/template.yml"))
    ? projection(target).files
    : [];
  const paths = [
    ...new Set([...selected.files, ...targetProjection, ...baseline.values.keys()]),
  ].sort();
  const results: ExchangePathResult[] = paths.map((relative) => {
    const base = baseline.values.get(relative) ?? null;
    const sourceValue = selected.files.includes(relative) ? generatedValue(source, relative) : null;
    const targetValue = readValue(target, relative);
    let status: ExchangePathResult["status"];
    if (same(sourceValue, targetValue)) status = "equal";
    else if (same(targetValue, base)) status = sourceValue ? "update" : "delete";
    else if (same(sourceValue, base)) status = "target-changed";
    else status = "conflict";
    return {
      path: relative,
      status,
      baseline: base?.digest ?? null,
      source: sourceValue?.digest ?? null,
      target: targetValue?.digest ?? null,
    };
  });
  const untouched = walkFiles(target).filter((relative) => !paths.includes(relative));
  const body = {
    format: "vibestudio-template-exchange-plan/1" as const,
    direction: input.direction,
    workspace,
    checkout,
    source,
    target,
    manifestDigest: selected.manifestDigest,
    baselineDigest: baseline.manifest?.digest ?? null,
    projection: selected.files,
    paths: results,
    conflicts: results.filter((entry) => entry.status === "conflict").map((entry) => entry.path),
    untouched,
  };
  return {
    ...body,
    operationId: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}

function writeValue(root: string, relative: string, value: FileValue): void {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.vibestudio-${randomUUID()}`;
  fs.writeFileSync(temporary, value.bytes, { mode: value.mode });
  fs.chmodSync(temporary, value.mode);
  fs.renameSync(temporary, target);
}

function removeEmptyParents(root: string, relative: string): void {
  let directory = path.dirname(path.join(root, ...relative.split("/")));
  while (directory !== root && directory.startsWith(`${root}${path.sep}`)) {
    if (fs.readdirSync(directory).length > 0) break;
    fs.rmdirSync(directory);
    directory = path.dirname(directory);
  }
}

function storeBaseline(checkout: string, values: Map<string, FileValue>): BaselineManifest {
  const locations = baselinePaths(checkout);
  fs.mkdirSync(locations.root, { recursive: true });
  const staged = path.join(locations.root, `.baseline-${randomUUID()}`);
  fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
  const entries = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relative, value]) => {
      writeValue(staged, relative, value);
      return { path: relative, digest: value.digest, mode: value.mode };
    });
  const body = canonicalBaseline(entries);
  const manifest: BaselineManifest = {
    ...body,
    digest: digest(Buffer.from(JSON.stringify(body))),
  };
  const previous = `${locations.files}.previous-${randomUUID()}`;
  if (fs.existsSync(locations.files)) fs.renameSync(locations.files, previous);
  fs.renameSync(staged, locations.files);
  fs.writeFileSync(`${locations.manifest}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(`${locations.manifest}.tmp`, locations.manifest);
  if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true });
  return manifest;
}

export function prepareTemplateRepositoryExchangeTarget(
  plan: TemplateExchangePlan
): PendingTemplateExchange {
  const fresh = planTemplateRepositoryExchange(plan);
  if (fresh.operationId !== plan.operationId) {
    throw new Error("Template exchange inputs changed after review; generate a new plan");
  }
  if (plan.conflicts.length > 0) {
    throw new Error(`Template exchange has conflicts: ${plan.conflicts.join(", ")}`);
  }
  const baseline = loadBaseline(plan.checkout);
  const nextBaseline = new Map(baseline.values);
  const written: ExchangeReceipt["written"] = [];
  const deleted: string[] = [];
  const preserved: string[] = [];
  for (const entry of plan.paths) {
    const source = plan.projection.includes(entry.path)
      ? generatedValue(plan.source, entry.path)
      : null;
    if (entry.status === "update") {
      if (!source) throw new Error(`Reviewed source disappeared: ${entry.path}`);
      nextBaseline.set(entry.path, source);
      written.push({ path: entry.path, digest: source.digest, mode: source.mode });
    } else if (entry.status === "delete") {
      nextBaseline.delete(entry.path);
      deleted.push(entry.path);
    } else if (entry.status === "equal") {
      if (source) nextBaseline.set(entry.path, source);
      else nextBaseline.delete(entry.path);
    } else if (entry.status === "target-changed") {
      preserved.push(entry.path);
    }
  }
  return {
    baseline: [...nextBaseline.entries()].map(([relative, value]) => ({
      path: relative,
      ...value,
    })),
    written,
    deleted,
    preserved,
  };
}

export function applyPreparedTemplateRepositoryExchangeTarget(
  plan: TemplateExchangePlan,
  pending: PendingTemplateExchange
): void {
  for (const entry of pending.written) {
    const source = generatedValue(plan.source, entry.path);
    if (!source || source.digest !== entry.digest || source.mode !== entry.mode) {
      throw new Error(`Reviewed source changed before apply: ${entry.path}`);
    }
    writeValue(plan.target, entry.path, source);
  }
  for (const relative of pending.deleted) {
    const target = path.join(plan.target, ...relative.split("/"));
    fs.rmSync(target, { force: true });
    removeEmptyParents(plan.target, relative);
  }
}

export function applyTemplateRepositoryExchangeTarget(
  plan: TemplateExchangePlan
): PendingTemplateExchange {
  const pending = prepareTemplateRepositoryExchangeTarget(plan);
  applyPreparedTemplateRepositoryExchangeTarget(plan, pending);
  return pending;
}

export function completeTemplateRepositoryExchange(
  plan: TemplateExchangePlan,
  pending: PendingTemplateExchange
): ExchangeReceipt {
  const locations = baselinePaths(plan.checkout);
  const receiptPath = path.join(locations.receipts, `${plan.operationId}.json`);
  if (fs.existsSync(receiptPath)) {
    const existing = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as ExchangeReceipt;
    if (
      existing.format !== "vibestudio-template-exchange-receipt/1" ||
      existing.operationId !== plan.operationId ||
      existing.direction !== plan.direction ||
      existing.manifestDigest !== plan.manifestDigest
    ) {
      throw new Error("Template exchange receipt identity is corrupt");
    }
    return existing;
  }
  const next = storeBaseline(
    plan.checkout,
    new Map(
      pending.baseline.map((entry) => [
        entry.path,
        { bytes: entry.bytes, mode: entry.mode, digest: entry.digest },
      ])
    )
  );
  const receipt: ExchangeReceipt = {
    format: "vibestudio-template-exchange-receipt/1",
    operationId: plan.operationId,
    direction: plan.direction,
    manifestDigest: plan.manifestDigest,
    baselineBefore: plan.baselineDigest,
    baselineAfter: next.digest,
    written: pending.written,
    deleted: pending.deleted,
    preserved: pending.preserved,
    completedAt: new Date().toISOString(),
  };
  fs.mkdirSync(locations.receipts, { recursive: true, mode: 0o700 });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return receipt;
}

export function applyTemplateRepositoryExchange(plan: TemplateExchangePlan): ExchangeReceipt {
  return completeTemplateRepositoryExchange(plan, applyTemplateRepositoryExchangeTarget(plan));
}

export function applyReviewedTemplateRepositoryExchange(
  plan: TemplateExchangePlan,
  expectedOperationId: string
): ExchangeReceipt {
  if (plan.operationId !== expectedOperationId) {
    throw new Error(
      `Template exchange operation changed after review: expected ${expectedOperationId}, observed ${plan.operationId}`
    );
  }
  return applyTemplateRepositoryExchange(plan);
}
