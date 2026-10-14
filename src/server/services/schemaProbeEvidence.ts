import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import {
  DerivedCacheCoordinator,
  derivedCacheDatabasePath,
  scheduleDerivedCachePrune,
  type DerivedCacheLease,
} from "@vibestudio/shared/derivedCache";
import { SharedBuildCoordinator } from "../buildV2/sharedBuildCoordinator.js";
import { BuildPriorityOwner } from "../buildV2/builderLifetime.js";
import {
  schemaProbeIdentitySchema as identitySchema,
  schemaProbeDescriptorSchema as descriptorSchema,
  admitSchemaProbeReceipt,
  schemaProbeKey,
  type InstalledSchemaProbeEvidence,
  type SchemaProbeIdentity,
  type SchemaProbeDescriptor,
} from "../../../scripts/lib/schema-probe-evidence.mjs";
export { readInstalledSchemaProbeEvidence } from "../../../scripts/lib/schema-probe-evidence.mjs";
export type {
  SchemaProbeIdentity,
  SchemaProbeDescriptor,
  InstalledSchemaProbeEvidence,
} from "../../../scripts/lib/schema-probe-evidence.mjs";
import { runWithOwnedCleanup, runOwnedCleanupSteps } from "../../../scripts/lib/owned-cleanup.mjs";

/** Share only the immutable result of the existing executable probe. No SQL,
 * activation identity, credential or grant enters this publication. The full
 * published installation binds the serving engine/loader and trusted npm realm. */
export async function acquireSchemaProbeEvidence(
  input: {
    readonly identity: SchemaProbeIdentity;
    readonly signal: AbortSignal;
    readonly installed?: InstalledSchemaProbeEvidence;
  },
  probe: () => Promise<SchemaProbeDescriptor>
): Promise<SchemaProbeDescriptor> {
  input.signal.throwIfAborted();
  const identity = identitySchema.parse(input.identity);
  const key = schemaProbeKey(identity);
  const installed = input.installed?.get(key);
  if (installed) return admitSchemaProbeReceipt(installed, key).descriptor;
  const root = path.join(getSharedDerivedDataPath(), "schema-probes");
  const target = path.join(root, key);
  const read = async (): Promise<SchemaProbeDescriptor | null> => {
    let bytes: string;
    try {
      bytes = await fs.readFile(path.join(target, "receipt.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await fs.stat(target);
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw missing;
      }
      throw new Error("Schema probe publication is incomplete");
    }
    const receipt = admitSchemaProbeReceipt(JSON.parse(bytes), key);
    if (
      canonicalJson(receipt.identity) !== canonicalJson(identity) ||
      receipt.descriptor.className !== identity.className
    )
      throw new Error("Schema probe receipt does not match its exact executable recipe");
    if (canonicalJson(await fs.readdir(target)) !== canonicalJson(["receipt.json"]))
      throw new Error("Schema probe evidence contains data outside its immutable descriptor");
    return receipt.descriptor;
  };
  const cacheOwner = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
  let lease: DerivedCacheLease | undefined;
  let coordinator: SharedBuildCoordinator | undefined;
  return runWithOwnedCleanup(
    async () => {
      lease = cacheOwner.acquire(root, key);
      const activeCoordinator = (coordinator = new SharedBuildCoordinator(root, 3));
      const cached = await read();
      if (cached) return cached;
      const outcome = await activeCoordinator.run(
        key,
        new BuildPriorityOwner("interactive"),
        input.signal,
        async (priority) => {
          const published = await read();
          if (published) return published;
          const descriptor = await activeCoordinator.withSlot(priority, input.signal, async () => {
            input.signal.throwIfAborted();
            const result = descriptorSchema.parse(await probe());
            if (result.className !== identity.className)
              throw new Error("Schema probe returned a different class identity");
            input.signal.throwIfAborted();
            return result;
          });
          // Derived-cache scanners reserve `.tmp.` names for private producer
          // state. Only the atomic rename destination is a cache entry.
          const staging = `${target}.tmp.${randomUUID()}`;
          await runWithOwnedCleanup(
            async () => {
              await fs.mkdir(staging);
              await fs.writeFile(
                path.join(staging, "receipt.json"),
                canonicalJson({ format: "vibestudio-schema-probe/1", identity, descriptor }),
                { flag: "wx", mode: 0o600 }
              );
              input.signal.throwIfAborted();
              await fs.rename(staging, target);
            },
            () => fs.rm(staging, { recursive: true, force: true }),
            "Schema probe publication and staging retirement failed"
          );
          return descriptor;
        }
      );
      if (outcome.produced) return outcome.value;
      const published = await read();
      if (!published)
        throw new Error("Shared schema probe settled without publishing its descriptor");
      return published;
    },
    () =>
      runOwnedCleanupSteps(
        [
          () => coordinator?.close(),
          () => lease?.release(),
          () => cacheOwner.close(),
          () => scheduleDerivedCachePrune(root),
        ],
        "Schema probe cache ownership retirement failed"
      ),
    "Schema evidence operation and retirement failed"
  );
}
