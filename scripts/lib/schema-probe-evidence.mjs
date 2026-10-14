import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { parseDurableWorkReady } from "@vibestudio/shared/durableWork";
import { runWithOwnedCleanup } from "./owned-cleanup.mjs";
import {
  schemaProbeComponentPath,
  schemaProbeStagingPath,
  assertSchemaProbeStagingPath,
  publishSchemaProbeComponent,
  retireSchemaProbeStaging,
} from "./schema-evidence-publication.mjs";
export { schemaProbeComponentPath } from "./schema-evidence-publication.mjs";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const schemaProbeInstallationSchema = z
  .object({
    appDependencyFingerprint: digest,
    hostBuild: z
      .object({
        version: z.literal(1),
        mode: z.enum(["development", "production"]),
        fingerprint: digest,
        inputCount: z.number().int().positive(),
      })
      .strict(),
    compilerProtocol: z
      .object({ cacheVersion: z.string().min(1), panelEntryProtocolFingerprint: digest })
      .strict(),
  })
  .strict();
export const schemaProbeIdentitySchema = z
  .object({
    artifactDigest: digest,
    source: z.string().min(1),
    className: z.string().min(1),
    protocol: z.number().int().positive(),
    platform: z.string().min(1),
    arch: z.string().min(1),
    compatibility: z
      .object({
        compatibilityDate: z.string().min(1),
        compatibilityFlags: z.array(z.string()),
        mainModule: z.string().min(1),
      })
      .strict(),
    installation: schemaProbeInstallationSchema,
  })
  .strict();
export const schemaProbeDescriptorSchema = z
  .object({
    className: z.string().min(1),
    version: z.number().int().positive(),
    freshSchemaFingerprint: z.string().min(1),
    nativeOwner: z.boolean(),
    durableWorkQueues: z.unknown().transform((value) => parseDurableWorkReady(value)),
  })
  .strict();
export const schemaProbeReceiptSchema = z
  .object({
    format: z.literal("vibestudio-schema-probe/1"),
    identity: schemaProbeIdentitySchema,
    descriptor: schemaProbeDescriptorSchema,
  })
  .strict();
const componentSchema = z
  .object({
    format: z.literal("vibestudio-installed-schema-evidence/1"),
    installation: schemaProbeInstallationSchema,
    platform: z.string().min(1),
    arch: z.string().min(1),
    inventory: z.array(digest),
    receipts: z.array(schemaProbeReceiptSchema),
  })
  .strict();
export function schemaProbeKey(identity) {
  return createHash("sha256")
    .update(
      canonicalJson({
        format: "vibestudio-schema-probe/1",
        identity: schemaProbeIdentitySchema.parse(identity),
      })
    )
    .digest("hex");
}
export function admitSchemaProbeReceipt(value, expectedKey) {
  const receipt = schemaProbeReceiptSchema.parse(value);
  if (
    schemaProbeKey(receipt.identity) !== expectedKey ||
    receipt.descriptor.className !== receipt.identity.className
  )
    throw new Error("Schema probe receipt does not match its exact executable recipe");
  return receipt;
}
function admitComponent(value, installation, platform, arch) {
  const component = componentSchema.parse(value);
  if (
    canonicalJson(component.installation) !== canonicalJson(installation) ||
    component.platform !== platform ||
    component.arch !== arch
  )
    throw new Error("Installed schema evidence does not match the serving installation");
  const receipts = new Map();
  for (const candidate of component.receipts) {
    const key = schemaProbeKey(candidate.identity);
    const receipt = admitSchemaProbeReceipt(candidate, key);
    if (
      canonicalJson(receipt.identity.installation) !== canonicalJson(installation) ||
      receipt.identity.platform !== platform ||
      receipt.identity.arch !== arch ||
      receipts.has(key)
    )
      throw new Error("Installed schema evidence contains a conflicting recipe");
    receipts.set(key, receipt);
  }
  if (
    new Set(component.inventory).size !== component.inventory.length ||
    canonicalJson([...receipts.keys()].sort((a, b) => a.localeCompare(b))) !==
      canonicalJson([...component.inventory].sort((a, b) => a.localeCompare(b)))
  )
    throw new Error("Installed schema evidence has a missing or conflicting advertised receipt");
  return receipts;
}

/** A missing component is an unadvertised immutable input, not a broken record.
 * Advertised receipts must be complete; mutable artifacts still use the same probe. */
export async function readInstalledSchemaProbeEvidence(
  root,
  installation,
  platform = process.platform,
  arch = process.arch
) {
  const filename = schemaProbeComponentPath(root);
  let bytes;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Installed schema evidence is not a regular file");
    bytes = await fs.readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
  return admitComponent(JSON.parse(bytes), installation, platform, arch);
}

/** Stage only completed canonical probe receipts from the genuine verifier.
 * The caller publishes this component only after that serving owner retires. */
export async function stageInstalledSchemaProbeEvidence({
  source,
  output,
  installation,
  artifacts,
  signal,
  stagingPath,
  platform = process.platform,
  arch = process.arch,
}) {
  signal?.throwIfAborted();
  installation = schemaProbeInstallationSchema.parse(installation);
  const receipts = [];
  let entries;
  try {
    entries = await fs.readdir(source, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    entries = [];
  }
  for (const entry of entries) {
    // Only the existing coordinator and this publisher's exact private naming
    // contract are unadvertised. Unknown entries remain corruption, not misses.
    const privateEntry =
      entry.name === ".storage" ||
      /^[a-f0-9]{64}\.tmp\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
        entry.name
      );
    if (privateEntry) {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Schema producer private state is not an owned directory");
      continue;
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Schema evidence producer has an incomplete or foreign entry");
    const directory = path.join(source, entry.name);
    if (canonicalJson(await fs.readdir(directory)) !== canonicalJson(["receipt.json"]))
      throw new Error("Schema evidence producer contains data outside its immutable descriptor");
    const receiptStat = await fs.lstat(path.join(directory, "receipt.json"));
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink())
      throw new Error("Schema probe receipt is not a regular file");
    const receipt = admitSchemaProbeReceipt(
      JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8")),
      entry.name
    );
    if (
      !artifacts.some(
        (artifact) =>
          artifact.source === receipt.identity.source &&
          artifact.artifactDigest === receipt.identity.artifactDigest
      )
    )
      throw new Error("Schema evidence does not belong to a published runtime artifact");
    receipts.push(receipt);
  }
  receipts.sort((a, b) => schemaProbeKey(a.identity).localeCompare(schemaProbeKey(b.identity)));
  const component = {
    format: "vibestudio-installed-schema-evidence/1",
    installation,
    platform,
    arch,
    inventory: receipts.map((receipt) => schemaProbeKey(receipt.identity)),
    receipts,
  };
  admitComponent(component, installation, platform, arch);
  const temporary = assertSchemaProbeStagingPath(
    stagingPath ?? schemaProbeStagingPath(output),
    output
  );
  let ownsTemporary = false;
  let staged = false;
  await runWithOwnedCleanup(
    async () => {
      const handle = await fs.open(temporary, "wx", 0o600);
      ownsTemporary = true;
      await runWithOwnedCleanup(
        () => handle.writeFile(`${canonicalJson(component)}\n`),
        () => handle.close(),
        "Schema evidence staging write and close failed"
      );
      staged = true;
    },
    async () => {
      if (ownsTemporary && !staged) await fs.rm(temporary, { force: true });
    },
    "Schema evidence staging failed"
  );
  return {
    path: temporary,
    async publish() {
      signal?.throwIfAborted();
      // Hardlink publishes without replacing an existing immutable component.
      await publishSchemaProbeComponent(temporary, output);
    },
    async close() {
      if (ownsTemporary) await retireSchemaProbeStaging(temporary, output);
    },
  };
}
