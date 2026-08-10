import type { TemplateStatusRow } from "@vibestudio/service-schemas/templates";

export interface OptionalTemplateDefinition {
  id: string;
  title: string;
  summary: string;
  url: string;
}

export interface OptionalTemplateSnapshot {
  id: string;
  state: "available" | "installed" | "unknown";
  summary: string;
  observedAt: string;
}

export const optionalTemplateCatalog: readonly OptionalTemplateDefinition[] = [
  {
    id: "template.examples",
    title: "Examples",
    summary: "Sample panels and workers for learning and experimentation.",
    url: "git+https://github.com/panticonic/vibestudio-template-examples.git",
  },
  {
    id: "template.news",
    title: "News",
    summary: "A news panel, feed tools, and an agent for collecting and briefing news.",
    url: "git+https://github.com/panticonic/vibestudio-template-news.git",
  },
  {
    id: "template.spectrolite",
    title: "Spectrolite",
    summary: "An MDX writing and editing workspace with collaborative agent tooling.",
    url: "git+https://github.com/panticonic/vibestudio-template-spectrolite.git",
  },
] as const;

export interface OptionalTemplateSnapshotDependencies {
  status?: () => Promise<TemplateStatusRow[]>;
  now?: () => Date;
}

async function templateStatus(): Promise<TemplateStatusRow[]> {
  const { extensions } = await import("@workspace/runtime");
  return extensions.invoke("@workspace-extensions/template-composer", "status", []) as Promise<
    TemplateStatusRow[]
  >;
}

export async function composeOptionalTemplateSnapshot(
  dependencies: OptionalTemplateSnapshotDependencies = {}
): Promise<OptionalTemplateSnapshot[]> {
  const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
  try {
    const status = await (dependencies.status ?? templateStatus)();
    const installedUrls = new Set(status.map((entry) => entry.url));
    return optionalTemplateCatalog.map((definition) => ({
      id: definition.id,
      state: installedUrls.has(definition.url) ? "installed" : "available",
      summary: installedUrls.has(definition.url)
        ? "Installed in this workspace."
        : "Available to review and add.",
      observedAt,
    }));
  } catch {
    return optionalTemplateCatalog.map((definition) => ({
      id: definition.id,
      state: "unknown",
      summary: "Installation status could not be read right now.",
      observedAt,
    }));
  }
}

export function optionalTemplateById(id: string): OptionalTemplateDefinition | undefined {
  return optionalTemplateCatalog.find((entry) => entry.id === id);
}
