import type {
  TemplateAddRequest,
  TemplateExactPin,
  TemplateInspection,
  TemplateLocator,
  TemplateOperation,
  TemplateStatusRow,
} from "@vibestudio/service-schemas/templates";
import type { TemplateCatalogSnapshot } from "@workspace/template-registry";

const TEMPLATE_COMPOSER = "@workspace-extensions/template-composer";

export interface TemplatePendingOperation {
  operationId: string;
  kind: "add" | "adopt" | "pull" | "remove" | "recompose" | "adopt-bootstrap" | "publish-authoring";
  contextId: string;
  initiator: "user" | "host-release";
  target?: { alias: string; ref?: string };
  state: "pending" | "reviewing" | "repairing";
  fingerprint: string;
  migration?: NonNullable<TemplateOperation["migration"]>;
  review?: NonNullable<TemplateOperation["review"]>;
  repair?: NonNullable<TemplateOperation["repair"]>;
}

export function templateOperationTitle(operation: TemplatePendingOperation): string {
  const alias = operation.target?.alias ?? "workspace";
  const release = operation.target?.ref?.replace(/^refs\/(?:heads|tags)\//u, "");
  return release ? `${alias} · ${release}` : alias;
}

export function templateOperationStage(operation: TemplatePendingOperation): string {
  if (operation.state === "repairing") return "Repair needed";
  if (operation.state === "reviewing") return "Reviewing changes";
  return "Ready to continue";
}

export function templateMigrationPrompt(operation: TemplatePendingOperation): string {
  if (!operation.migration) {
    throw new Error(`Template operation ${operation.operationId} is not a migration`);
  }
  const notes = operation.migration.notes.length
    ? operation.migration.notes.map((note) => `- ${note.path}: ${note.title}`).join("\n")
    : `- Read every current note under ${operation.migration.facets
        .map((facet) => `migrations/${facet}/`)
        .join(", ")}`;
  return [
    `Continue the retained ${templateOperationTitle(operation)} template migration represented by this conversation.`,
    "Use the Templates skill and work only in this operation's existing retained context.",
    "Find the Composer operation bound to this repair context and use its operationId only for service calls; do not repeat internal identifiers to the user.",
    "Inspect the actual workspace, repair every applicable target contract idempotently, run each note's verify instruction and the normal affected gates, record the evidence in this conversation, and resume only when everything is green.",
    "",
    "Incoming living contract notes:",
    notes,
  ].join("\n");
}

export interface TemplateManagementClient {
  status(): Promise<TemplateStatusRow[]>;
  catalog(options?: { refresh?: boolean }): Promise<TemplateCatalogSnapshot | null>;
  check(options?: { alias?: string }): Promise<Array<{ alias: string }>>;
  inspect(locator: TemplateLocator): Promise<TemplateInspection>;
  add(input: { commandId: string; source: TemplateAddRequest }): Promise<TemplateOperation>;
  adopt(input: { commandId: string; pin: TemplateExactPin }): Promise<TemplateOperation>;
  pull(input: {
    commandId: string;
    alias: string;
    toRef?: string;
    pin?: TemplateExactPin;
  }): Promise<TemplateOperation>;
  remove(input: { commandId: string; alias: string }): Promise<TemplateOperation>;
  suggest(input: {
    commandId: string;
    alias: string;
    parts?: string[];
  }): Promise<TemplateOperation>;
  operations(): Promise<TemplatePendingOperation[]>;
  resume(input: { operationId: string }): Promise<TemplateOperation>;
  cancel(input: { operationId: string }): Promise<{ operationId: string; state: "cancelled" }>;
  decideSuggestion(input: {
    commandId: string;
    alias: string;
    section: "trust" | "providers";
    decision: "accept" | "decline";
  }): Promise<{
    operationId: string;
    state: "accepted" | "declined";
    section: "trust" | "providers";
    publicationEventId?: string;
  }>;
}

export function createTemplateManagementClient(
  invoke: (extension: string, method: string, args: unknown[]) => Promise<unknown>
): TemplateManagementClient {
  return {
    status: () => invoke(TEMPLATE_COMPOSER, "status", []) as Promise<TemplateStatusRow[]>,
    catalog: (options) =>
      invoke(
        TEMPLATE_COMPOSER,
        "catalog",
        options ? [options] : []
      ) as Promise<TemplateCatalogSnapshot | null>,
    check: (options) =>
      invoke(TEMPLATE_COMPOSER, "check", options ? [options] : []) as Promise<
        Array<{ alias: string }>
      >,
    inspect: (locator) =>
      invoke(TEMPLATE_COMPOSER, "inspect", [locator]) as Promise<TemplateInspection>,
    add: (input) => invoke(TEMPLATE_COMPOSER, "add", [input]) as Promise<TemplateOperation>,
    adopt: (input) => invoke(TEMPLATE_COMPOSER, "adopt", [input]) as Promise<TemplateOperation>,
    pull: (input) => invoke(TEMPLATE_COMPOSER, "pull", [input]) as Promise<TemplateOperation>,
    remove: (input) => invoke(TEMPLATE_COMPOSER, "remove", [input]) as Promise<TemplateOperation>,
    suggest: (input) => invoke(TEMPLATE_COMPOSER, "suggest", [input]) as Promise<TemplateOperation>,
    operations: () =>
      invoke(TEMPLATE_COMPOSER, "operations", []) as Promise<TemplatePendingOperation[]>,
    resume: (input) => invoke(TEMPLATE_COMPOSER, "resume", [input]) as Promise<TemplateOperation>,
    cancel: (input) =>
      invoke(TEMPLATE_COMPOSER, "cancel", [input]) as Promise<{
        operationId: string;
        state: "cancelled";
      }>,
    decideSuggestion: (input) =>
      invoke(TEMPLATE_COMPOSER, "decideSuggestion", [input]) as Promise<{
        operationId: string;
        state: "accepted" | "declined";
        section: "trust" | "providers";
        publicationEventId?: string;
      }>,
  };
}
