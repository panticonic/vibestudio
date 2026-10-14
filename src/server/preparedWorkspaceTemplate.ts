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
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { forEachOwnedConcurrent } from "../../scripts/lib/owned-concurrency.mjs";
import { readHostBuildFingerprint, resolveRequiredHostArtifactRoot } from "./appRoot.js";
import {
  rootDependencyFingerprintCaptureSchema,
  composeWorkspaceDependencyFingerprint,
  validateRootDependencyFingerprintCapture,
  buildCompilerProtocolIdentity,
  type RootDependencyFingerprintInfo,
} from "./buildV2/effectiveVersion.js";

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
const snapshotFile = file.extend({
  contentKind: z.enum(["text", "bytes"]),
  byteLength: z.number().int().nonnegative(),
  coordinateExtent: z.number().int().nonnegative(),
});
const snapshotDigest = z.string().regex(/^v1-sha256:[0-9a-f]{64}$/u);
const stateHash = z.string().regex(/^state:[0-9a-f]{64}$/u);
export const preparedCompilationInputSchema = z
  .object({
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
    fingerprint: rootDependencyFingerprintCaptureSchema,
  })
  .strict();
export type PreparedCompilationInput = z.infer<typeof preparedCompilationInputSchema>;
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
          files: z.array(snapshotFile),
        })
        .strict()
    ),
    stateHash,
    builds: z.array(
      z.object({ source: relativePath, buildKey: digest, effectiveVersion: digest }).strict()
    ),
    blobs: z.array(z.object({ digest, size: z.number().int().nonnegative() }).strict()),
    compilationInput: preparedCompilationInputSchema.optional(),
  })
  .strict();
export type PreparedWorkspaceTemplate = z.infer<typeof preparedWorkspaceTemplateSchema>;

/** Publication binds the SDK capture to the same installation identity as the
 * release. Source/author records may omit it; runnable releases may not. */
export function validatePreparedCompilationInput(
  input: PreparedCompilationInput | undefined,
  identity: Pick<PreparedCompilationInput, "hostBuild" | "compilerProtocol"> & {
    readonly appDependencyFingerprint: string;
  }
): PreparedCompilationInput {
  if (!input) throw new Error("Prepared host installation has no compilation input capture");
  input = preparedCompilationInputSchema.parse(input);
  validateRootDependencyFingerprintCapture(input.fingerprint);
  if (
    input.fingerprint.value !== identity.appDependencyFingerprint ||
    canonicalJson(input.hostBuild) !== canonicalJson(identity.hostBuild) ||
    canonicalJson(input.compilerProtocol) !== canonicalJson(identity.compilerProtocol)
  )
    throw new Error("Prepared compilation input does not match its release identity");
  return input;
}

export async function prepareWorkspaceCompilationFingerprint(
  input: PreparedCompilationInput,
  appRoot: string,
  workspaceRoot: string
): Promise<RootDependencyFingerprintInfo> {
  input = preparedCompilationInputSchema.parse(input);
  if (
    canonicalJson(input.hostBuild) !==
      canonicalJson(readHostBuildFingerprint(resolveRequiredHostArtifactRoot())) ||
    canonicalJson(input.compilerProtocol) !== canonicalJson(buildCompilerProtocolIdentity())
  )
    throw new Error(
      "Prepared compilation input belongs to a different host or compiler generation"
    );
  return composeWorkspaceDependencyFingerprint(input.fingerprint, appRoot, workspaceRoot);
}

export function readPreparedWorkspaceTemplate(
  directory: string,
  pin: WorkspaceTemplatePin,
  purpose: "use" | "author"
): PreparedWorkspaceTemplate {
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
  return prepared;
}

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
  const prepared = readPreparedWorkspaceTemplate(directory, pin, purpose);
  // Bound independent filesystem work and join every admitted operation before
  // returning failure to the owner of the destination.
  await forEachOwnedConcurrent(prepared.blobs, 16, async (blob) => {
    await linkReconstructableBlobFile(
      blobsDir,
      blob.digest,
      blobCasPath(path.join(directory, "blobs"), blob.digest),
      blob.size
    );
  });
  return prepared;
}
