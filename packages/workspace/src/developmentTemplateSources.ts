import { z } from "zod";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";

export const DEVELOPMENT_TEMPLATE_SOURCES_ENV = "VIBESTUDIO_DEV_TEMPLATE_SOURCES" as const;
export const DEVELOPMENT_TEMPLATE_SOURCES_ENABLED_ENV =
  "VIBESTUDIO_DEV_TEMPLATE_SOURCES_ENABLED" as const;

export interface DevelopmentTemplateSource {
  pin: WorkspaceTemplatePin;
  checkout: string;
}

const DevelopmentTemplateSourcesSchema = z.array(
  z
    .object({
      pin: WorkspaceTemplatePinSchema,
      checkout: z.string().trim().min(1),
    })
    .strict()
);

/**
 * Read host-selected local acquisition sources. They are deliberately valid
 * only in a development process: durable template identity remains the exact
 * pin, while the checkout is an ephemeral transport for that pin's bytes.
 */
export function readDevelopmentTemplateSources(
  environment: NodeJS.ProcessEnv = process.env
): DevelopmentTemplateSource[] {
  const raw = environment[DEVELOPMENT_TEMPLATE_SOURCES_ENV]?.trim();
  if (!raw) return [];
  if (
    environment["NODE_ENV"] !== "development" &&
    environment[DEVELOPMENT_TEMPLATE_SOURCES_ENABLED_ENV] !== "1"
  ) {
    throw new Error("Local template checkout sources require an explicit source launch");
  }
  const sources = DevelopmentTemplateSourcesSchema.parse(JSON.parse(raw));
  const exactCoordinates = new Set<string>();
  for (const source of sources) {
    const coordinate = JSON.stringify([source.pin.url, source.pin.commit, source.pin.snapshot]);
    if (exactCoordinates.has(coordinate)) {
      throw new Error(
        `Development template source is selected more than once: ${source.pin.url} at ${source.pin.commit}`
      );
    }
    exactCoordinates.add(coordinate);
  }
  return sources;
}
