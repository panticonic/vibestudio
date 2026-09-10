import { z } from "zod";
import {
  WorkspaceSourceSchema,
  type WorkspaceSource,
} from "@vibestudio/workspace-contracts/workspaceSource";

export { WorkspaceSourceSchema, type WorkspaceSource };

export const WORKSPACE_SOURCES_ENV = "VIBESTUDIO_WORKSPACE_SOURCES" as const;

const WorkspaceSourcesSchema = z.array(WorkspaceSourceSchema);

export function serializeWorkspaceSources(sources: readonly WorkspaceSource[]): string {
  return JSON.stringify(WorkspaceSourcesSchema.parse(sources));
}

/**
 * Read host-selected local acquisition sources. They are valid
 * in every host mode: durable source identity remains the exact pin, while the
 * checkout is an owned transport for those bytes. The native picker and hub
 * authorize registration; environment inheritance is host-to-child transport.
 */
export function readWorkspaceSources(
  environment: NodeJS.ProcessEnv = process.env
): WorkspaceSource[] {
  const raw = environment[WORKSPACE_SOURCES_ENV]?.trim();
  if (!raw) return [];
  const sources = WorkspaceSourcesSchema.parse(JSON.parse(raw));
  const exactCoordinates = new Set<string>();
  for (const source of sources) {
    const coordinate = JSON.stringify([source.pin.url, source.pin.commit]);
    if (exactCoordinates.has(coordinate)) {
      throw new Error(
        `Workspace source is selected more than once: ${source.pin.url} at ${source.pin.commit}`
      );
    }
    exactCoordinates.add(coordinate);
  }
  return sources;
}
