import type { TemplateStatusRow } from "@vibestudio/service-schemas/templates";
import type { TemplateCatalogSnapshot } from "@workspace/template-registry";

export interface OnboardingTemplateSelection {
  catalogId: string;
  registryCommit: string;
  registrySnapshot: string;
}

export interface OptionalTemplateSnapshot {
  id: string;
  title: string;
  description: string;
  state: "available" | "installed" | "unknown";
  summary: string;
  observedAt: string;
  selection: OnboardingTemplateSelection;
}

export interface OptionalTemplateSnapshotDependencies {
  status?: () => Promise<TemplateStatusRow[]>;
  catalog?: (options?: { refresh?: boolean }) => Promise<TemplateCatalogSnapshot | null>;
  refreshCatalog?: boolean;
  now?: () => Date;
}

async function composerStatus(): Promise<TemplateStatusRow[]> {
  const { extensions } = await import("@workspace/runtime");
  return extensions.invoke("@workspace-extensions/template-composer", "status", []) as Promise<
    TemplateStatusRow[]
  >;
}

async function composerCatalog(
  options: { refresh?: boolean } = {}
): Promise<TemplateCatalogSnapshot | null> {
  const { extensions } = await import("@workspace/runtime");
  return extensions.invoke(
    "@workspace-extensions/template-composer",
    "catalog",
    options.refresh ? [{ refresh: true }] : []
  ) as Promise<TemplateCatalogSnapshot | null>;
}

export async function composeOptionalTemplateSnapshot(
  dependencies: OptionalTemplateSnapshotDependencies = {}
): Promise<OptionalTemplateSnapshot[]> {
  try {
    return await loadOptionalTemplateSnapshot(dependencies);
  } catch {
    return [];
  }
}

/** Explicit UI load path. Catalog failures remain visible to the caller. */
export async function loadOptionalTemplateSnapshot(
  dependencies: OptionalTemplateSnapshotDependencies = {}
): Promise<OptionalTemplateSnapshot[]> {
  const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const catalog = await (dependencies.catalog ?? composerCatalog)({
    refresh: dependencies.refreshCatalog ?? true,
  });
  if (!catalog) return [];
  let installedUrls: ReadonlySet<string> | undefined;
  try {
    installedUrls = new Set(
      (await (dependencies.status ?? composerStatus)()).map((entry) => entry.url)
    );
  } catch {
    installedUrls = undefined;
  }
  return catalog.entries
    .filter((entry) => entry.recommended)
    .map((entry) => {
      const state = installedUrls
        ? installedUrls.has(entry.url)
          ? "installed"
          : "available"
        : "unknown";
      return {
        id: `template.${entry.id}`,
        title: entry.name,
        description: entry.description,
        state,
        summary:
          state === "installed"
            ? "Installed in this workspace."
            : state === "available"
              ? "Available to review and add."
              : "Installation status could not be read right now.",
        observedAt,
        selection: {
          catalogId: entry.id,
          registryCommit: catalog.coordinates.commit,
          registrySnapshot: catalog.coordinates.snapshot,
        },
      } satisfies OptionalTemplateSnapshot;
    });
}
