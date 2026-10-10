import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { createRuntimeLayout } from "@vibestudio/shared/runtimePaths";
import { canonicalTemplateNodeId } from "@vibestudio/workspace/templateCoordinates";
import {
  WorkspaceTemplatePinSchema,
  WorkspaceTemplateInstallationSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { blobCasPath, linkReconstructableBlobFile } from "./storage/blobCas.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
const file = z
  .object({
    path: relativePath,
    contentHash: digest,
    size: z.number().int().nonnegative(),
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
  })
  .strict();
const snapshotDigest = z.string().regex(/^v1-sha256:[0-9a-f]{64}$/u);
const stateHash = z.string().regex(/^state:[0-9a-f]{64}$/u);
export const preparedWorkspaceTemplateSchema = z
  .object({
    format: z.literal("vibestudio-prepared-workspace/1"),
    purpose: z.enum(["use", "author"]),
    pin: WorkspaceTemplatePinSchema,
    layers: z.array(WorkspaceTemplatePinSchema).min(1),
    installation: WorkspaceTemplateInstallationSchema,
    snapshot: snapshotDigest,
    files: z.array(file),
    repositories: z.array(
      z
        .object({
          repoPath: relativePath,
          subdir: relativePath,
          snapshot: snapshotDigest,
          contentRoot: stateHash,
          files: z.array(file),
        })
        .strict()
    ),
    stateHash,
    builds: z.array(
      z.object({ source: relativePath, buildKey: digest, effectiveVersion: digest }).strict()
    ),
    blobs: z.array(z.object({ digest, size: z.number().int().nonnegative() }).strict()),
  })
  .strict();
export type PreparedWorkspaceTemplate = z.infer<typeof preparedWorkspaceTemplateSchema>;

/** One release resource root. Source supervisors supply their owned prepared
 * resources; installed hosts use the resources shipped with their application. */
export function workspaceReleaseResourceRoot(appRoot: string): string {
  return process.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"]
    ? path.resolve(process.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"]!)
    : createRuntimeLayout(appRoot).resourcesRoot;
}

export function preparedWorkspaceTemplatePath(
  root: string,
  pin: WorkspaceTemplatePin,
  purpose: "use" | "author"
): string {
  return path.join(
    root,
    "workspace-templates",
    canonicalTemplateNodeId(pin.url, pin.commit),
    purpose
  );
}

/** Installed immutable bytes are admitted once by publication. Installation
 * links that exact CAS closure, without rescanning Git or hashing each blob. */
export async function installPreparedWorkspaceTemplate(
  directory: string,
  blobsDir: string,
  pin: WorkspaceTemplatePin,
  purpose: "use" | "author"
): Promise<PreparedWorkspaceTemplate> {
  const prepared = preparedWorkspaceTemplateSchema.parse(
    JSON.parse(fs.readFileSync(path.join(directory, "template.json"), "utf8"))
  );
  if (
    prepared.pin.url !== pin.url ||
    prepared.pin.commit !== pin.commit ||
    prepared.pin.ref !== pin.ref ||
    prepared.purpose !== purpose
  )
    throw new Error("Prepared workspace template does not match its creation coordinate");
  // Bound independent filesystem work and join every admitted operation before
  // returning failure to the owner of the destination.
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(16, prepared.blobs.length) }, async () => {
      while (next < prepared.blobs.length) {
        const blob = prepared.blobs[next++]!;
        await linkReconstructableBlobFile(
          blobsDir,
          blob.digest,
          blobCasPath(path.join(directory, "blobs"), blob.digest),
          blob.size
        );
      }
    })
  );
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return prepared;
}
