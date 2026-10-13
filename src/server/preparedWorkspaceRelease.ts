import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { z } from "zod";
import {
  prepareBuildRootConfig,
  buildCompilerProtocolIdentity,
} from "./buildV2/effectiveVersion.js";
import {
  preparedWorkspaceTemplateSchema,
  preparedWorkspaceTemplatePath,
} from "./preparedWorkspaceTemplate.js";
import { blobCasPath } from "./storage/blobCas.js";
import { verifyReleaseBuildDirectory } from "../../scripts/prebuild-release-userland.mjs";
import { readHostBuildFingerprint, resolveRequiredHostArtifactRoot } from "./appRoot.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const hostBuildFingerprintSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["development", "production"]),
    fingerprint: digestSchema,
    inputCount: z.number().int().positive(),
  })
  .strict();
const runtimeBuildSchema = z
  .object({
    workspace: z.enum(["base", "personal", "system"]),
    source: z.string().min(1),
    buildKey: digestSchema,
    builtAt: z.string().min(1),
  })
  .strict();

export const preparedWorkspaceReleaseManifestSchema = z
  .object({
    format: z.literal("vibestudio-workspace-runtime-release/2"),
    version: z.literal(2),
    platform: z.string().min(1),
    arch: z.string().min(1),
    appDependencyFingerprint: digestSchema,
    hostBuild: hostBuildFingerprintSchema,
    compilerProtocol: z
      .object({
        cacheVersion: z.string().min(1),
        panelEntryProtocolFingerprint: digestSchema,
      })
      .strict(),
    templates: z.record(z.enum(["base", "personal", "system"]), WorkspaceTemplatePinSchema),
    preparedTemplates: z
      .array(
        z
          .object({
            workspace: z.enum(["base", "personal", "system"]),
            recordDigest: digestSchema,
          })
          .strict()
      )
      .length(3),
    builds: z.array(runtimeBuildSchema),
  })
  .strict();

export type PreparedWorkspaceReleaseManifest = z.infer<
  typeof preparedWorkspaceReleaseManifestSchema
>;
export type PreparedWorkspaceReleaseBuild = z.infer<typeof runtimeBuildSchema>;

export interface PreparedWorkspaceReleaseInput {
  readonly appRoot: string;
  readonly output: string;
  readonly templates: Readonly<Record<"base" | "personal" | "system", WorkspaceTemplatePin>>;
}

export async function workspaceReleaseIdentity(appRoot: string) {
  const rootFingerprint = await prepareBuildRootConfig({ appRoot });
  const hostBuild = hostBuildFingerprintSchema.parse(
    readHostBuildFingerprint(resolveRequiredHostArtifactRoot())
  );
  return {
    appDependencyFingerprint: rootFingerprint.value,
    hostBuild,
    compilerProtocol: buildCompilerProtocolIdentity(),
  };
}

export function workspaceReleaseManifestPath(output: string): string {
  return path.join(output, "userland-builds/release.json");
}

export async function createPreparedWorkspaceReleaseManifest(
  input: PreparedWorkspaceReleaseInput,
  builds: readonly PreparedWorkspaceReleaseBuild[],
  identity?: Awaited<ReturnType<typeof workspaceReleaseIdentity>>
): Promise<PreparedWorkspaceReleaseManifest> {
  const preparedTemplates: PreparedWorkspaceReleaseManifest["preparedTemplates"] = [];
  for (const workspace of ["base", "personal", "system"] as const) {
    const directory = preparedWorkspaceTemplatePath(
      input.output,
      input.templates[workspace],
      "use"
    );
    const recordPath = path.join(directory, "template.json");
    const recordBytes = await fs.readFile(recordPath);
    preparedTemplates.push({
      workspace,
      recordDigest: sha256(recordBytes),
    });
  }
  const resolvedIdentity = identity ?? (await workspaceReleaseIdentity(input.appRoot));
  return preparedWorkspaceReleaseManifestSchema.parse({
    format: "vibestudio-workspace-runtime-release/2",
    version: 2,
    platform: process.platform,
    arch: process.arch,
    ...resolvedIdentity,
    templates: input.templates,
    preparedTemplates,
    builds,
  });
}

/**
 * Reuse only a completely sealed release. A missing manifest in a genuinely
 * empty artifact area means this call owns first production; any partial
 * artifact area or any mismatch is an error and must not fall through to build.
 */
export async function validateExistingPreparedWorkspaceRelease(
  input: PreparedWorkspaceReleaseInput
): Promise<boolean> {
  const outputStat = await lstatOrNull(input.output);
  if (!outputStat) return false;
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error("Prepared workspace release output is not a real directory");
  }

  const manifestPath = workspaceReleaseManifestPath(input.output);
  const manifestStat = await lstatOrNull(manifestPath);
  if (!manifestStat) {
    for (const ownedPath of [
      path.join(input.output, "workspace-templates"),
      path.join(input.output, "userland-builds"),
      `${manifestPath}.publishing`,
    ]) {
      const stat = await lstatOrNull(ownedPath);
      if (
        stat &&
        (stat.isSymbolicLink() || (stat.isDirectory() && (await fs.readdir(ownedPath)).length))
      ) {
        throw new Error(`Prepared workspace release is incomplete: ${ownedPath}`);
      }
      if (stat?.isFile()) throw new Error(`Prepared workspace release is incomplete: ${ownedPath}`);
    }
    return false;
  }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Prepared workspace release manifest is not a regular file");
  }

  let manifest: PreparedWorkspaceReleaseManifest;
  try {
    manifest = preparedWorkspaceReleaseManifestSchema.parse(
      JSON.parse(await fs.readFile(manifestPath, "utf8"))
    );
  } catch (error) {
    throw new Error("Prepared workspace release manifest is invalid", { cause: error });
  }
  const identity = await workspaceReleaseIdentity(input.appRoot);
  if (
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.appDependencyFingerprint !== identity.appDependencyFingerprint ||
    canonicalJson(manifest.hostBuild) !== canonicalJson(identity.hostBuild) ||
    canonicalJson(manifest.compilerProtocol) !== canonicalJson(identity.compilerProtocol) ||
    canonicalJson(manifest.templates) !== canonicalJson(input.templates)
  ) {
    throw new Error(
      "Prepared workspace release does not match the current host and template inputs"
    );
  }

  const templateEntries = new Map(
    manifest.preparedTemplates.map((entry) => [entry.workspace, entry.recordDigest])
  );
  if (templateEntries.size !== 3)
    throw new Error("Prepared workspace release has incomplete roles");

  const buildsByRole = new Map<"base" | "personal" | "system", PreparedWorkspaceReleaseBuild[]>([
    ["base", []],
    ["personal", []],
    ["system", []],
  ]);
  for (const build of manifest.builds) {
    const roleBuilds = buildsByRole.get(build.workspace);
    if (!roleBuilds) throw new Error(`Prepared workspace release has an unknown role`);
    roleBuilds.push(build);
  }

  const artifactKeys = new Set<string>();
  for (const workspace of ["base", "personal", "system"] as const) {
    const pin = input.templates[workspace];
    const directory = preparedWorkspaceTemplatePath(input.output, pin, "use");
    const recordPath = path.join(directory, "template.json");
    const recordBytes = await fs.readFile(recordPath);
    if (sha256(recordBytes) !== templateEntries.get(workspace)) {
      throw new Error(`Prepared ${workspace} template record digest mismatch`);
    }
    const record = preparedWorkspaceTemplateSchema.parse(JSON.parse(recordBytes.toString("utf8")));
    const roleBuildInventory = buildsByRole.get(workspace);
    if (!roleBuildInventory) throw new Error(`Prepared workspace release is missing ${workspace}`);
    const roleBuilds = buildsByRole
      .get(workspace)
      ?.map(({ source, buildKey }) => ({ source, buildKey }))
      .sort((a, b) => a.source.localeCompare(b.source));
    if (!roleBuilds) throw new Error(`Prepared workspace release is missing ${workspace}`);
    const recordBuilds = record.builds
      .map(({ source, buildKey }) => ({ source, buildKey }))
      .sort((a, b) => a.source.localeCompare(b.source));
    if (
      record.purpose !== "use" ||
      canonicalJson(record.pin) !== canonicalJson(pin) ||
      new Set(record.builds.map((build) => build.source)).size !== record.builds.length ||
      new Set(roleBuildInventory.map((build) => build.source)).size !== roleBuildInventory.length ||
      recordBuilds.length !== roleBuilds.length ||
      canonicalJson(recordBuilds) !== canonicalJson(roleBuilds)
    ) {
      throw new Error(`Prepared ${workspace} template record does not match its release inventory`);
    }
    await verifyPreparedTemplateFiles(directory, record);
    if (roleBuildInventory.length === 0) {
      throw new Error(`Prepared workspace release has no runtime builds for ${workspace}`);
    }
    for (const build of roleBuildInventory) {
      artifactKeys.add(build.buildKey);
      const templateBuild = record.builds.find((entry) => entry.source === build.source);
      if (!templateBuild) {
        throw new Error(`Prepared ${workspace} runtime record is missing ${build.source}`);
      }
      const buildDirectory = path.join(input.output, "userland-builds", build.buildKey);
      const metadata = JSON.parse(
        await fs.readFile(path.join(buildDirectory, "metadata.json"), "utf8")
      );
      if (
        metadata.buildKey !== build.buildKey ||
        metadata.sourcePath !== build.source ||
        metadata.ev !== templateBuild.effectiveVersion ||
        metadata.builtAt !== build.builtAt
      ) {
        throw new Error(`Prepared ${workspace} runtime metadata does not match its source record`);
      }
    }
  }

  for (const buildKey of artifactKeys) {
    await verifyReleaseBuildDirectory(
      path.join(input.output, "userland-builds", buildKey),
      buildKey,
      true
    );
  }
  await verifyExactDirectoryEntries(
    path.join(input.output, "userland-builds"),
    new Set(["release.json", ...artifactKeys])
  );
  return true;
}

export async function publishPreparedWorkspaceRelease(
  input: PreparedWorkspaceReleaseInput,
  builds: readonly PreparedWorkspaceReleaseBuild[],
  identity?: Awaited<ReturnType<typeof workspaceReleaseIdentity>>
): Promise<void> {
  const manifestPath = workspaceReleaseManifestPath(input.output);
  const temporaryPath = `${manifestPath}.publishing`;
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const manifest = await createPreparedWorkspaceReleaseManifest(input, builds, identity);
  const bytes = `${JSON.stringify(manifest)}\n`;
  await fs.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
  await fs.rename(temporaryPath, manifestPath);
}

async function verifyPreparedTemplateFiles(
  directory: string,
  record: z.infer<typeof preparedWorkspaceTemplateSchema>
): Promise<void> {
  const expectedFiles = new Set(["template.json"]);
  for (const blob of record.blobs) {
    const relative = path.relative(
      directory,
      blobCasPath(path.join(directory, "blobs"), blob.digest)
    );
    expectedFiles.add(relative.split(path.sep).join("/"));
    const blobPath = path.join(directory, relative);
    const stat = await fs.lstat(blobPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Prepared template blob ${blob.digest} is not a regular file`);
    }
    const actual = await streamedFileDigest(blobPath);
    if (actual.size !== blob.size || actual.digest !== blob.digest) {
      throw new Error(`Prepared template blob ${blob.digest} failed integrity verification`);
    }
  }
  const actualFiles = new Set<string>();
  await collectRegularFiles(directory, directory, actualFiles);
  if (
    actualFiles.size !== expectedFiles.size ||
    [...expectedFiles].some((file) => !actualFiles.has(file))
  ) {
    throw new Error("Prepared template directory does not match its sealed blob closure");
  }
}

async function collectRegularFiles(
  root: string,
  current: string,
  files: Set<string>
): Promise<void> {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink())
      throw new Error(`Prepared workspace release contains a symlink: ${relative}`);
    if (stat.isDirectory()) await collectRegularFiles(root, absolute, files);
    else if (stat.isFile()) files.add(relative);
    else throw new Error(`Prepared workspace release contains a non-file entry: ${relative}`);
  }
}

async function verifyExactDirectoryEntries(
  directory: string,
  expected: Set<string>
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const actual = new Set<string>();
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`Prepared workspace release contains an invalid entry: ${entry.name}`);
    }
    actual.add(entry.name);
  }
  if (actual.size !== expected.size || [...expected].some((entry) => !actual.has(entry))) {
    throw new Error("Prepared runtime artifact directory does not match its release inventory");
  }
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function streamedFileDigest(filePath: string): Promise<{ digest: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.byteLength;
    hash.update(chunk);
  }
  return { digest: hash.digest("hex"), size };
}
