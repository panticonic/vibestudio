import {
  canonicalJson,
  compareUtf16CodeUnits,
  type CanonicalSnapshotDigest,
} from "@vibestudio/content-addressing";
import { WorkspaceConfigTopLayerSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceConfig,
  WorkspaceTemplatePin,
  WorkspaceTemplateState,
} from "@vibestudio/workspace-contracts/types";
import { composeWorkspaceConfig } from "./configComposition.js";
import { parseWorkspaceConfigContentWithId } from "./configParser.js";
import {
  canonicalTemplateNodeId,
  normalizeTemplateGitUrl,
  templateAliasFromUrl,
} from "./templateCoordinates.js";
import {
  canonicalTemplateYaml,
  readTemplateManifest,
  validateTemplateSnapshotInventory,
  type ParsedTemplateManifest,
} from "./templateManifest.js";
import { templateSuggestionDigest } from "./templateState.js";

export interface RootTemplateRepositoryEvidence {
  repoPath: string;
  snapshot: CanonicalSnapshotDigest;
}

export interface PreparedRootTemplateMetadata {
  manifest: ParsedTemplateManifest;
  sourceYaml: string;
  stateYaml: string;
  runtimeYaml: string;
  state: WorkspaceTemplateState;
}

function workspaceSource(
  runtime: Omit<WorkspaceConfig, "id">,
  pin: WorkspaceTemplatePin
): ReturnType<typeof WorkspaceConfigTopLayerSchema.parse> {
  const authoredUpstreams = Object.fromEntries(
    Object.entries(runtime.git?.upstreams ?? {}).flatMap(([section, repositories]) => {
      const authored = Object.fromEntries(
        Object.entries(repositories).filter(
          ([, upstream]) => upstream.authorName !== undefined || upstream.authorEmail !== undefined
        )
      );
      return Object.keys(authored).length > 0 ? [[section, authored]] : [];
    })
  );
  return WorkspaceConfigTopLayerSchema.parse({
    systemEpoch: runtime.systemEpoch,
    templates: {
      use: [
        {
          url: normalizeTemplateGitUrl(pin.url),
          ...(pin.credential ? { credential: pin.credential } : {}),
        },
      ],
    },
    ...(runtime.providers ? { providers: runtime.providers } : {}),
    ...(runtime.trust ? { trust: runtime.trust } : {}),
    ...(Object.keys(authoredUpstreams).length > 0 ? { git: { upstreams: authoredUpstreams } } : {}),
  });
}

/** Build the complete Composer contract before a root workspace has a visible main. */
export function prepareRootTemplateMetadata(input: {
  pin: WorkspaceTemplatePin;
  workspaceId: string;
  expectedSystemEpoch: number;
  readFile(path: string): Uint8Array | null;
  snapshotPaths: readonly string[];
  repositories: readonly RootTemplateRepositoryEvidence[];
}): PreparedRootTemplateMetadata {
  const manifest = readTemplateManifest({
    readFile: input.readFile,
    expectedSystemEpoch: input.expectedSystemEpoch,
  });
  if (manifest.dependencies.length > 0) {
    throw new Error("A root-capable template cannot declare template dependencies");
  }
  validateTemplateSnapshotInventory(manifest.inventory, input.snapshotPaths);
  const discoveredRepositories = input.repositories
    .filter(({ repoPath }) => repoPath !== "meta")
    .map(({ repoPath }) => repoPath)
    .sort(compareUtf16CodeUnits);
  if (canonicalJson(discoveredRepositories) !== canonicalJson(manifest.inventory.repositories)) {
    throw new Error(
      `Root semantic repositories do not match template.repositories: ` +
        `declared ${manifest.inventory.repositories.join(", ")}; discovered ${discoveredRepositories.join(", ")}`
    );
  }
  const runtimeBytes = input.readFile("meta/vibestudio.yml");
  if (!runtimeBytes) throw new Error("Root template is missing meta/vibestudio.yml");
  const runtimeText = new TextDecoder("utf-8", { fatal: true }).decode(runtimeBytes);
  const parsedRuntime = parseWorkspaceConfigContentWithId(runtimeText, input.workspaceId);
  const { id: _id, ...runtime } = parsedRuntime;
  if (runtime.systemEpoch !== input.expectedSystemEpoch) {
    throw new Error(
      `Root runtime epoch ${runtime.systemEpoch} does not match host epoch ${input.expectedSystemEpoch}`
    );
  }
  const canonicalRuntime = canonicalTemplateYaml(runtime);
  if (runtimeText !== canonicalRuntime) {
    throw new Error("Root meta/vibestudio.yml is not the canonical generated runtime manifest");
  }

  const nodeId = canonicalTemplateNodeId(input.pin.url, input.pin.commit);
  const alias = templateAliasFromUrl(input.pin.url);
  const source = workspaceSource(runtime, input.pin);
  const composed = composeWorkspaceConfig(
    source,
    [{ nodeId, alias, ancestors: [], config: manifest.fragment }],
    input.workspaceId
  );
  if (canonicalJson(composed) !== canonicalJson(parsedRuntime)) {
    throw new Error(
      "Root generated runtime does not equal its template fragment plus workspace-owned authority layer"
    );
  }
  const state: WorkspaceTemplateState = {
    version: 1,
    roots: source.templates?.use ?? [],
    overrides: {},
    nodes: [
      {
        nodeId,
        alias,
        pin: input.pin,
        parents: [],
        fragment: manifest.fragmentYaml,
        ...(manifest.presentation ? { presentation: manifest.presentation } : {}),
        suggestions: {
          ...(manifest.excludedSuggestions.trust === undefined
            ? {}
            : {
                trust: {
                  digest: templateSuggestionDigest(
                    nodeId,
                    "trust",
                    manifest.excludedSuggestions.trust
                  ),
                  value: manifest.excludedSuggestions.trust,
                },
              }),
          ...(manifest.excludedSuggestions.providers === undefined
            ? {}
            : {
                providers: {
                  digest: templateSuggestionDigest(
                    nodeId,
                    "providers",
                    manifest.excludedSuggestions.providers
                  ),
                  value: manifest.excludedSuggestions.providers,
                },
              }),
        },
      },
    ],
    repositories: Object.fromEntries(
      input.repositories
        .filter(({ repoPath }) => repoPath !== "meta")
        .sort((left, right) => compareUtf16CodeUnits(left.repoPath, right.repoPath))
        .map(({ repoPath, snapshot }) => [
          repoPath,
          { contributions: [{ nodeId, subtreeDigest: snapshot }] },
        ])
    ),
  };
  return {
    manifest,
    sourceYaml: canonicalTemplateYaml(source),
    stateYaml: canonicalTemplateYaml(state),
    runtimeYaml: canonicalRuntime,
    state,
  };
}
