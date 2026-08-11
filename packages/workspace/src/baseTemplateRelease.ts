import { z } from "zod";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { parseMigrationNote, type MigrationNote } from "./migrationNotes.js";

export const BASE_TEMPLATE_RELEASE_ARTIFACT = "base-template-release.json" as const;

const BaseTemplateReleaseArtifactSchema = z
  .object({
    version: z.literal(1),
    baseTemplate: WorkspaceTemplatePinSchema,
    systemNotes: z.array(
      z
        .object({
          path: z.string(),
          markdown: z.string(),
        })
        .strict()
    ),
  })
  .strict();

export interface BaseTemplateReleaseArtifact {
  version: 1;
  baseTemplate: WorkspaceTemplatePin;
  /** Raw living documents, carried verbatim so the host can hand them to a
   * manual or future automated rescue harness without consulting userland. */
  systemNotes: Array<{ path: string; markdown: string }>;
}

export interface ParsedBaseTemplateRelease extends BaseTemplateReleaseArtifact {
  parsedSystemNotes: MigrationNote[];
}

export function parseBaseTemplateReleaseArtifact(value: unknown): ParsedBaseTemplateRelease {
  const artifact = BaseTemplateReleaseArtifactSchema.parse(value) as BaseTemplateReleaseArtifact;
  const paths = new Set<string>();
  const parsedSystemNotes = artifact.systemNotes.map((entry) => {
    if (!entry.path.startsWith("migrations/system/")) {
      throw new Error(`System migration release artifact contains non-system note ${entry.path}`);
    }
    if (paths.has(entry.path)) {
      throw new Error(`System migration release artifact contains duplicate note ${entry.path}`);
    }
    paths.add(entry.path);
    return parseMigrationNote(entry.path, entry.markdown);
  });
  return { ...artifact, parsedSystemNotes };
}
