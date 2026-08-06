/**
 * Re-sign the seed records that mark units as shipping in the host build
 * (docs/template-install-unit-approval-ux-plan.md §7.6).
 *
 * A seed record is a signature over a unit's own source, and it answers one
 * question: is this the code Vibestudio ships, or is it something else? That is
 * what lets `apps/shell` and its kin skip the launch gate — the user decided
 * about them by installing Vibestudio, and for the shell in particular the gate
 * is unanswerable anyway, since the shell is the surface a review renders on.
 *
 * Because the record covers the source, it goes stale the moment anyone edits
 * one of those units — which, for `apps/shell`, is most days. The runtime does
 * not hold a development checkout to its recorded digest for exactly that
 * reason (see `inspectProductSeedSource`), so a stale record is not a broken
 * checkout; it is a record that has to be re-signed before the bytes are frozen
 * into a package. This is that step, and packaging runs it.
 *
 * Which units are seeded is not policy this script invents: it is the set that
 * already carries a `.vibestudio-seed.json`, so adding or removing one is a
 * deliberate act in the repo rather than a list buried here.
 *
 * `--check` verifies without writing, for CI.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const { productSeedSourceDigest, writeProductSeedSourceRecord } = await import(
  path.join(root, "packages/shared/src/productSeedTrust.ts")
);

const SEED_RECORD_FILE = ".vibestudio-seed.json";
/** Only the live workspace tree; `release/` holds packaged copies, not sources. */
const SEARCH_ROOTS = ["workspace/apps", "workspace/extensions"];

function seededUnitDirs() {
  const dirs = [];
  for (const searchRoot of SEARCH_ROOTS) {
    const absolute = path.join(root, searchRoot);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const unitDir = path.join(absolute, entry.name);
      if (fs.existsSync(path.join(unitDir, SEED_RECORD_FILE))) dirs.push(unitDir);
    }
  }
  return dirs.sort();
}

const stale = [];
let verified = 0;

for (const unitDir of seededUnitDirs()) {
  const record = JSON.parse(fs.readFileSync(path.join(unitDir, SEED_RECORD_FILE), "utf-8"));
  const repoPath = path.relative(path.join(root, "workspace"), unitDir).split(path.sep).join("/");
  // Compared directly rather than through the runtime verifier: the runtime
  // deliberately does not hold a development checkout to its recorded digest
  // (see `inspectProductSeedSource`), and this script's whole job is to notice
  // that the digest moved and re-sign it.
  if (record.sourceRepo === repoPath && record.sourceDigest === productSeedSourceDigest(unitDir)) {
    verified += 1;
    continue;
  }
  stale.push({ unitDir, repoPath, record });
}

if (stale.length === 0) {
  console.log(`Product seed records are current (${verified} unit(s)).`);
  process.exit(0);
}

if (check) {
  console.error(
    `Product seed records are stale for ${stale.length} unit(s):\n` +
      stale.map(({ repoPath }) => `  - ${repoPath}`).join("\n") +
      `\n\nThese units ship in the host build, and their record is a signature over their\n` +
      `source, so editing them invalidates it. Run:\n\n` +
      `  pnpm run generate:product-seed-records\n`
  );
  process.exit(1);
}

for (const { unitDir, repoPath, record } of stale) {
  writeProductSeedSourceRecord({
    unitDir,
    unitKind: record.unitKind,
    name: record.name,
    sourceRepo: repoPath,
  });
  console.log(`Re-signed ${repoPath}`);
}
console.log(`Re-signed ${stale.length} product seed record(s); ${verified} already current.`);
