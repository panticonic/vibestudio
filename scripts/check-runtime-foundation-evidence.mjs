import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runtimeFoundationEvidence } from "./runtime-foundation-evidence.mjs";
import {
  validateEvidenceManifest,
  validateEvidenceRegistry,
} from "./lib/runtime-foundation-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, ".cache", "runtime-foundation-evidence");
const sessionPath = path.join(directory, "session.json");

if (process.argv[2] === "--start") {
  const expectedProjects = process.argv.slice(3);
  if (expectedProjects.length === 0 || new Set(expectedProjects).size !== expectedProjects.length) {
    throw new Error("Usage: check-runtime-foundation-evidence.mjs --start PROJECT...");
  }
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    sessionPath,
    `${JSON.stringify({ version: 1, id: randomUUID(), expectedProjects }, null, 2)}\n`
  );
  process.exit(0);
}

if (!fs.existsSync(sessionPath)) {
  throw new Error(
    "No runtime-foundation evidence session. Run the full `pnpm test` command to produce one."
  );
}
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
const registry = validateEvidenceRegistry({ root, registry: runtimeFoundationEvidence });
const fragments = session.expectedProjects.flatMap((project) => {
  const fragmentPath = path.join(directory, `${project}.json`);
  if (!fs.existsSync(fragmentPath)) return [];
  const fragment = JSON.parse(fs.readFileSync(fragmentPath, "utf8"));
  if (fragment.sessionId !== session.id) {
    throw new Error(`Runtime-foundation evidence for ${project} came from a stale test session`);
  }
  return [fragment];
});
const entries = validateEvidenceManifest({
  registry,
  expectedProjects: session.expectedProjects,
  fragments,
});
fs.writeFileSync(
  path.join(directory, "ledger-evidence-manifest.json"),
  `${JSON.stringify({ version: 1, sessionId: session.id, entries }, null, 2)}\n`
);
fs.rmSync(sessionPath);
console.log(`Verified ${entries.length} runtime-foundation evidence tests.`);
