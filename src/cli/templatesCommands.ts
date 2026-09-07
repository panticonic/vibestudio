import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  templateAuthoringInspectionSchema,
  templatePublicationSchema,
  type TemplateAuthoringInspection,
  type TemplateCatalogSnapshot,
  type TemplateLocator,
  type TemplatePublication,
  type TemplatesClient,
} from "@vibestudio/service-schemas/templates";
import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
} from "./commandTable.js";
import { loadCliCredentials, requireDeviceCliCredentials } from "./credentialStore.js";
import { AuthError, jsonMode, printError, printResult, UsageError } from "./output.js";
import { RpcClient } from "./rpcClient.js";
import { createTemplatesClient } from "./templatesClient.js";

const flag = (name: string, description: string, multiple = false): FlagSpec => ({
  name,
  takesValue: true,
  description,
  ...(multiple ? { multiple: true } : {}),
});
const COMMAND_ID = flag("command-id", "Stable retry identity");
const CATALOG = flag("catalog", "Catalog template id");
const CREDENTIAL = flag("credential", "Logical credential name");
const REFRESH: FlagSpec = {
  name: "refresh",
  takesValue: false,
  description: "Refresh the verified registry",
};
const PART = flag("part", "Workspace repository to include", true);
const NAME = flag("name", "Human-readable template name");
const DESCRIPTION = flag("description", "Template description");
const VERSION = flag("version", "Immutable release version");
const PROVIDER = flag("provider", "Connected Git publication provider");
const REPOSITORY = flag("repository", "Destination repository name");
const OWNER = flag("owner", "Destination account or organization");
const PRIVATE: FlagSpec = {
  name: "private",
  takesValue: false,
  description: "Create a private repository",
};
const CREDENTIAL_ID = flag("credential-id", "Connected-account credential id");
const RECEIPT = flag("receipt", "Save the exact JSON receipt");
const ID = flag("id", "Stable catalog id");
const TAG = flag("tag", "Catalog search tag", true);
const REVISION = flag("revision", "Registry revision (YYYY-MM-DD.N)");
const RECOMMENDED: FlagSpec = {
  name: "recommended",
  takesValue: false,
  description: "Mark catalog entry recommended",
};

function requireClient(): { rpc: RpcClient; templates: TemplatesClient } {
  const credentials = loadCliCredentials();
  if (!credentials)
    throw new AuthError('not paired — run `vibestudio remote pair "<pair-link>"` first');
  if (!credentials.workspaceName) throw new AuthError("no remote workspace selected");
  const rpc = new RpcClient(requireDeviceCliCredentials(credentials, "template management"));
  return { rpc, templates: createTemplatesClient(rpc) };
}
async function withTemplates<T>(fn: (client: TemplatesClient) => Promise<T>): Promise<T> {
  const { rpc, templates } = requireClient();
  try {
    return await fn(templates);
  } finally {
    await rpc.close().catch(() => undefined);
  }
}
function run<T>(
  inv: ParsedInvocation,
  fn: (client: TemplatesClient) => Promise<T>,
  render: (value: T) => void
): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  return withTemplates(fn)
    .then((value) => {
      printResult(value, { json, human: () => render(value) });
      return 0;
    })
    .catch((error) => printError(error, { json }));
}
function requiredFlag(inv: ParsedInvocation, name: string): string {
  const value = inv.flags[name];
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`--${name} is required`);
  return value.trim();
}
function commandId(inv: ParsedInvocation): string {
  const value = inv.flags["command-id"];
  if (typeof value === "string") return value;
  const generated = `cli:${randomUUID()}`;
  console.error(`[vibestudio] command-id: ${generated}`);
  return generated;
}
function readReceipt<T>(
  inv: ParsedInvocation,
  kind: string,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false; error: Error };
  }
): T {
  const path = inv.positionals[0]?.trim();
  if (!path || inv.positionals.length !== 1)
    throw new UsageError(`pass exactly one ${kind} receipt JSON file`);
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  } catch (error) {
    throw new UsageError(
      `Could not read ${kind} receipt ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
function saveReceipt(inv: ParsedInvocation, kind: string, value: unknown): void {
  const path = inv.flags["receipt"];
  if (typeof path !== "string") return;
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw new UsageError(
      `Could not save ${kind} receipt ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
function target(inv: ParsedInvocation, catalog?: TemplateCatalogSnapshot): TemplateLocator {
  const catalogId = inv.flags["catalog"];
  if (typeof catalogId === "string") {
    if (!catalog) throw new UsageError("refresh the catalog before selecting an entry");
    return {
      catalogId,
      registryCommit: catalog.coordinates.commit,
      registrySnapshot: catalog.coordinates.snapshot,
    };
  }
  const url = inv.positionals[0]?.trim();
  if (!url) throw new UsageError("pass a template URL or --catalog ID");
  return {
    url,
    ...(typeof inv.flags["credential"] === "string" ? { credential: inv.flags["credential"] } : {}),
  };
}
async function resolvedTarget(
  client: TemplatesClient,
  inv: ParsedInvocation
): Promise<TemplateLocator> {
  if (typeof inv.flags["catalog"] !== "string") return target(inv);
  const catalog = await client.catalog();
  if (!catalog) throw new UsageError("no verified template catalog is cached");
  return target(inv, catalog);
}
function renderPlan(plan: TemplateAuthoringInspection): void {
  console.log(`${plan.request.name} authoring receipt ${plan.fingerprint}`);
  console.log(`  included: ${plan.includedParts.join(", ")}`);
  if (plan.requiredParts.length) console.log(`  required: ${plan.requiredParts.join(", ")}`);
}
function renderPublication(value: TemplatePublication): void {
  console.log(`${value.templateUrl} @ ${value.ref}`);
  console.log(`  commit: ${value.commit}`);
  console.log(`  snapshot: ${value.snapshot}`);
}

export const templatesCommands: CliCommand[] = [
  {
    group: "templates",
    name: "catalog",
    summary: "List upstream workspace snapshots from the verified registry",
    flags: [REFRESH, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (c) => (inv.flags["refresh"] ? c.catalog({ refresh: true }) : c.catalog()),
        (catalog) => {
          if (!catalog)
            return console.log(
              "No verified template registry is cached. Run with --refresh to load it."
            );
          console.log(`Registry ${catalog.revision}`);
          catalog.entries.forEach((entry) =>
            console.log(`  ${entry.id} — ${entry.name}: ${entry.description}`)
          );
        }
      ),
  },
  {
    group: "templates",
    name: "inspect",
    summary: "Resolve and verify an exact upstream workspace snapshot",
    flags: [CATALOG, CREDENTIAL, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        async (c) => c.inspect(await resolvedTarget(c, inv)),
        (result) => {
          console.log(`${result.presentation?.name ?? result.pin.url} @ ${result.pin.commit}`);
          console.log(`  repositories: ${result.repositories.join(", ")}`);
        }
      ),
  },
  {
    group: "templates",
    name: "author-parts",
    summary: "List protected-main repositories available for snapshot authoring",
    flags: [JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        (c) => c.authoringParts(),
        (parts) =>
          parts.forEach((part) =>
            console.log(`  ${part.repoPath}${part.packageName ? ` — ${part.packageName}` : ""}`)
          )
      ),
  },
  {
    group: "templates",
    name: "author-inspect",
    summary: "Create an exact snapshot authoring receipt without publishing",
    flags: [NAME, DESCRIPTION, PART, RECEIPT, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        async (c) => {
          if (inv.positionals.length)
            throw new UsageError("author-inspect accepts selections through flags");
          const parts = inv
            .flagsMulti("part")
            .map((part) => part.trim())
            .filter(Boolean);
          if (!parts.length) throw new UsageError("pass at least one --part");
          const plan = await c.inspectAuthoring({
            name: requiredFlag(inv, "name"),
            description: requiredFlag(inv, "description"),
            parts,
          });
          saveReceipt(inv, "authoring", plan);
          return plan;
        },
        renderPlan
      ),
  },
  {
    group: "templates",
    name: "author-publish",
    summary: "Publish an unchanged receipt as an immutable workspace snapshot",
    flags: [
      VERSION,
      OWNER,
      REPOSITORY,
      PROVIDER,
      PRIVATE,
      DESCRIPTION,
      CREDENTIAL_ID,
      COMMAND_ID,
      RECEIPT,
      JSON_FLAG,
    ],
    run: (inv) =>
      run(
        inv,
        async (c) => {
          const plan = readReceipt(inv, "authoring", templateAuthoringInspectionSchema);
          const publication = await c.publishAuthoring({
            commandId: commandId(inv),
            intent: plan.request,
            expectedFingerprint: plan.fingerprint,
            version: requiredFlag(inv, "version"),
            destination: {
              provider:
                typeof inv.flags["provider"] === "string" ? inv.flags["provider"] : "github",
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
              ? { credentialId: inv.flags["credential-id"] }
              : {}),
          });
          saveReceipt(inv, "publication", publication);
          return publication;
        },
        renderPublication
      ),
  },
  {
    group: "templates",
    name: "registry-suggest",
    summary: "Suggest an exact published snapshot to the verified registry",
    flags: [ID, NAME, DESCRIPTION, TAG, RECOMMENDED, REVISION, CREDENTIAL, COMMAND_ID, JSON_FLAG],
    run: (inv) =>
      run(
        inv,
        async (c) => {
          const tags = inv
            .flagsMulti("tag")
            .map((tag) => tag.trim())
            .filter(Boolean);
          if (!tags.length) throw new UsageError("pass at least one --tag");
          const catalog = await c.catalog({ refresh: true });
          if (!catalog) throw new UsageError("the workspace has no configured template registry");
          return c.suggestRegistryEntry({
            commandId: commandId(inv),
            catalog,
            publication: readReceipt(inv, "publication", templatePublicationSchema),
            ...(typeof inv.flags["credential"] === "string"
              ? { credential: inv.flags["credential"] }
              : {}),
            entry: {
              id: requiredFlag(inv, "id"),
              name: requiredFlag(inv, "name"),
              description: requiredFlag(inv, "description"),
              tags,
              recommended: inv.flags["recommended"] === true,
            },
            revision: requiredFlag(inv, "revision"),
          });
        },
        (result) =>
          console.log(
            result.branch
              ? `Registry suggestion ready on ${result.branch}.`
              : `Registry entry ${result.entry.id} already matches this release.`
          )
      ),
  },
];
