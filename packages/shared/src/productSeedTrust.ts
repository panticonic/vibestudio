import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ProductSeedUnitKind = "extension" | "app";

export interface ProductSeedSourceRecord {
  kind: "product-seed-source";
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
  sourceDigest: string;
  signatureKeyId: string;
  signature: string;
  createdBy: "vibestudio";
}

export interface ProductSeedIdentity {
  unitKind: ProductSeedUnitKind;
  name: string;
  source: { kind: "workspace-repo"; repo: string; ref: string };
  effectiveVersion: string | null;
}

export interface ProductSeedVerification {
  record: ProductSeedSourceRecord;
  sourceDigest: string;
}

/**
 * Why a unit that was expected to ship with Vibestudio did not prove it.
 *
 * Every one of these is worth saying out loud. A host-build unit that fails to
 * verify is not merely un-seeded: nothing else records its admission, so the
 * launch gate confirms it forever and `apps/shell` in particular ends up gated
 * on a review only `apps/shell` could render. A silent `null` here reads on
 * screen as "the app just doesn't start", which is the least useful thing it
 * could possibly say.
 */
export type ProductSeedRejection =
  | "no-effective-version"
  | "no-record"
  | "identity-mismatch"
  | "source-changed"
  | "signature-invalid";

export type ProductSeedInspection =
  | { ok: true; verification: ProductSeedVerification }
  | { ok: false; reason: ProductSeedRejection; detail: string };

const SEED_RECORD_FILE = ".vibestudio-seed.json";
const DEV_SIGNATURE_KEY_ID = "vibestudio-dev-seed-v1";
const DEV_SIGNATURE_PREFIX = "vibestudio-dev-seed-sha256:";
const PRODUCT_SIGNATURE_PREFIX = "vibestudio-product-seed-ed25519:";
const DIGEST_VERSION = "vibestudio-product-seed-source-v1";
const SIGNATURE_VERSION = "vibestudio-product-seed-signature-v1";
const PRODUCT_PRIVATE_KEY_ENV = "VIBESTUDIO_PRODUCT_SEED_PRIVATE_KEY_PEM";
const PRODUCT_PRIVATE_KEY_ID_ENV = "VIBESTUDIO_PRODUCT_SEED_KEY_ID";
const PRODUCT_PUBLIC_KEYS_ENV = "VIBESTUDIO_PRODUCT_SEED_PUBLIC_KEYS_JSON";

export function createProductSeedSourceRecord(opts: {
  unitDir: string;
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
}): ProductSeedSourceRecord {
  const sourceDigest = productSeedSourceDigest(opts.unitDir);
  const sourceRepo = normalizeSeedRepoPath(opts.sourceRepo);
  return {
    kind: "product-seed-source",
    unitKind: opts.unitKind,
    name: opts.name,
    sourceRepo,
    sourceDigest,
    ...signProductSeedSource({
      unitKind: opts.unitKind,
      name: opts.name,
      sourceRepo,
      sourceDigest,
    }),
    createdBy: "vibestudio",
  };
}

export function writeProductSeedSourceRecord(opts: {
  unitDir: string;
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
}): ProductSeedSourceRecord {
  const record = createProductSeedSourceRecord(opts);
  fs.writeFileSync(
    path.join(opts.unitDir, SEED_RECORD_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf-8"
  );
  return record;
}

export function verifyProductSeedSource(opts: {
  unitDir: string;
  identity: ProductSeedIdentity;
}): ProductSeedVerification | null {
  const inspection = inspectProductSeedSource(opts);
  return inspection.ok ? inspection.verification : null;
}

/**
 * Verify a seed record, and say why when it does not hold.
 *
 * Callers that gate on seed trust use this rather than the boolean form, so a
 * unit that ships a record but fails to prove it says so once, in the log, with
 * the specific thing that did not match.
 */
export function inspectProductSeedSource(opts: {
  unitDir: string;
  identity: ProductSeedIdentity;
}): ProductSeedInspection {
  if (opts.identity.effectiveVersion === null) {
    return {
      ok: false,
      reason: "no-effective-version",
      detail: "the unit has no resolved effective version yet",
    };
  }
  const recordPath = path.join(opts.unitDir, SEED_RECORD_FILE);
  const record = readProductSeedSourceRecord(recordPath);
  if (!record) {
    return { ok: false, reason: "no-record", detail: `no readable record at ${recordPath}` };
  }
  const expectedRepo = normalizeSeedRepoPath(opts.identity.source.repo);
  if (
    record.unitKind !== opts.identity.unitKind ||
    record.name !== opts.identity.name ||
    record.sourceRepo !== expectedRepo
  ) {
    return {
      ok: false,
      reason: "identity-mismatch",
      detail: `record names ${record.unitKind} ${record.name} from ${record.sourceRepo}; declared ${opts.identity.unitKind} ${opts.identity.name} from ${expectedRepo}`,
    };
  }
  // The digest binds the record to bytes that cannot change under it — which is
  // what a packaged build has and a development checkout does not. In a
  // checkout the seeded units are precisely what the developer is editing, so a
  // signature over their source is stale the moment anyone touches the shell,
  // and enforcing it buys nothing: the development signature is a plain hash
  // anyone can recompute, so it never proved provenance in the first place.
  // What it does buy is a severe, silent failure — the shell stops counting as
  // a host-build unit, so it is never admitted, so it is gated on a review that
  // only the shell itself could render, and the app simply never opens.
  // Production keeps the binding, where the bytes are fixed and the signature
  // is a real one.
  const sourceDigest = productSeedSourceDigest(opts.unitDir);
  if (isProductionSeedTrustMode() && sourceDigest !== record.sourceDigest) {
    return {
      ok: false,
      reason: "source-changed",
      detail: `source digest ${sourceDigest} does not match the recorded ${record.sourceDigest}`,
    };
  }
  if (!verifyProductSeedSignature(record)) {
    return {
      ok: false,
      reason: "signature-invalid",
      detail: `signature from key ${record.signatureKeyId} did not verify`,
    };
  }
  return { ok: true, verification: { record, sourceDigest } };
}

/** Rejections already reported, so a reconcile loop states each one once. */
const reportedRejections = new Set<string>();

/**
 * The seed-trust gate both unit hosts use.
 *
 * Quiet about a unit that never claimed to ship with Vibestudio — most units
 * carry no record and that is the ordinary case, not a problem. Loud about one
 * that carries a record which does not hold, because the consequence is
 * invisible otherwise: the unit is never admitted, so the launch gate keeps
 * asking about it and anything gated on its admission never starts.
 */
export function isProductSeedTrusted(opts: {
  unitDir: string;
  identity: ProductSeedIdentity;
  warn?: (message: string) => void;
}): boolean {
  const inspection = inspectProductSeedSource(opts);
  if (inspection.ok) return true;
  if (inspection.reason === "no-record" || inspection.reason === "no-effective-version") {
    return false;
  }
  const key = `${opts.identity.unitKind}\0${opts.identity.name}\0${inspection.reason}`;
  if (reportedRejections.has(key)) return false;
  reportedRejections.add(key);
  (opts.warn ?? ((message: string) => console.warn(message)))(
    `[ProductSeed] ${opts.identity.unitKind} ${opts.identity.name} ships a seed record that does not hold (${inspection.reason}): ${inspection.detail}. It will not be admitted as a host-build unit; run \`pnpm generate:product-seed-records\` if its source changed on purpose.`
  );
  return false;
}

export function productSeedSourceDigest(unitDir: string): string {
  const hash = createHash("sha256");
  hash.update(`${DIGEST_VERSION}\0`);
  for (const file of listSeedSourceFiles(unitDir)) {
    const relative = toPosixPath(path.relative(unitDir, file));
    const content = fs.readFileSync(file);
    hash.update(relative);
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readProductSeedSourceRecord(filePath: string): ProductSeedSourceRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (!isProductSeedSourceRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isProductSeedSourceRecord(value: unknown): value is ProductSeedSourceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ProductSeedSourceRecord>;
  return (
    record.kind === "product-seed-source" &&
    (record.unitKind === "extension" || record.unitKind === "app") &&
    typeof record.name === "string" &&
    typeof record.sourceRepo === "string" &&
    typeof record.sourceDigest === "string" &&
    typeof record.signatureKeyId === "string" &&
    typeof record.signature === "string" &&
    record.createdBy === "vibestudio"
  );
}

function signProductSeedSource(opts: {
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
  sourceDigest: string;
}): { signatureKeyId: string; signature: string } {
  const productPrivateKey = process.env[PRODUCT_PRIVATE_KEY_ENV];
  const productKeyId = process.env[PRODUCT_PRIVATE_KEY_ID_ENV];
  if (productPrivateKey && productKeyId) {
    const payload = productSeedSignaturePayload(opts);
    const privateKey = createPrivateKey(productPrivateKey);
    return {
      signatureKeyId: productKeyId,
      signature: `${PRODUCT_SIGNATURE_PREFIX}${sign(null, payload, privateKey).toString("base64url")}`,
    };
  }
  if (isProductionSeedTrustMode()) {
    throw new Error(
      `${PRODUCT_PRIVATE_KEY_ENV} and ${PRODUCT_PRIVATE_KEY_ID_ENV} are required to create product seed records in production`
    );
  }
  return {
    signatureKeyId: DEV_SIGNATURE_KEY_ID,
    signature: signDevProductSeedSource(opts),
  };
}

function verifyProductSeedSignature(record: ProductSeedSourceRecord): boolean {
  const payload = productSeedSignaturePayload({
    unitKind: record.unitKind,
    name: record.name,
    sourceRepo: record.sourceRepo,
    sourceDigest: record.sourceDigest,
  });
  if (record.signatureKeyId === DEV_SIGNATURE_KEY_ID) {
    if (isProductionSeedTrustMode()) return false;
    return (
      record.signature ===
      signDevProductSeedSource({
        unitKind: record.unitKind,
        name: record.name,
        sourceRepo: record.sourceRepo,
        sourceDigest: record.sourceDigest,
      })
    );
  }
  if (!record.signature.startsWith(PRODUCT_SIGNATURE_PREFIX)) return false;
  const publicKey = trustedProductSeedPublicKeys().get(record.signatureKeyId);
  if (!publicKey) return false;
  try {
    const signature = Buffer.from(
      record.signature.slice(PRODUCT_SIGNATURE_PREFIX.length),
      "base64url"
    );
    return verify(null, payload, createPublicKey(publicKey), signature);
  } catch {
    return false;
  }
}

function signDevProductSeedSource(opts: {
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
  sourceDigest: string;
}): string {
  const hash = createHash("sha256");
  hash.update(
    `${SIGNATURE_VERSION}\0${opts.unitKind}\0${opts.name}\0${opts.sourceRepo}\0${opts.sourceDigest}`
  );
  return `${DEV_SIGNATURE_PREFIX}${hash.digest("hex")}`;
}

function productSeedSignaturePayload(opts: {
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
  sourceDigest: string;
}): Buffer {
  return Buffer.from(
    `${SIGNATURE_VERSION}\0${opts.unitKind}\0${opts.name}\0${opts.sourceRepo}\0${opts.sourceDigest}`,
    "utf-8"
  );
}

function trustedProductSeedPublicKeys(): Map<string, string> {
  const raw = process.env[PRODUCT_PUBLIC_KEYS_ENV];
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" &&
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].length > 0
    );
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function isProductionSeedTrustMode(): boolean {
  return process.env["VIBESTUDIO_PROD"] === "1" || process.env["NODE_ENV"] === "production";
}

function listSeedSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".cache" ||
        entry.name === SEED_RECORD_FILE
      ) {
        continue;
      }
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  return files.sort((a, b) => toPosixPath(a).localeCompare(toPosixPath(b)));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeSeedRepoPath(repoPath: string): string {
  return repoPath
    .replace(/^\/+/, "")
    .replace(/^workspace\//, "")
    .replace(/\/+$/, "");
}
