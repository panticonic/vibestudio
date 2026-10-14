import type { z } from "zod";
import type { DurableWorkQueue } from "@vibestudio/shared/durableWork";
import type { WorkspaceReleaseIdentity } from "../../src/server/preparedWorkspaceRelease.js";
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
export interface SchemaProbeReceipt {
  readonly format: "vibestudio-schema-probe/1";
  readonly identity: SchemaProbeIdentity;
  readonly descriptor: SchemaProbeDescriptor;
}
export type InstalledSchemaProbeEvidence = ReadonlyMap<string, SchemaProbeReceipt>;
export const schemaProbeIdentitySchema: z.ZodType<SchemaProbeIdentity>;
export const schemaProbeDescriptorSchema: z.ZodType<SchemaProbeDescriptor>;
export const schemaProbeInstallationSchema: z.ZodType<WorkspaceReleaseIdentity>;
export const schemaProbeReceiptSchema: z.ZodType<SchemaProbeReceipt>;
export function schemaProbeKey(identity: SchemaProbeIdentity): string;
export function admitSchemaProbeReceipt(value: unknown, expectedKey: string): SchemaProbeReceipt;
export function schemaProbeComponentPath(root: string): string;
export function readInstalledSchemaProbeEvidence(
  root: string,
  installation: WorkspaceReleaseIdentity,
  platform?: string,
  arch?: string
): Promise<InstalledSchemaProbeEvidence>;
export function stageInstalledSchemaProbeEvidence(input: {
  source: string;
  output: string;
  installation: WorkspaceReleaseIdentity;
  artifacts: readonly { source: string; artifactDigest: string }[];
  signal?: AbortSignal;
  platform?: string;
  arch?: string;
  stagingPath?: string;
}): Promise<{ readonly path: string; publish(): Promise<void>; close(): Promise<void> }>;
