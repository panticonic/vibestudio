import { contextId, fs, vcs } from "@workspace/runtime";
import {
  PROJECT_TYPES,
  assertProjectIdentity,
  preflightProjectFiles,
  serializeProjectManifest,
  type ProjectPreflightReport,
  type ProjectType,
} from "./project-manifest.js";

export interface ProjectPublication {
  published: true;
  committedEventId: string;
  publishedEventId: string;
  mainEventId: string;
  effectId: string;
  appliedAt: string;
}

export interface ScaffoldPublicationFailureData {
  code: "scaffold_publication_failed";
  stage: "push";
  created: string;
  files: string[];
  committedEventId: string;
  published: false;
  publicationRequest: {
    contextId: string;
    expectedCommittedEventId: string;
    expectedMainEventId: string;
    commandId: string;
  };
  vcsError: {
    code: string;
    message: string;
    errorData?: unknown;
  };
  retry: {
    operation: "vcs.push";
    statusRequest: { contextId: string };
    commandIdPolicy:
      | "reuse-identical-only-if-outcome-uncertain"
      | "reobserve-status-and-use-new-command"
      | "stop-integrity-investigation";
  };
}

export class ScaffoldPublicationError extends Error {
  readonly errorData: ScaffoldPublicationFailureData;

  constructor(errorData: ScaffoldPublicationFailureData, cause: unknown) {
    super(
      `Project ${errorData.created} was committed as ${errorData.committedEventId} ` +
        `but protected publication failed: ${errorData.vcsError.message}`,
      { cause }
    );
    this.name = "ScaffoldPublicationError";
    this.errorData = errorData;
  }
}

export interface ScaffoldPublicationRecoveryFailureData {
  code: "scaffold_publication_recovery_failed";
  stage: "validate-receipt" | "validate-context" | "push";
  created: string;
  committedEventId: string;
  publicationRequest: ScaffoldPublicationFailureData["publicationRequest"];
  observedStatus?: unknown;
  cause: { code: string; message: string; errorData?: unknown };
  retry: { operation: "recoverProjectPublication"; safeToRerun: boolean };
}

export class ScaffoldPublicationRecoveryError extends Error {
  readonly errorData: ScaffoldPublicationRecoveryFailureData;

  constructor(errorData: ScaffoldPublicationRecoveryFailureData, cause?: unknown) {
    super(
      `Cannot recover publication for ${errorData.created} at ${errorData.stage}: ` +
        errorData.cause.message,
      cause === undefined ? undefined : { cause }
    );
    this.name = "ScaffoldPublicationRecoveryError";
    this.errorData = errorData;
  }
}

function errorDetail(error: unknown): {
  code: string;
  message: string;
  errorData?: unknown;
} {
  const errorData =
    error && typeof error === "object" && "errorData" in error
      ? (error as { errorData?: unknown }).errorData
      : undefined;
  const code =
    errorData && typeof errorData === "object" && "code" in errorData
      ? String((errorData as { code: unknown }).code)
      : error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "Unknown";
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(errorData === undefined ? {} : { errorData }),
  };
}

function publicationFromReceipt(
  receipt: {
    eventId: string;
    mainEventId: string;
    effectId: string;
    appliedAt: string;
  },
  committedEventId: string
): ProjectPublication {
  if (
    !receipt ||
    receipt.eventId !== committedEventId ||
    !receipt.mainEventId ||
    !receipt.effectId ||
    !receipt.appliedAt
  ) {
    throw Object.assign(
      new Error("vcs.push returned a receipt that does not prove the recorded commit"),
      {
        code: "IntegrityFailure",
        errorData: {
          code: "IntegrityFailure",
          expectedCommittedEventId: committedEventId,
          receipt,
        },
      }
    );
  }
  return {
    published: true,
    committedEventId,
    publishedEventId: receipt.eventId,
    mainEventId: receipt.mainEventId,
    effectId: receipt.effectId,
    appliedAt: receipt.appliedAt,
  };
}

function publicationFailureData(
  input: ScaffoldPublicationFailureData | ScaffoldPublicationError
): ScaffoldPublicationFailureData {
  const data = input instanceof ScaffoldPublicationError ? input.errorData : input;
  if (
    !data ||
    data.code !== "scaffold_publication_failed" ||
    data.stage !== "push" ||
    data.published !== false ||
    !data.created ||
    !data.committedEventId ||
    data.publicationRequest?.expectedCommittedEventId !== data.committedEventId
  ) {
    throw new ScaffoldPublicationRecoveryError({
      code: "scaffold_publication_recovery_failed",
      stage: "validate-receipt",
      created: data?.created ?? "unknown",
      committedEventId: data?.committedEventId ?? "unknown",
      publicationRequest: data?.publicationRequest ?? {
        contextId: "unknown",
        expectedCommittedEventId: "unknown",
        expectedMainEventId: "unknown",
        commandId: "unknown",
      },
      cause: { code: "InvalidReceipt", message: "The scaffold failure receipt is malformed" },
      retry: { operation: "recoverProjectPublication", safeToRerun: false },
    });
  }
  return data;
}

/**
 * Finish a scaffold whose semantic commit succeeded but protected publication
 * did not return a success receipt. This never recreates files or commits.
 */
export async function recoverProjectPublication(
  input: ScaffoldPublicationFailureData | ScaffoldPublicationError
): Promise<ProjectPublication> {
  const failure = publicationFailureData(input);
  if (failure.retry.commandIdPolicy === "stop-integrity-investigation") {
    throw new ScaffoldPublicationRecoveryError({
      code: "scaffold_publication_recovery_failed",
      stage: "validate-receipt",
      created: failure.created,
      committedEventId: failure.committedEventId,
      publicationRequest: failure.publicationRequest,
      cause: {
        code: "IntegrityFailure",
        message: "The original publication receipt was invalid; automatic recovery is unsafe",
        errorData: failure.vcsError.errorData,
      },
      retry: { operation: "recoverProjectPublication", safeToRerun: false },
    });
  }
  let status: Awaited<ReturnType<typeof vcs.status>>;
  try {
    status = await vcs.status(failure.retry.statusRequest);
  } catch (error) {
    throw new ScaffoldPublicationRecoveryError(
      {
        code: "scaffold_publication_recovery_failed",
        stage: "validate-context",
        created: failure.created,
        committedEventId: failure.committedEventId,
        publicationRequest: failure.publicationRequest,
        cause: errorDetail(error),
        retry: { operation: "recoverProjectPublication", safeToRerun: true },
      },
      error
    );
  }
  const exactCommit =
    status.committed.kind === "event" &&
    status.committed.eventId === failure.committedEventId &&
    status.workingHead.kind === "event" &&
    status.workingHead.eventId === failure.committedEventId;
  if (!status.clean || !exactCommit) {
    throw new ScaffoldPublicationRecoveryError({
      code: "scaffold_publication_recovery_failed",
      stage: "validate-context",
      created: failure.created,
      committedEventId: failure.committedEventId,
      publicationRequest: failure.publicationRequest,
      observedStatus: status,
      cause: {
        code: "ContextChanged",
        message:
          "The context is no longer clean at the exact scaffold commit; recovery will not publish a different state",
      },
      retry: { operation: "recoverProjectPublication", safeToRerun: false },
    });
  }

  const uncertain = failure.retry.commandIdPolicy === "reuse-identical-only-if-outcome-uncertain";
  const request = uncertain
    ? failure.publicationRequest
    : {
        contextId: failure.publicationRequest.contextId,
        expectedCommittedEventId: failure.committedEventId,
        expectedMainEventId: status.mainEventId,
        commandId: `workspace-dev:recover-publication:${contextId}:${crypto.randomUUID()}`,
      };
  try {
    return publicationFromReceipt(await vcs.push(request), failure.committedEventId);
  } catch (error) {
    throw new ScaffoldPublicationRecoveryError(
      {
        code: "scaffold_publication_recovery_failed",
        stage: "push",
        created: failure.created,
        committedEventId: failure.committedEventId,
        publicationRequest: request,
        observedStatus: status,
        cause: errorDetail(error),
        retry: { operation: "recoverProjectPublication", safeToRerun: uncertain },
      },
      error
    );
  }
}

// ---------------------------------------------------------------------------
// writeProjectFiles — one atomic repository lifecycle edit, followed by one
// whole-chain commit and protected publication.
// ---------------------------------------------------------------------------

/**
 * Create a repository and all of its initial files as one semantic mutation,
 * then commit and publish the resulting workspace event.
 */
async function writeProjectFiles(
  dir: string,
  files: Record<string, string | Uint8Array>,
  message: string
): Promise<ProjectPublication> {
  const root = dir.replace(/^\/+/, "").replace(/\/+$/, "");
  const command = (operation: string) =>
    `workspace-dev:${operation}:${contextId}:${crypto.randomUUID()}`;
  const beforeCreate = await vcs.status({ contextId });
  const created = await vcs.edit({
    contextId,
    expectedWorkingHead: beforeCreate.workingHead,
    commandId: command("create-repository"),
    intentSummary: message,
    changes: [
      {
        kind: "repository-create",
        repoPath: root,
        files: Object.entries(files)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([filePath, content]) => ({
            path: filePath.replace(/^\/+/, ""),
            content:
              typeof content === "string"
                ? { kind: "text" as const, text: content }
                : { kind: "bytes" as const, base64: bytesToBase64(content) },
            mode: 0o644,
          })),
      },
    ],
  });
  const committed = await vcs.commit({
    contextId,
    expectedWorkingHead: created.workingHead,
    commandId: command("commit"),
    message,
  });
  if (committed.event.kind !== "event") {
    throw new Error("VCS commit did not return a committed event");
  }
  const publicationRequest = {
    contextId,
    expectedCommittedEventId: committed.event.eventId,
    expectedMainEventId: beforeCreate.mainEventId,
    commandId: command("publish"),
  };
  try {
    const published = await vcs.push(publicationRequest);
    return publicationFromReceipt(published, committed.event.eventId);
  } catch (error) {
    const detail = errorDetail(error);
    throw new ScaffoldPublicationError(
      {
        code: "scaffold_publication_failed",
        stage: "push",
        created: root,
        files: Object.keys(files).sort(),
        committedEventId: committed.event.eventId,
        published: false,
        publicationRequest,
        vcsError: detail,
        retry: {
          operation: "vcs.push",
          statusRequest: { contextId },
          commandIdPolicy:
            detail.code === "ExternalEffectFailed"
              ? "reuse-identical-only-if-outcome-uncertain"
              : detail.code === "IntegrityFailure"
                ? "stop-integrity-investigation"
                : "reobserve-status-and-use-new-command",
        },
      },
      error
    );
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

const TYPE_DIRS: Record<ProjectType, string> = {
  panel: "panels",
  package: "packages",
  skill: "skills",
  project: "projects",
  worker: "workers",
};

const PACKAGE_SCOPES: Partial<Record<ProjectType, string>> = {
  panel: "@workspace-panels",
  package: "@workspace",
  skill: "@workspace-skills",
  worker: "@workspace-workers",
};

const SUPPORTED_PROJECT_TYPES = PROJECT_TYPES.join(", ");

function toPascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

export async function createProject(params: {
  projectType: string;
  name: string;
  title?: string;
  template?: string;
}): Promise<{
  created: string;
  files: string[];
  preflight: ProjectPreflightReport;
  publication: ProjectPublication;
}> {
  const { projectType, name, title = name, template } = params;

  assertProjectIdentity(name, title);

  const typeDir = TYPE_DIRS[projectType as ProjectType];
  if (!typeDir)
    throw new Error(
      `Unknown project type: ${projectType}. Must be one of: ${SUPPORTED_PROJECT_TYPES}`
    );

  const canonicalProjectType = projectType as ProjectType;
  const projectPath = `${typeDir}/${name}`;

  // Check if already exists
  if (await fs.exists(projectPath)) {
    throw new Error(`Project already exists: ${projectPath}`);
  }

  // Generate template files
  const files: Record<string, string> = {};

  switch (projectType) {
    case "panel": {
      // Resolve template — defaults to "default" (React+Radix)
      const panelTemplate = template ?? "default";
      let panelFramework = "react";

      // Read template.json from workspace to determine framework
      if (panelTemplate !== "default") {
        const templateConfigPath = `templates/${panelTemplate}/template.json`;
        if (!(await fs.exists(templateConfigPath))) {
          throw new Error(
            `Template "${panelTemplate}" not found. Check workspace/templates/ for available templates.`
          );
        }
        const templateConfig = JSON.parse(
          (await fs.readFile(templateConfigPath, "utf-8")) as string
        );
        if (templateConfig.framework) panelFramework = templateConfig.framework;
      }

      if (panelFramework !== "react" && panelFramework !== "svelte") {
        throw new Error(
          `Panel framework "${panelFramework}" is not supported by createProject; choose the default React or Svelte template.`
        );
      }

      if (panelFramework === "svelte") {
        files["package.json"] = serializeProjectManifest({
          projectType: "panel",
          name,
          title,
          entry: "index.ts",
          ...(panelTemplate !== "default" ? { template: panelTemplate } : {}),
          dependencies: {
            "@workspace/runtime": "workspace:*",
            "@workspace/svelte": "workspace:*",
            svelte: "^5.0.0",
          },
        });
        files["index.ts"] = `export { default } from "./App.svelte";\n`;
        files["App.svelte"] = `<script>
  import { theme, themeStyle } from "@workspace/svelte";
  import { onMount } from "svelte";

  let mode = window.__vibestudioAgentMode ?? "live";
  const data = {
    fixture: "${title} fixture data",
    live: "${title} live data",
  };

  onMount(() => {
    const handler = (event) => { mode = event.detail; };
    window.addEventListener("vibestudio:agentModeChanged", handler);
    return () => window.removeEventListener("vibestudio:agentModeChanged", handler);
  });
</script>

<div class="container" class:dark={$theme === "dark"} style={$themeStyle}>
  <h1>${title}</h1>
  <p>{data[mode]}</p>
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    font-family: system-ui, sans-serif;
    box-sizing: border-box;
    padding: calc(24px * var(--vibestudio-scale));
    border-radius: var(--vibestudio-radius);
    accent-color: var(--vibestudio-accent);
  }
  h1 { color: var(--vibestudio-accent); }
</style>
`;
      } else {
        // Default: React + Radix
        files["package.json"] = serializeProjectManifest({
          projectType: "panel",
          name,
          title,
          entry: "index.tsx",
          ...(panelTemplate !== "default" ? { template: panelTemplate } : {}),
          exposeModules: [
            "react",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            "@radix-ui/themes",
            "@workspace/runtime",
            "@workspace/react",
            "@workspace/ui/panel",
          ],
          dependencies: {
            "@workspace/runtime": "workspace:*",
            "@workspace/react": "workspace:*",
            "@workspace/ui": "workspace:*",
            "@radix-ui/themes": "^3.2.1",
            react: "^19.0.0",
          },
        });
        files["index.tsx"] =
          `import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePanelTheme } from "@workspace/react";
import { useAppTheme } from "@workspace/ui/panel";
import { Flex, Text, Theme } from "@radix-ui/themes";

type DataMode = "fixture" | "live";
const DataModeContext = createContext<{ mode: DataMode; message: string }>({
  mode: "live",
  message: "${title} live data",
});

function DataModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<DataMode>(() =>
    (window as Window & { __vibestudioAgentMode?: DataMode }).__vibestudioAgentMode ?? "live"
  );
  useEffect(() => {
    const handler = (event: Event) => setMode((event as CustomEvent<DataMode>).detail);
    window.addEventListener("vibestudio:agentModeChanged", handler);
    return () => window.removeEventListener("vibestudio:agentModeChanged", handler);
  }, []);
  const value = useMemo(() => ({
    mode,
    message: mode === "fixture" ? "${title} fixture data" : "${title} live data",
  }), [mode]);
  return <DataModeContext.Provider value={value}>{children}</DataModeContext.Provider>;
}

export default function ${toPascalCase(name)}() {
  const theme = usePanelTheme();
  const appTheme = useAppTheme();
  const content = <${toPascalCase(name)}Content />;

  return (
    <Theme appearance={theme} {...appTheme}>
      <DataModeProvider>
        {content}
      </DataModeProvider>
    </Theme>
  );
}

function ${toPascalCase(name)}Content() {
  const data = useContext(DataModeContext);
  return (
      <Flex direction="column" align="center" justify="center" style={{ height: "100vh" }}>
        <Text size="5">${title}</Text>
        <Text size="2" color="gray">{data.message}</Text>
      </Flex>
  );
}
`;
      }
      break;
    }

    case "package":
      files["package.json"] = serializeProjectManifest({
        projectType: "package",
        name,
        title,
        exports: { ".": "./index.ts" },
      });
      files["index.ts"] = `/**\n * ${title}\n */\n\nexport {};\n`;
      break;

    case "skill":
      files["package.json"] = serializeProjectManifest({
        projectType: "skill",
        name,
        title,
        exports: { ".": "./index.ts" },
      });
      files["index.ts"] = `/**\n * ${title}\n */\n\nexport {};\n`;
      files["SKILL.md"] =
        `---\nname: ${name}\ndescription: ${JSON.stringify(title)}\n---\n\n# ${title}\n`;
      break;

    case "project":
      files["README.md"] = `# ${title}\n\nPlain workspace project.\n`;
      break;

    case "worker":
      if (template === "agentic") {
        // Agentic worker template — DO extending AgentWorkerBase
        const className = toPascalCase(name) + "Worker";
        const workerFileName = `${name}-worker`;

        files["package.json"] = serializeProjectManifest({
          projectType: "worker",
          name,
          title,
          entry: "index.ts",
          durableClasses: [className],
          dependencies: {
            "@workspace/runtime": "workspace:*",
            "@workspace/agentic-do": "workspace:*",
            "@workspace/harness": "workspace:*",
          },
          devDependencies: {
            vitest: "^3.2.4",
          },
        });

        files["index.ts"] = `export { ${className} } from "./${workerFileName}.js";
export default { fetch(_req: Request) { return new Response("${name} DO service"); } };
`;

        files[`${workerFileName}.ts`] = `import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@workspace/harness";

/**
 * ${className} — Pi-native agent DO.
 *
 * Pi (\`@earendil-works/pi-agent-core\`) runs in-process. The base class
 * handles channel subscriptions, the channel event pipeline, the per-channel
 * PiRunner lifecycle, and publishes durable agentic trajectory events to the
 * channel transcript. You only need to override the small set of customization
 * hooks below.
 *
 * The system prompt is composed from the Vibestudio base prompt,
 * workspace/meta/AGENTS.md, the generated skill index, and optional channel
 * prompt config.
 */
export class ${className} extends AgentWorkerBase {
  static override schemaVersion = 1;

  // --- Hook: default model id (provider:model format) ---
  // protected override getDefaultModel(): string {
  //   return "openai-codex:gpt-5.6-sol";
  // }

  // --- Hook: default thinking level ---
  // protected override getDefaultThinkingLevel() {
  //   return "medium" as const;
  // }

  // --- Hook: participant identity ---
  protected override getParticipantInfo(): ParticipantDescriptor {
    return {
      handle: "${name}",
      name: "${title}",
      type: "agent",
      methods: [],
    };
  }

  // The base class's onChannelEvent handles incoming messages by forwarding
  // them to the per-channel PiRunner. Override only if you need custom routing.
}
`;

        files[`${workerFileName}.test.ts`] = `import { describe, it, expect } from "vitest";
import type { ChannelEvent } from "@workspace/harness";
import { createTestDO } from "@workspace/runtime/worker";
import { ${className} } from "./${workerFileName}.js";

function makeEvent(overrides: Partial<ChannelEvent> = {}): ChannelEvent {
  return {
    id: 1,
    messageId: "msg-1",
    type: "message",
    payload: { content: "Hello" },
    senderId: "user-1",
    senderMetadata: { type: "panel" },
    ts: Date.now(),
    persist: true,
    ...overrides,
  };
}

describe("${className}", () => {
  it("constructs without errors", async () => {
    const { instance } = await createTestDO(${className});
    expect(instance).toBeTruthy();
  });

  it("filters non-panel events via shouldProcess", async () => {
    const { instance } = await createTestDO(${className});
    // Non-panel events are filtered by the base class — onChannelEvent is a no-op
    await instance.onChannelEvent("ch-1", makeEvent({ senderMetadata: { type: "agent" } }));
  });
});
`;
      } else {
        // Default stateless worker template
        files["package.json"] = serializeProjectManifest({
          projectType: "worker",
          name,
          title,
          entry: "index.ts",
          dependencies: { "@workspace/runtime": "workspace:*" },
        });
        files["index.ts"] = `import { createWorkerRuntime } from "@workspace/runtime/worker";
import type { WorkerEnv, ExecutionContext } from "@workspace/runtime/worker";

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);
    return new Response("Hello from ${title}!");
  },
};
`;
      }
      break;
  }

  const preflight = preflightProjectFiles({
    projectType: canonicalProjectType,
    name,
    files,
  });

  // Create the repository, then commit + push it (edit → commit → push).
  const publication = await writeProjectFiles(
    projectPath,
    files,
    `Scaffold ${projectType} ${name}`
  );

  return { created: projectPath, files: Object.keys(files), preflight, publication };
}

const COPY_SKIP_DIRS = new Set([
  ".cache",
  ".context-projections",
  ".contexts",
  ".databases",
  ".gad",
  ".git",
  ".vibestudio",
  ".parcel-cache",
  ".pnpm-store",
  ".testkit",
  ".tmp",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "dist_electron",
  "node_modules",
  "out",
  "release",
  "test-results",
]);

const COPY_SKIP_FILES = new Set([
  ".DS_Store",
  ".npmrc",
  ".npmrc.dist-tag-temp",
  ".secrets.yml",
  "firebase-service-account.json",
  "GoogleService-Info.plist",
  "google-services.json",
  "Thumbs.db",
]);

function shouldSkipCopiedFile(name: string): boolean {
  return (
    COPY_SKIP_FILES.has(name) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".log") ||
    name.endsWith(".tmp") ||
    name.endsWith(".swp") ||
    name.endsWith(".swo") ||
    name.endsWith(".sublime-workspace") ||
    name.endsWith(".tsbuildinfo") ||
    name.endsWith(".tgz") ||
    name.endsWith("~")
  );
}

export interface ForkProjectOptions {
  from: string;
  to: string;
  title?: string;
  projectType?: "panel" | "worker" | "package" | "skill" | "project";
  dryRun?: boolean;
  rewrite?:
    | boolean
    | {
        packageName?: boolean;
        title?: boolean;
        reactComponentNames?: boolean;
        workerClassNames?: boolean;
        tests?: boolean;
      };
  classMap?: Record<string, string>;
}

export interface ForkProjectResult {
  source: string;
  created: string;
  files: string[];
  preflight: ProjectPreflightReport;
  rewrites: Array<{ file: string; description: string }>;
  warnings: string[];
  committed: boolean;
  dryRun: boolean;
  publication: ProjectPublication | null;
}

function rewriteEnabled(
  options: ForkProjectOptions,
  key: "packageName" | "title" | "reactComponentNames" | "workerClassNames" | "tests"
): boolean {
  if (options.rewrite === false) return false;
  if (typeof options.rewrite === "object" && key in options.rewrite)
    return options.rewrite[key] !== false;
  return true;
}

function projectNameFromPath(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function projectTypeFromPath(p: string): ProjectType | null {
  return (
    (Object.entries(TYPE_DIRS).find(([, dir]) => p === dir || p.startsWith(`${dir}/`))?.[0] as
      | ProjectType
      | undefined) ?? null
  );
}

function rewriteRelPath(
  rel: string,
  oldName: string,
  newName: string,
  projectType: string | null
): string {
  if (projectType === "worker" && rel.includes(oldName)) return rel.split(oldName).join(newName);
  return rel;
}

async function listFilesRecursive(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = (await fs.readdir(prefix ? `${dir}/${prefix}` : dir, {
    withFileTypes: true,
  })) as Array<{ name: string; _isDirectory?: boolean; isDirectory?: () => boolean }>;
  for (const entry of entries) {
    if (COPY_SKIP_DIRS.has(entry.name)) continue;
    if (shouldSkipCopiedFile(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const isDir =
      typeof entry.isDirectory === "function" ? entry.isDirectory() : entry._isDirectory;
    if (isDir) out.push(...(await listFilesRecursive(dir, rel)));
    else out.push(rel);
  }
  return out;
}

function isProbablyTextFile(file: string): boolean {
  return (
    /\.(tsx?|jsx?|json|md|mdx|svelte|css|scss|html|ya?ml|toml|txt)$/i.test(file) ||
    !file.includes(".")
  );
}

async function readText(path: string): Promise<string> {
  return (await fs.readFile(path, "utf-8")) as string;
}

export async function forkProject(options: ForkProjectOptions): Promise<ForkProjectResult> {
  const from = options.from.replace(/^\/+|\/+$/g, "");
  const to = options.to.replace(/^\/+|\/+$/g, "");
  if (!from || !to) throw new Error("forkProject requires from and to paths");
  if (!(await fs.exists(from))) throw new Error(`Source project does not exist: ${from}`);
  if (await fs.exists(to)) throw new Error(`Destination already exists: ${to}`);

  const fromType = projectTypeFromPath(from);
  const toType = projectTypeFromPath(to);
  const explicitType = options.projectType;
  const effectiveType = explicitType ?? toType ?? fromType;
  const warnings: string[] = [];
  const rewrites: Array<{ file: string; description: string }> = [];
  if (!fromType || !toType)
    warnings.push(
      "Could not infer project type from one or both paths; only generic rewrites will run."
    );
  if (fromType && toType && fromType !== toType && !explicitType) {
    throw new Error(
      `Fork crosses project types (${fromType} -> ${toType}); pass projectType to opt into this.`
    );
  }
  if (explicitType && toType && explicitType !== toType) {
    throw new Error(
      `Destination path ${to} is a ${toType}, not requested projectType ${explicitType}`
    );
  }

  const oldName = projectNameFromPath(from);
  const newName = projectNameFromPath(to);
  const newTitle = options.title ?? newName;
  assertProjectIdentity(newName, newTitle);
  const files = await listFilesRecursive(from);
  const createdFiles: string[] = [];
  const planned: Record<string, string | Uint8Array> = {};
  const effectiveClassMap: Record<string, string> = { ...(options.classMap ?? {}) };
  const binaryFiles: string[] = [];

  for (const rel of files) {
    const srcPath = `${from}/${rel}`;
    const destRel = rewriteRelPath(rel, oldName, newName, effectiveType);
    if (destRel !== rel) {
      rewrites.push({ file: rel, description: `Renamed forked file path to ${destRel}` });
    }
    createdFiles.push(destRel);
    if (!isProbablyTextFile(rel)) {
      binaryFiles.push(destRel);
      planned[destRel] = (await fs.readFile(srcPath)) as Uint8Array;
      continue;
    }
    let content = await readText(srcPath);

    if (rel === "package.json") {
      try {
        const pkg = JSON.parse(content);
        if (rewriteEnabled(options, "packageName")) {
          const scope = effectiveType ? PACKAGE_SCOPES[effectiveType] : undefined;
          if (scope) pkg.name = `${scope}/${newName}`;
          rewrites.push({ file: rel, description: "Updated package name" });
        }
        if (rewriteEnabled(options, "title")) {
          pkg.vibestudio = { ...(pkg.vibestudio ?? {}), title: newTitle };
          rewrites.push({ file: rel, description: "Updated vibestudio title" });
        }
        if (
          pkg.vibestudio?.entry &&
          typeof pkg.vibestudio.entry === "string" &&
          pkg.vibestudio.entry.includes(oldName)
        ) {
          pkg.vibestudio.entry = pkg.vibestudio.entry.split(oldName).join(newName);
          rewrites.push({ file: rel, description: "Updated vibestudio entry path" });
        }
        if (effectiveType === "worker" && rewriteEnabled(options, "workerClassNames")) {
          const classes = pkg.vibestudio?.durable?.classes;
          if (Array.isArray(classes)) {
            if (classes.length === 1) {
              const oldClass = classes[0]?.className;
              if (oldClass) {
                const nextClass = effectiveClassMap[oldClass] ?? `${toPascalCase(newName)}Worker`;
                effectiveClassMap[oldClass] = nextClass;
                classes[0].className = nextClass;
                rewrites.push({
                  file: rel,
                  description: `Updated durable class ${oldClass} -> ${nextClass}`,
                });
              } else {
                warnings.push(
                  "Worker durable class metadata is missing className; no class rewrite was applied."
                );
              }
            } else if (classes.length > 1) {
              const unmapped = classes.filter(
                (c: { className?: string }) => c.className && !effectiveClassMap[c.className]
              );
              if (unmapped.length > 0)
                warnings.push(
                  "Worker has multiple durable classes; provide classMap for complete safe renaming."
                );
              for (const c of classes)
                if (effectiveClassMap[c.className]) c.className = effectiveClassMap[c.className];
            }
          }
        }
        content = JSON.stringify(pkg, null, 2) + "\n";
      } catch (err) {
        warnings.push(
          `Could not parse package.json: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (effectiveType === "skill" && rel === "SKILL.md") {
      content = content.replace(/^name:\s*.+$/m, `name: ${newName}`);
      if (options.title)
        content = content.replace(/^description:\s*.+$/m, `description: ${newTitle}`);
      rewrites.push({ file: rel, description: "Updated skill frontmatter" });
    }

    // package.json has a typed, structural rewrite above. Never run textual
    // source rewrites over it: a destination such as `source-copy` still
    // contains `source`, so replacing the old name again would corrupt the
    // already-canonical package name and entry metadata.
    if (
      rel !== "package.json" &&
      effectiveType === "worker" &&
      rewriteEnabled(options, "workerClassNames")
    ) {
      for (const [oldClass, nextClass] of Object.entries(effectiveClassMap)) {
        if (content.includes(oldClass)) {
          content = content.split(oldClass).join(nextClass);
          rewrites.push({
            file: destRel,
            description: `Rewrote class reference ${oldClass} -> ${nextClass}`,
          });
        }
      }
      if (content.includes(from)) {
        content = content.split(from).join(to);
        rewrites.push({
          file: destRel,
          description: `Rewrote worker repository path ${from} -> ${to}`,
        });
      }
    }

    planned[destRel] = content;
  }

  if (binaryFiles.length > 0) {
    warnings.push(`Binary files will be copied unchanged: ${binaryFiles.join(", ")}`);
  }

  if (!effectiveType) {
    throw new Error(
      "Fork destination must identify a canonical project type so the planned repository can be preflighted"
    );
  }
  const preflight = preflightProjectFiles({
    projectType: effectiveType,
    name: newName,
    files: planned,
  });

  try {
    if (await fs.exists("meta/vibestudio.yml")) {
      const meta = await readText("meta/vibestudio.yml");
      if (
        meta.includes(from) ||
        Object.keys(effectiveClassMap).some((oldClass) => meta.includes(oldClass))
      ) {
        warnings.push(
          "Workspace meta/vibestudio.yml references the source project or worker classes; review global config before launching the fork."
        );
      }
    }
  } catch {
    // Best-effort warning only.
  }

  if (options.dryRun) {
    return {
      source: from,
      created: to,
      files: createdFiles,
      preflight,
      rewrites,
      warnings,
      committed: false,
      dryRun: true,
      publication: null,
    };
  }

  const initialFiles: Record<string, string | Uint8Array> = {};
  for (const [rel, content] of Object.entries(planned)) initialFiles[rel] = content;
  const publication = await writeProjectFiles(to, initialFiles, `Fork ${from} -> ${to}`);
  return {
    source: from,
    created: to,
    files: createdFiles,
    preflight,
    rewrites,
    warnings,
    committed: true,
    dryRun: false,
    publication,
  };
}

export async function forkPanel(params: {
  from: string;
  name: string;
  title?: string;
  dryRun?: boolean;
}): Promise<ForkProjectResult> {
  return forkProject({
    from: params.from,
    to: `panels/${params.name}`,
    title: params.title,
    dryRun: params.dryRun,
  });
}

export async function forkWorker(params: {
  from: string;
  name: string;
  title?: string;
  classMap?: Record<string, string>;
  dryRun?: boolean;
}): Promise<ForkProjectResult> {
  return forkProject({
    from: params.from,
    to: `workers/${params.name}`,
    title: params.title,
    classMap: params.classMap,
    dryRun: params.dryRun,
  });
}
