import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  templateAuthoringInspectionSchema,
  templatePublicationSchema,
  type TemplateAuthoringInspection,
  type TemplateInspection,
  type TemplateLocator,
  type TemplateOperation,
  type TemplatePublication,
  type TemplateStatusRow,
  type TemplatesClient,
} from "@vibestudio/service-schemas/templates";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
} from "./commandTable.js";
import { loadCliCredentials } from "./credentialStore.js";
import { AuthError, jsonMode, printError, printResult, UsageError } from "./output.js";
import { RpcClient } from "./rpcClient.js";
import { createTemplateComposerClient } from "./templateComposerClient.js";

const COMMAND_ID: FlagSpec = {
  name: "command-id",
  takesValue: true,
  description: "Stable retry identity (generated and printed when omitted)",
};
const CATALOG: FlagSpec = { name: "catalog", takesValue: true, description: "Catalog template id" };
const CREDENTIAL: FlagSpec = {
  name: "credential",
  takesValue: true,
  description: "Logical credential name declared for a direct template URL",
};
const REFRESH: FlagSpec = {
  name: "refresh",
  takesValue: false,
  description: "Refresh the verified registry before listing it",
};
const ALIAS: FlagSpec = { name: "alias", takesValue: true, description: "Installed template name" };
const TO_REF: FlagSpec = { name: "to-ref", takesValue: true, description: "Version to propose" };
const CHOICE: FlagSpec = {
  name: "choice",
  takesValue: true,
  multiple: true,
  description: "Conflict choice: PART=keep|take|skip (repeatable)",
};
const PART: FlagSpec = {
  name: "part",
  takesValue: true,
  multiple: true,
  description: "Workspace part to include (repeatable)",
};
const PARENT: FlagSpec = {
  name: "parent",
  takesValue: true,
  multiple: true,
  description: "Exact parent pin or publication receipt JSON file (repeatable)",
};
const NAME: FlagSpec = {
  name: "name",
  takesValue: true,
  description: "Human-readable template name",
};
const DESCRIPTION: FlagSpec = {
  name: "description",
  takesValue: true,
  description: "Template or repository description",
};
const VERSION: FlagSpec = {
  name: "version",
  takesValue: true,
  description: "Immutable release version",
};
const PROVIDER: FlagSpec = {
  name: "provider",
  takesValue: true,
  description: "Connected Git publication provider (defaults to github)",
};
const REPOSITORY: FlagSpec = {
  name: "repository",
  takesValue: true,
  description: "Destination repository name",
};
const OWNER: FlagSpec = {
  name: "owner",
  takesValue: true,
  description: "Exact destination account or organization",
};
const PRIVATE: FlagSpec = {
  name: "private",
  takesValue: false,
  description: "Create a private repository (public by default)",
};
const CREDENTIAL_ID: FlagSpec = {
  name: "credential-id",
  takesValue: true,
  description: "Explicit connected-account credential id",
};
const RECEIPT: FlagSpec = {
  name: "receipt",
  takesValue: true,
  description: "Save the exact JSON receipt to a new local file",
};
const SECTION: FlagSpec = {
  name: "section",
  takesValue: true,
  description: "Suggestion section: trust or providers",
};
const DECISION: FlagSpec = {
  name: "decision",
  takesValue: true,
  description: "Suggestion decision: accept or decline",
};
const BUILD_FAILURE: FlagSpec = {
  name: "on-build-failure",
  takesValue: true,
  description: "Failed build handling: retain or discard (defaults to retain)",
};
function requireClient(): { rpc: RpcClient; templates: TemplatesClient } {
  const credentials = loadCliCredentials();
  if (!credentials)
    throw new AuthError('not paired — run `vibestudio remote pair "<pair-link>"` first');
  if (!credentials.workspaceName) {
    throw new AuthError(
      "no remote workspace selected — run `vibestudio remote select <workspace>`"
    );
  }
  const rpc = new RpcClient(credentials);
  return { rpc, templates: createTemplateComposerClient(rpc) };
}

async function withTemplates<T>(run: (templates: TemplatesClient) => Promise<T>): Promise<T> {
  const { rpc, templates } = requireClient();
  try {
    return await run(templates);
  } finally {
    await rpc.close().catch(() => undefined);
  }
}

function commandId(inv: ParsedInvocation): string {
  const explicit = inv.flags["command-id"];
  if (typeof explicit === "string") return explicit;
  const generated = `cli:${randomUUID()}`;
  console.error(`[vibestudio] command-id: ${generated}`);
  return generated;
}

function target(inv: ParsedInvocation, registryRevision?: string): TemplateLocator {
  const catalogId = inv.flags["catalog"];
  const credential =
    typeof inv.flags["credential"] === "string" ? inv.flags["credential"].trim() : undefined;
  if (typeof catalogId === "string" && catalogId.trim()) {
    if (credential) throw new UsageError("--credential is only valid with a direct template URL");
    if (!registryRevision) {
      throw new UsageError("catalog selections must be bound to a verified registry revision");
    }
    return { catalogId: catalogId.trim(), registryRevision };
  }
  const raw = inv.positionals[0]?.trim();
  if (!raw) throw new UsageError("pass a template URL or alias, or --catalog ID");
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" &&
      url.protocol !== "http:" &&
      url.protocol !== "git+https:" &&
      url.protocol !== "git+http:"
    ) {
      throw new Error("scheme");
    }
    return { url: raw, ...(credential ? { credential } : {}) };
  } catch {
    if (credential) throw new UsageError("--credential is only valid with a direct template URL");
    return { alias: raw };
  }
}

async function resolvedTarget(
  templates: TemplatesClient,
  inv: ParsedInvocation
): Promise<TemplateLocator> {
  if (typeof inv.flags["catalog"] !== "string") return target(inv);
  const catalog = await templates.catalog();
  return target(inv, catalog.revision);
}

function requireAlias(inv: ParsedInvocation): string {
  const flagged = inv.flags["alias"];
  const value = typeof flagged === "string" ? flagged : inv.positionals[0];
  if (!value?.trim()) throw new UsageError("pass a template name");
  return value.trim();
}

function requireOperationId(inv: ParsedInvocation): string {
  const value = inv.positionals[0];
  if (!value?.trim()) throw new UsageError("pass an operation id");
  return value.trim();
}

function buildFailureMode(inv: ParsedInvocation): "retain-context" | "discard-context" {
  const value = inv.flags["on-build-failure"];
  if (value === undefined || value === "retain") return "retain-context";
  if (value === "discard") return "discard-context";
  throw new UsageError("--on-build-failure must be retain or discard");
}

function choices(inv: ParsedInvocation): Record<string, "keep" | "take" | "skip"> | undefined {
  const result: Record<string, "keep" | "take" | "skip"> = {};
  for (const raw of inv.flagsMulti("choice")) {
    const equal = raw.indexOf("=");
    const part = equal === -1 ? "" : raw.slice(0, equal).trim();
    const value = equal === -1 ? "" : raw.slice(equal + 1);
    if (!part || (value !== "keep" && value !== "take" && value !== "skip")) {
      throw new UsageError("--choice must be PART=keep, PART=take, or PART=skip");
    }
    result[part] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function requiredFlag(inv: ParsedInvocation, name: string): string {
  const value = inv.flags[name];
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`--${name} is required`);
  return value.trim();
}

function authoringPlan(inv: ParsedInvocation): TemplateAuthoringInspection {
  const path = inv.positionals[0]?.trim();
  if (!path) throw new UsageError("pass the authoring receipt JSON file");
  if (inv.positionals.length > 1)
    throw new UsageError("pass exactly one authoring receipt JSON file");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `Could not read authoring receipt ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const parsed = templateAuthoringInspectionSchema.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(`Invalid authoring receipt ${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parentPin(path: string): WorkspaceTemplatePin {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `Could not read parent receipt ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const pin = WorkspaceTemplatePinSchema.safeParse(value);
  if (pin.success) return pin.data;
  const publication = templatePublicationSchema.safeParse(value);
  if (publication.success) {
    return WorkspaceTemplatePinSchema.parse({
      url: publication.data.templateUrl,
      ref: publication.data.ref,
      commit: publication.data.commit,
      snapshot: publication.data.snapshot,
    });
  }
  throw new UsageError(
    `Invalid parent receipt ${path}: expected an exact template pin or publication result`
  );
}

function version(ref: string): string {
  const value = ref.split("/").filter(Boolean).at(-1);
  return value || ref;
}

function renderAuthoringPlan(plan: TemplateAuthoringInspection): void {
  console.log(`${plan.request.name} authoring receipt ${plan.fingerprint}`);
  console.log(`  protected main: ${plan.mainEventId}`);
  console.log(`  requested: ${plan.requestedParts.join(", ")}`);
  console.log(`  included: ${plan.includedParts.join(", ")}`);
  if (plan.requiredParts.length) console.log(`  required: ${plan.requiredParts.join(", ")}`);
  if (plan.inheritedParts.length) console.log(`  inherited: ${plan.inheritedParts.join(", ")}`);
  console.log(`  manifest: ${plan.manifestDigest}`);
}

function renderPublication(publication: TemplatePublication): void {
  console.log(`${publication.templateUrl} @ ${version(publication.ref)}`);
  console.log(`  commit: ${publication.commit}`);
  console.log(`  snapshot: ${publication.snapshot}`);
  console.log(`  parts: ${publication.parts.join(", ")}`);
}

function saveAuthoringPlan(inv: ParsedInvocation, plan: TemplateAuthoringInspection): void {
  const path = inv.flags["receipt"];
  if (typeof path !== "string") return;
  if (!path.trim()) throw new UsageError("--receipt requires a file path");
  try {
    writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw new UsageError(
      `Could not save authoring receipt ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  console.error(`[vibestudio] authoring receipt: ${path}`);
}

function renderStatus(rows: TemplateStatusRow[]): void {
  if (rows.length === 0) {
    console.log("No committed template relationships yet.");
    return;
  }
  for (const row of rows) {
    const state =
      row.verification === "deferred"
        ? "available offline — check for updates when connected"
        : row.state === "current"
          ? "up to date"
          : row.state === "update-available"
            ? "update available"
            : row.state === "reviewing"
              ? `reviewing changes${row.pendingReviews ? ` — ${row.pendingReviews} to review` : ""}`
              : row.state === "local-changes"
                ? "local changes"
                : row.state === "waiting-for-credential"
                  ? "connect an account to finish"
                  : row.state === "conflict"
                    ? "needs a choice"
                    : "needs attention";
    console.log(`  ${row.alias} template  ${version(row.ref)}  ${state}`);
    if (row.review?.items.length) {
      if (!row.review.approvalGranted) {
        console.log("    review: awaiting approval before VCS changes can be reviewed");
      } else {
        for (const item of row.review.items) {
          console.log(
            `    review ${item.repoPath}: vibestudio vcs compare --context ${row.review.contextId} --delta ${item.deltaId}`
          );
        }
      }
    }
    if (row.blocker?.nextAction === "connect-credential" && row.blocker.credential) {
      console.log(`    ${row.blocker.message}`);
      console.log(
        `    next: open Templates in Vibestudio, choose Connect account, then rerun this command`
      );
    }
    for (const suggestion of row.suggestions) {
      console.log(`    suggested ${suggestion.section}: ${JSON.stringify(suggestion.value)}`);
      console.log(
        `      decide: vibestudio templates decide-suggestion ${row.alias} --section ${suggestion.section} --decision accept|decline`
      );
    }
    if (row.error) console.log(`    ${row.error}`);
  }
}

function renderInspection(result: TemplateInspection): void {
  console.log(
    `Adds ${result.addedParts.length} new ${result.addedParts.length === 1 ? "part" : "parts"}.`
  );
  if (result.conflicts.length) {
    console.log(
      `${result.conflicts.length} ${result.conflicts.length === 1 ? "choice" : "choices"} need your review:`
    );
    for (const conflict of result.conflicts) {
      console.log(
        `  ${conflict.repoPath} — both ${conflict.claimants.join(" and ")} include this part; rerun add with --choice ${conflict.repoPath}=keep|take|skip`
      );
    }
  }
  for (const suggestion of result.excludedSuggestions) {
    console.log(
      `Suggested ${suggestion.section} from ${suggestion.alias}: ${JSON.stringify(suggestion.value)}`
    );
  }
}

function renderPending(operation: TemplateOperation): void {
  if (operation.state !== "pending" && operation.state !== "applied") {
    console.log(
      operation.blocker?.message ??
        "This template operation needs attention before it can continue."
    );
    if (operation.blocker?.nextAction === "connect-credential") {
      console.log(
        `Next: open Templates in Vibestudio, choose Connect account, then run vibestudio templates resume ${operation.operationId}.`
      );
    }
    return;
  }
  if (operation.state === "applied" && operation.contribution) {
    console.log(`Suggestion ready on ${operation.contribution.branch}.`);
    if (operation.contribution.url) console.log(`Open it: ${operation.contribution.url}`);
    return;
  }
  console.log("The approved operation remains isolated until its review is complete.");
  if (operation.review?.items.length) {
    console.log(
      `${operation.review.items.length} ${operation.review.items.length === 1 ? "part is" : "parts are"} ready for VCS review.`
    );
  }
}

function renderOperations(operations: Awaited<ReturnType<TemplatesClient["operations"]>>): void {
  if (operations.length === 0) {
    console.log("No template operations are waiting.");
    return;
  }
  for (const operation of operations) {
    console.log(`  ${operation.operationId}  ${operation.kind}  ${operation.state}`);
    for (const item of operation.review?.items ?? []) {
      console.log(
        `    review ${item.repoPath}: vibestudio vcs compare --context ${operation.contextId} --delta ${item.deltaId}`
      );
    }
  }
}

function suggestionSection(inv: ParsedInvocation): "trust" | "providers" {
  const value = inv.flags["section"];
  if (value === "trust" || value === "providers") return value;
  throw new UsageError("--section must be trust or providers");
}

function suggestionDecision(inv: ParsedInvocation): "accept" | "decline" {
  const value = inv.flags["decision"];
  if (value === "accept" || value === "decline") return value;
  throw new UsageError("--decision must be accept or decline");
}

function run<T>(
  inv: ParsedInvocation,
  operation: (templates: TemplatesClient) => Promise<T>,
  render: (value: T) => void
): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  return withTemplates(operation)
    .then((value) => {
      printResult(value, { json, human: () => render(value) });
      return 0;
    })
    .catch((error) => printError(error, { json }));
}

export const templatesCommands: CliCommand[] = [
  {
    group: "templates",
    name: "author-parts",
    summary: "List protected-main parts available for template authoring",
    flags: [JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (templates) => templates.authoringParts(),
        (parts) => {
          for (const part of parts) {
            const metadata = [part.packageName, part.templateAlias && `from ${part.templateAlias}`]
              .filter(Boolean)
              .join(" · ");
            console.log(`  ${part.repoPath}${metadata ? ` — ${metadata}` : ""}`);
          }
        }
      ),
  },
  {
    group: "templates",
    name: "author-inspect",
    summary: "Create an exact template authoring receipt without publishing",
    usage:
      "vibestudio templates author-inspect --name NAME --description TEXT --part PATH [--part PATH] [--parent RECEIPT.json] [--receipt FILE] [--json]",
    flags: [NAME, DESCRIPTION, PART, PARENT, RECEIPT, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        async (templates) => {
          if (inv.positionals.length) {
            throw new UsageError(
              "author-inspect accepts selections through flags, not positionals"
            );
          }
          const parts = inv
            .flagsMulti("part")
            .map((part) => part.trim())
            .filter(Boolean);
          if (!parts.length) throw new UsageError("pass at least one --part");
          const parents = inv
            .flagsMulti("parent")
            .map((parent) => parent.trim())
            .filter(Boolean)
            .map(parentPin);
          const plan = await templates.inspectAuthoring({
            name: requiredFlag(inv, "name"),
            description: requiredFlag(inv, "description"),
            parts,
            ...(parents.length ? { parents } : {}),
          });
          saveAuthoringPlan(inv, plan);
          return plan;
        },
        renderAuthoringPlan
      ),
  },
  {
    group: "templates",
    name: "author-publish",
    summary: "Publish an unchanged authoring receipt as an immutable Git template",
    usage:
      "vibestudio templates author-publish RECEIPT.json --version VERSION --owner OWNER --repository NAME [--private] [--credential-id ID]",
    flags: [
      VERSION,
      OWNER,
      REPOSITORY,
      PROVIDER,
      PRIVATE,
      DESCRIPTION,
      CREDENTIAL_ID,
      COMMAND_ID,
      JSON_FLAG,
    ],
    run: (inv) =>
      run(
        inv,
        (templates) =>
          templates.publishAuthoring({
            commandId: commandId(inv),
            plan: authoringPlan(inv),
            version: requiredFlag(inv, "version"),
            destination: {
              provider:
                typeof inv.flags["provider"] === "string" ? inv.flags["provider"].trim() : "github",
              owner: requiredFlag(inv, "owner"),
              name: requiredFlag(inv, "repository"),
            },
            creation: {
              private: inv.flags["private"] === true,
              ...(typeof inv.flags["description"] === "string"
                ? { description: inv.flags["description"] }
                : {}),
            },
            ...(typeof inv.flags["credential-id"] === "string"
              ? { credentialId: inv.flags["credential-id"].trim() }
              : {}),
          }),
        renderPublication
      ),
  },
  {
    group: "templates",
    name: "status",
    summary: "Show the templates connected to this workspace",
    flags: [JSON_FLAG],
    run: (inv) => run(inv, (templates) => templates.status(), renderStatus),
  },
  {
    group: "templates",
    name: "catalog",
    summary: "List templates from the verified workspace registry",
    flags: [REFRESH, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (templates) =>
          inv.flags["refresh"] === true
            ? templates.catalog({ refresh: true })
            : templates.catalog(),
        (catalog) => {
          console.log(`Registry ${catalog.revision}${catalog.stale ? " (cached)" : ""}`);
          for (const entry of catalog.entries)
            console.log(`  ${entry.id} — ${entry.name}: ${entry.description}`);
        }
      ),
  },
  {
    group: "templates",
    name: "check",
    summary: "Check for template updates",
    usage: "vibestudio templates check [ALIAS]",
    flags: [ALIAS, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (templates) => {
          const alias =
            typeof inv.flags["alias"] === "string" ? inv.flags["alias"] : inv.positionals[0];
          return alias ? templates.check({ alias }) : templates.check();
        },
        (candidates) => {
          if (candidates.length === 0) console.log("All checked templates are up to date.");
          for (const candidate of candidates) {
            console.log(
              `  ${candidate.alias} template  ${version(candidate.currentRef)} → ${version(candidate.candidateRef)}`
            );
          }
        }
      ),
  },
  {
    group: "templates",
    name: "inspect",
    summary: "Check what a template would add without changing your workspace",
    usage: "vibestudio templates inspect URL_OR_ALIAS [--catalog ID] [--credential NAME]",
    flags: [CATALOG, CREDENTIAL, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        async (templates) => templates.inspect(await resolvedTarget(templates, inv)),
        renderInspection
      ),
  },
  {
    group: "templates",
    name: "add",
    summary: "Ask to add a template after inspecting it",
    usage:
      "vibestudio templates add URL_OR_ALIAS [--catalog ID] [--credential NAME] [--choice PART=keep|take|skip]",
    flags: [CATALOG, CREDENTIAL, CHOICE, COMMAND_ID, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        async (templates) => {
          const selected = choices(inv);
          const locator = await resolvedTarget(templates, inv);
          const inspection = await templates.inspect(locator);
          return templates.add({
            commandId: commandId(inv),
            pin: inspection.pin,
            ...(selected ? { choices: selected } : {}),
          });
        },
        renderPending
      ),
  },
  {
    group: "templates",
    name: "pull",
    summary: "Ask to update one template",
    usage: "vibestudio templates pull ALIAS [--to-ref VERSION]",
    flags: [TO_REF, COMMAND_ID, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (templates) =>
          templates.pull({
            commandId: commandId(inv),
            alias: requireAlias(inv),
            ...(typeof inv.flags["to-ref"] === "string" ? { toRef: inv.flags["to-ref"] } : {}),
          }),
        renderPending
      ),
  },
  {
    group: "templates",
    name: "remove",
    summary: "Ask to remove a template relationship",
    usage: "vibestudio templates remove ALIAS",
    flags: [COMMAND_ID, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (templates) => templates.remove({ commandId: commandId(inv), alias: requireAlias(inv) }),
        renderPending
      ),
  },
  {
    group: "templates",
    name: "suggest",
    summary: "Ask to suggest local changes back to a template",
    usage: "vibestudio templates suggest ALIAS [--part PART]",
    flags: [PART, COMMAND_ID, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (templates) =>
          templates.suggest({
            commandId: commandId(inv),
            alias: requireAlias(inv),
            ...(inv.flagsMulti("part").length ? { parts: inv.flagsMulti("part") } : {}),
          }),
        renderPending
      ),
  },
  {
    group: "templates",
    name: "operations",
    summary: "List template operations that can be reviewed, resumed, or cancelled",
    flags: [JSON_FLAG],
    run: (inv) => run(inv, (templates) => templates.operations(), renderOperations),
  },
  {
    group: "templates",
    name: "resume",
    summary: "Resume an exact pending template operation",
    usage: "vibestudio templates resume OPERATION_ID",
    flags: [BUILD_FAILURE, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (templates) =>
          templates.resume({
            operationId: requireOperationId(inv),
            onBuildFailure: buildFailureMode(inv),
          }),
        renderPending
      ),
  },
  {
    group: "templates",
    name: "cancel",
    summary: "Discard an in-flight template operation",
    usage: "vibestudio templates cancel OPERATION_ID",
    flags: [JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (templates) => templates.cancel({ operationId: requireOperationId(inv) }),
        (result) => console.log(`Template operation ${result.operationId} discarded.`)
      ),
  },
  {
    group: "templates",
    name: "decide-suggestion",
    summary: "Accept or decline one exact template setup suggestion",
    usage:
      "vibestudio templates decide-suggestion ALIAS --section trust|providers --decision accept|decline",
    flags: [SECTION, DECISION, COMMAND_ID, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (templates) =>
          templates.decideSuggestion({
            commandId: commandId(inv),
            alias: requireAlias(inv),
            section: suggestionSection(inv),
            decision: suggestionDecision(inv),
          }),
        (result) =>
          console.log(
            `${result.section} suggestion ${result.state === "accepted" ? "accepted" : "declined"}.`
          )
      ),
  },
];
