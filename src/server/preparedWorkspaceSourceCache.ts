import fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import {
  DerivedCacheCoordinator,
  derivedCacheDatabasePath,
  scheduleDerivedCachePrune,
} from "@vibestudio/shared/derivedCache";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { SharedBuildCoordinator } from "./buildV2/sharedBuildCoordinator.js";
import { BuildPriorityOwner } from "./buildV2/builderLifetime.js";
import {
  preparedWorkspaceTemplatePath,
  preparedWorkspaceTemplateSchema,
} from "./preparedWorkspaceTemplate.js";
import {
  inspectPreparedTemplateFiles,
  provePreparedTemplateFiles,
} from "./preparedWorkspaceRelease.js";
import { runWithOwnedCleanup, runOwnedCleanupSteps } from "../../scripts/lib/owned-cleanup.mjs";

const roles = ["base", "personal", "system"] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identitySchema = z
  .object({
    recipe: digest,
    appDependencyFingerprint: digest,
    systemEpoch: z.number().int().nonnegative(),
    templates: z.record(z.enum(roles), WorkspaceTemplatePinSchema),
    layers: z.record(z.enum(roles), z.array(WorkspaceTemplatePinSchema).min(1)),
  })
  .strict();
const markerSchema = z
  .object({
    format: z.literal("vibestudio-workspace-sources/1"),
    identity: identitySchema,
    records: z.record(z.enum(roles), digest),
  })
  .strict();
export type PreparedWorkspaceSourceIdentity = z.infer<typeof identitySchema>;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const markerPath = (root: string) => path.join(root, "source-release.json");

async function inspectSources(
  root: string,
  identity: PreparedWorkspaceSourceIdentity,
  records?: z.infer<typeof markerSchema>["records"]
) {
  const top = await fs.readdir(root);
  if (top.some((entry) => entry !== "workspace-templates" && entry !== "source-release.json"))
    throw new Error("Prepared source cache contains data outside its immutable source phase");
  const inspected = [];
  for (const role of roles) {
    const directory = preparedWorkspaceTemplatePath(root, identity.templates[role], "use");
    const bytes = await fs.readFile(path.join(directory, "template.json"));
    const recordDigest = hash(bytes);
    if (records && records[role] !== recordDigest)
      throw new Error(`Prepared ${role} source record differs from its publication`);
    const record = preparedWorkspaceTemplateSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      record.purpose !== "use" ||
      canonicalJson(record.pin) !== canonicalJson(identity.templates[role]) ||
      canonicalJson(record.layers) !== canonicalJson(identity.layers[role]) ||
      record.compilationInput ||
      record.builds.length
    ) {
      throw new Error(`Prepared ${role} source record does not match its pure source phase`);
    }
    await inspectPreparedTemplateFiles(directory, record);
    inspected.push({ role, directory, record, recordDigest });
  }
  return inspected;
}

async function admitSources(
  root: string,
  identity: PreparedWorkspaceSourceIdentity
): Promise<boolean> {
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Prepared source cache is not an immutable directory");
  // Only atomic rename publishes this directory. Its existence without its
  // marker is corruption, never permission to silently rebuild over it.
  const marker = markerSchema.parse(JSON.parse(await fs.readFile(markerPath(root), "utf8")));
  if (canonicalJson(marker.identity) !== canonicalJson(identity))
    throw new Error("Prepared source cache identity mismatch");
  await inspectSources(root, identity, marker.records);
  return true;
}

async function publishSources(
  root: string,
  identity: PreparedWorkspaceSourceIdentity
): Promise<void> {
  const inspected = await inspectSources(root, identity);
  for (const { directory, record } of inspected)
    await provePreparedTemplateFiles(directory, record);
  const marker = markerSchema.parse({
    format: "vibestudio-workspace-sources/1",
    identity,
    records: Object.fromEntries(inspected.map(({ role, recordDigest }) => [role, recordDigest])),
  });
  const handle = await fs.open(markerPath(root), "wx", 0o600);
  await runWithOwnedCleanup(
    () => handle.writeFile(`${JSON.stringify(marker)}\n`),
    () => handle.close(),
    "Source publication write and close failed"
  );
}

/** Source preparation is an immutable phase, independent of runtime builds.
 * Its retained lease protects lazy hydration through the owned continuation;
 * nothing here retains workspace databases, credentials, grants or compiler state. */
export async function acquirePreparedWorkspaceSources(
  input: { identity: PreparedWorkspaceSourceIdentity; signal?: AbortSignal },
  produce: (stagingRoot: string) => Promise<void>
): Promise<{ root: string; close(): Promise<void> }> {
  input.signal?.throwIfAborted();
  const identity = identitySchema.parse(input.identity);
  const root = path.join(getSharedDerivedDataPath(), "workspace-sources");
  const key = hash(canonicalJson({ format: "vibestudio-workspace-sources/1", ...identity }));
  const cached = path.join(root, key);
  const owner = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
  let lease: ReturnType<DerivedCacheCoordinator["acquire"]> | undefined;
  let coordinator: SharedBuildCoordinator | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runOwnedCleanupSteps(
      [() => coordinator?.close(), () => lease?.release(), () => owner.close()],
      "Prepared source cache retirement failed"
    );
    await scheduleDerivedCachePrune(root);
  };
  try {
    lease = owner.acquire(root, key);
    let reused = await admitSources(cached, identity);
    if (!reused) {
      coordinator = new SharedBuildCoordinator(root, 1);
      const outcome = await coordinator.run(
        key,
        new BuildPriorityOwner("interactive"),
        input.signal ?? new AbortController().signal,
        async () => {
          if (await admitSources(cached, identity)) {
            reused = true;
            return;
          }
          const staging = `${cached}.tmp.${randomUUID()}`;
          let owned = false;
          await runWithOwnedCleanup(
            async () => {
              await fs.mkdir(staging);
              owned = true;
              await produce(staging);
              input.signal?.throwIfAborted();
              await publishSources(staging, identity);
              await fs.rename(staging, cached);
            },
            async () => {
              if (owned) await fs.rm(staging, { recursive: true, force: true });
            },
            "Source publication and staging retirement failed"
          );
        }
      );
      // Publication proves bytes once. Joining consumers inspect descriptors,
      // lengths and presence, never read/hash each source payload again.
      if (!outcome.produced) {
        if (!(await admitSources(cached, identity)))
          throw new Error("Source producer returned without a completed publication");
        reused = true;
      }
      await coordinator.close();
      coordinator = undefined;
    }
    console.log(
      `[workspace-sources] ${reused ? "Reusing" : "Prepared"} immutable source phase ${key.slice(0, 12)}`
    );
    return { root: cached, close };
  } catch (error) {
    return runWithOwnedCleanup(
      async () => {
        throw error;
      },
      close,
      "Source acquisition and retirement failed"
    );
  }
}
