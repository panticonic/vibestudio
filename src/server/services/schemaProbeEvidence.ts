import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { parseDurableWorkReady, type DurableWorkQueue } from "@vibestudio/shared/durableWork";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import {
  DerivedCacheCoordinator,
  derivedCacheDatabasePath,
  scheduleDerivedCachePrune,
  type DerivedCacheLease,
} from "@vibestudio/shared/derivedCache";
import { SharedBuildCoordinator } from "../buildV2/sharedBuildCoordinator.js";
import { BuildPriorityOwner } from "../buildV2/builderLifetime.js";
import type { WorkspaceReleaseIdentity } from "../preparedWorkspaceRelease.js";
import { runWithOwnedCleanup, runOwnedCleanupSteps } from "../../../scripts/lib/owned-cleanup.mjs";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identitySchema = z
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
    installation: z
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
      .strict(),
  })
  .strict();
export interface SchemaProbeIdentity {
  readonly artifactDigest: string;
  readonly source: string;
  readonly className: string;
  readonly protocol: number;
  readonly platform: string;
  readonly arch: string;
  readonly compatibility: {
    readonly compatibilityDate: string;
    readonly compatibilityFlags: readonly string[];
    readonly mainModule: string;
  };
  readonly installation: WorkspaceReleaseIdentity;
}
export interface SchemaProbeDescriptor {
  readonly className: string;
  readonly version: number;
  readonly freshSchemaFingerprint: string;
  readonly durableWorkQueues: readonly DurableWorkQueue[];
  readonly nativeOwner: boolean;
}
const descriptorSchema = z
  .object({
    className: z.string().min(1),
    version: z.number().int().positive(),
    freshSchemaFingerprint: z.string().min(1),
    nativeOwner: z.boolean(),
    durableWorkQueues: z.unknown().transform((value) => parseDurableWorkReady(value)),
  })
  .strict();
const receiptSchema = z
  .object({
    format: z.literal("vibestudio-schema-probe/1"),
    identity: identitySchema,
    descriptor: descriptorSchema,
  })
  .strict();

/** Share only the immutable result of the existing executable probe. No SQL,
 * activation identity, credential or grant enters this publication. The full
 * published installation binds the serving engine/loader and trusted npm realm. */
export async function acquireSchemaProbeEvidence(
  input: { readonly identity: SchemaProbeIdentity; readonly signal: AbortSignal },
  probe: () => Promise<SchemaProbeDescriptor>
): Promise<SchemaProbeDescriptor> {
  input.signal.throwIfAborted();
  const identity = identitySchema.parse(input.identity);
  const key = createHash("sha256")
    .update(canonicalJson({ format: "vibestudio-schema-probe/1", identity }))
    .digest("hex");
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
    const receipt = receiptSchema.parse(JSON.parse(bytes));
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
          const descriptor = await activeCoordinator.acquire(priority, input.signal, async () => {
            input.signal.throwIfAborted();
            const result = descriptorSchema.parse(await probe());
            if (result.className !== identity.className)
              throw new Error("Schema probe returned a different class identity");
            input.signal.throwIfAborted();
            return result;
          });
          const staging = `${target}.publishing.${randomUUID()}`;
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
