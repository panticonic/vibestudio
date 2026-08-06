import type {
  TemplateAddPreparation,
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
  kind: "add" | "pull" | "remove" | "recompose" | "adopt-bootstrap" | "publish-authoring";
  contextId: string;
  state: "pending" | "reviewing";
  fingerprint: string;
  review?: NonNullable<TemplateOperation["review"]>;
}

export interface TemplateManagementClient {
  status(): Promise<TemplateStatusRow[]>;
  catalog(options?: { refresh?: boolean }): Promise<TemplateCatalogSnapshot>;
  check(options?: { alias?: string }): Promise<Array<{ alias: string }>>;
  inspect(locator: TemplateLocator): Promise<TemplateInspection>;
  prepareAdd(request: TemplateAddRequest): Promise<TemplateAddPreparation>;
  add(input: {
    commandId: string;
    pin: TemplateExactPin;
    choices?: Record<string, "keep" | "take" | "skip">;
  }): Promise<TemplateOperation>;
  pull(input: {
    commandId: string;
    alias: string;
    toRef?: string;
    onBuildFailure?: "discard-context" | "retain-context";
  }): Promise<TemplateOperation>;
  remove(input: {
    commandId: string;
    alias: string;
    onBuildFailure?: "discard-context" | "retain-context";
  }): Promise<TemplateOperation>;
  suggest(input: {
    commandId: string;
    alias: string;
    parts?: string[];
  }): Promise<TemplateOperation>;
  operations(): Promise<TemplatePendingOperation[]>;
  resume(input: {
    operationId: string;
    onBuildFailure?: "discard-context" | "retain-context";
  }): Promise<TemplateOperation>;
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
      ) as Promise<TemplateCatalogSnapshot>,
    check: (options) =>
      invoke(TEMPLATE_COMPOSER, "check", options ? [options] : []) as Promise<
        Array<{ alias: string }>
      >,
    inspect: (locator) =>
      invoke(TEMPLATE_COMPOSER, "inspect", [locator]) as Promise<TemplateInspection>,
    prepareAdd: (request) =>
      invoke(TEMPLATE_COMPOSER, "prepareAdd", [request]) as Promise<TemplateAddPreparation>,
    add: (input) => invoke(TEMPLATE_COMPOSER, "add", [input]) as Promise<TemplateOperation>,
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
