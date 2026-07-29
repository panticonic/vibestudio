import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { rpcErrorDataOf } from "@vibestudio/rpc";
import { isDeepStrictEqual } from "node:util";
import type {
  WorkspaceConfig,
  WorkspaceGitRemoteConfig,
  WorkspaceGitUpstreamConfig,
} from "@vibestudio/workspace-contracts/types";
import {
  getDeclaredUpstreamForRepo,
  getDeclaredRemoteForRepo,
  getDeclaredUpstreams,
  normalizeRemoteUrl,
  normalizeWorkspaceRepoPath,
  removeDeclaredRemoteFromConfig,
  removeDeclaredUpstreamFromConfig,
  setDeclaredRemoteInConfig,
  setDeclaredUpstreamInConfig,
  syncDeclaredRemoteForRepo,
  validateWorkspaceGitRemote,
  validateWorkspaceGitRemoteBranch,
  validateWorkspaceGitRemoteName,
  validateWorkspaceGitUpstream,
} from "@vibestudio/workspace/remotes";
import {
  WORKSPACE_IMPORT_PARENT_DIRS,
  isSupportedImportRepoPath,
  resolveWorkspaceRepoPath,
} from "@vibestudio/workspace/pathPolicy";
import {
  gitInteropMethods,
  gitInteropProviderMethods,
  GIT_PUBLISH_CAPABILITY,
  GIT_PUBLISH_REPO_AUTHORITY_RESOLVER,
  GIT_TEMPLATE_CONTRIBUTION_AUTHORITY_RESOLVER,
  GIT_TEMPLATE_PUBLISH_AUTHORITY_RESOLVER,
  type GitDetachUpstreamOptions,
  type GitDetachUpstreamResult,
  type GitImportedWorkspaceRepo,
  type GitImportResult,
  type GitImportProjectRequest,
  type GitInteropProviderArgs,
  type GitInteropProviderMethod,
  type GitInteropProviderOperation,
  type GitInteropProviderResult,
  type GitPublishRepoInput,
  type GitTemplateContributionInput,
  type GitTemplatePublishInput,
} from "@vibestudio/service-schemas/gitInterop";
import { deleteDynamicProperty } from "../../lintHelpers";
import { fixedPreparedAuthoritySelection } from "@vibestudio/shared/serviceDefinition";
import {
  canonicalJson,
  compareUtf16CodeUnits,
  sha256HexSyncText,
} from "@vibestudio/content-addressing";
import {
  normalizeTemplateGitUrl,
  templateGitTransportUrl,
} from "@vibestudio/workspace/templateCoordinates";

export type GitInteropServiceDeps = {
  workspaceId?: string;
  workspacePath?: string;
  workspaceConfig?: WorkspaceConfig;
  persistWorkspaceConfigMutation?: (input: {
    ctx: ServiceContext;
    mutate: WorkspaceConfigMutation;
    summary: string;
  }) => Promise<WorkspaceConfigMutationResult>;
  /** Provider-owned Git transport operations. Host owns policy and config writes. */
  invokeGitProvider?: <M extends GitInteropProviderMethod>(
    ctx: ServiceContext,
    method: M,
    args: GitInteropProviderArgs<M>
  ) => Promise<GitInteropProviderResult<M>>;
  /** Queue provider reconciliation without making a config write depend on provider readiness. */
  requestGitReconciliation?: (repoPaths: string[]) => void;
  /** Resolve a portable workspace credential name to a profile-local concrete id. */
  resolveCredential?: (input: {
    workspaceId: string;
    name: string;
    url: string;
  }) => string | null | Promise<string | null>;
};

type WorkspaceConfigMutation = (currentConfig: WorkspaceConfig) => WorkspaceConfig;
type WorkspaceConfigMutationResult = { changed: boolean; nextConfig: WorkspaceConfig };
type WorkspaceRepoGitDeclarationSnapshot = {
  remote: WorkspaceGitRemoteConfig | null;
  upstream: WorkspaceGitUpstreamConfig | null;
};
type WorkspaceRepoConfigTransaction = {
  changed: boolean;
  rollbackIfCurrent: WorkspaceConfigMutation;
  matchesPrevious: (config: WorkspaceConfig) => boolean;
};

function operationErrorDetail(error: unknown): {
  message: string;
  code?: string;
  errorKind?: string;
  errorData?: unknown;
} {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  const errorKind =
    error &&
    typeof error === "object" &&
    typeof (error as { errorKind?: unknown }).errorKind === "string"
      ? (error as { errorKind: string }).errorKind
      : undefined;
  const errorData = rpcErrorDataOf(error);
  return {
    message,
    ...(code ? { code } : {}),
    ...(errorKind ? { errorKind } : {}),
    ...(errorData === undefined ? {} : { errorData }),
  };
}

export function createGitInteropService(deps: GitInteropServiceDeps): ServiceDefinition {
  return {
    name: "gitInterop",
    description: "External Git interop: declared remotes and remote project imports",
    authority: { principals: ["user", "code", "host"] },
    methods: gitInteropMethods,
    authorityPreparation: {
      [GIT_PUBLISH_REPO_AUTHORITY_RESOLVER]: (ctx, [rawInput]) => {
        if (!ctx.caller.code && !ctx.caller.executionSession)
          return { selections: [], payload: null };
        return {
          selections: [publishRepoAuthoritySelection(rawInput as GitPublishRepoInput)],
          payload: null,
        };
      },
      [GIT_TEMPLATE_CONTRIBUTION_AUTHORITY_RESOLVER]: (ctx, [rawInput]) => {
        if (!ctx.caller.code && !ctx.caller.executionSession)
          return { selections: [], payload: null };
        return {
          selections: [
            templateContributionAuthoritySelection(rawInput as GitTemplateContributionInput),
          ],
          payload: null,
        };
      },
      [GIT_TEMPLATE_PUBLISH_AUTHORITY_RESOLVER]: (ctx, [rawInput]) => {
        if (!ctx.caller.code && !ctx.caller.executionSession)
          return { selections: [], payload: null };
        return {
          selections: [templatePublishAuthoritySelection(rawInput as GitTemplatePublishInput)],
          payload: null,
        };
      },
    },
    handler: defineServiceHandler("gitInterop", gitInteropMethods, {
      setSharedRemote: async (ctx, [repoPath, remoteInput]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        const normalizedRemote = validateWorkspaceGitRemote(remoteInput);

        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) =>
            setDeclaredRemoteInConfig(currentConfig, validRepoPath, normalizedRemote),
          summary: workspaceConfigRemoteSummary(validRepoPath, normalizedRemote, "set"),
        });
        await propagateSharedRemote(deps, validRepoPath);
        deps.requestGitReconciliation?.([validRepoPath]);
        return persisted.nextConfig.git?.remotes ?? {};
      },

      removeSharedRemote: async (ctx, [repoPath, remoteName]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        const existing = getRemoteForApproval(deps.workspaceConfig, validRepoPath, remoteName);

        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) => {
            const withoutRemote = removeDeclaredRemoteFromConfig(
              currentConfig,
              validRepoPath,
              remoteName
            );
            let currentUpstream: ReturnType<typeof getDeclaredUpstreamForRepo> = null;
            try {
              currentUpstream = getDeclaredUpstreamForRepo(currentConfig, validRepoPath);
            } catch {
              currentUpstream = null;
            }
            return currentUpstream?.remote === existing.name
              ? removeDeclaredUpstreamFromConfig(withoutRemote, validRepoPath)
              : withoutRemote;
          },
          summary: workspaceConfigRemoteSummary(validRepoPath, existing, "remove"),
        });
        await propagateSharedRemote(deps, validRepoPath);
        deps.requestGitReconciliation?.([validRepoPath]);
        return persisted.nextConfig.git?.remotes ?? {};
      },

      setUpstream: async (ctx, [repoPath, upstreamInput]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        const normalizedUpstream = validateWorkspaceGitUpstream(upstreamInput);
        const remote = getDeclaredRemoteForRepo(
          deps.workspaceConfig,
          validRepoPath,
          normalizedUpstream.remote
        );
        if (!remote) {
          throw new Error(
            `Upstream remote "${normalizedUpstream.remote}" is not declared for ${validRepoPath}`
          );
        }

        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) => {
            if (
              !getDeclaredRemoteForRepo(currentConfig, validRepoPath, normalizedUpstream.remote)
            ) {
              throw new Error(
                `Upstream remote "${normalizedUpstream.remote}" is not declared for ${validRepoPath}`
              );
            }
            return setDeclaredUpstreamInConfig(currentConfig, validRepoPath, normalizedUpstream);
          },
          summary: workspaceConfigUpstreamSummary(validRepoPath, normalizedUpstream, "set"),
        });
        await propagateSharedRemote(deps, validRepoPath);
        deps.requestGitReconciliation?.([validRepoPath]);
        return persisted.nextConfig.git?.upstreams ?? {};
      },

      removeUpstream: async (ctx, [repoPath]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        // Tolerate an unresolvable declaration (e.g. its remote was already
        // removed) — removal must stay possible to clear a broken entry.
        let existing: ReturnType<typeof getDeclaredUpstreamForRepo> = null;
        try {
          existing = getDeclaredUpstreamForRepo(deps.workspaceConfig, validRepoPath);
        } catch {
          existing = null;
        }
        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) => removeDeclaredUpstreamFromConfig(currentConfig, validRepoPath),
          summary: workspaceConfigUpstreamSummary(validRepoPath, existing, "remove"),
        });
        await propagateSharedRemote(deps, validRepoPath);
        deps.requestGitReconciliation?.([validRepoPath]);
        return persisted.nextConfig.git?.upstreams ?? {};
      },

      setAutoPush: async (ctx, [repoPath, enabled]) => {
        if (!deps.workspacePath) throw new Error("No workspace path configured");
        if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
        const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
        const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
        const existing = getDeclaredUpstreamForRepo(deps.workspaceConfig, validRepoPath);
        if (!existing) throw new Error(`No upstream tracking is declared for ${validRepoPath}`);
        const nextUpstream: WorkspaceGitUpstreamConfig = {
          remote: existing.remote,
          ...(existing.branch ? { branch: existing.branch } : {}),
          autoPush: enabled,
          ...(existing.credential !== undefined ? { credential: existing.credential } : {}),
          ...(existing.authorEmail ? { authorEmail: existing.authorEmail } : {}),
          ...(existing.authorName ? { authorName: existing.authorName } : {}),
        };

        const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: (currentConfig) => {
            const currentUpstream = getDeclaredUpstreamForRepo(currentConfig, validRepoPath);
            if (!currentUpstream) {
              throw new Error(`No upstream tracking is declared for ${validRepoPath}`);
            }
            return setDeclaredUpstreamInConfig(currentConfig, validRepoPath, {
              remote: currentUpstream.remote,
              branch: currentUpstream.branch,
              autoPush: enabled,
              ...(currentUpstream.credential !== undefined
                ? { credential: currentUpstream.credential }
                : {}),
              ...(currentUpstream.authorEmail ? { authorEmail: currentUpstream.authorEmail } : {}),
              ...(currentUpstream.authorName ? { authorName: currentUpstream.authorName } : {}),
            });
          },
          summary: workspaceConfigUpstreamSummary(validRepoPath, nextUpstream, "set"),
        });
        await propagateSharedRemote(deps, validRepoPath);
        deps.requestGitReconciliation?.([validRepoPath]);
        return persisted.nextConfig.git?.upstreams ?? {};
      },

      upstreamStatus: async (ctx, [repoPaths, options]) => {
        if (!deps.invokeGitProvider) throw new Error("Git upstream provider is unavailable");
        const repos =
          repoPaths.length > 0
            ? repoPaths
            : deps.workspaceConfig
              ? getDeclaredUpstreams(deps.workspaceConfig).map((entry) => entry.repoPath)
              : [];
        const rows = await Promise.all(
          repos.map(async (repoPath) => {
            const credentialIdOverride = await resolveConfiguredCredential(deps, repoPath, options);
            const providerOptions = {
              ...options,
              ...(credentialIdOverride !== undefined ? { credentialIdOverride } : {}),
            };
            return invokeGitProviderOperation(
              deps,
              ctx,
              "upstreamStatus",
              Object.keys(providerOptions).length > 0 ? [[repoPath], providerOptions] : [[repoPath]]
            );
          })
        );
        return rows.flat();
      },
      pushUpstream: async (ctx, [repoPath, options]) => {
        const credentialIdOverride = await resolveConfiguredCredential(deps, repoPath, options);
        const providerOptions = {
          ...options,
          ...(credentialIdOverride !== undefined ? { credentialIdOverride } : {}),
        };
        return invokeGitProviderOperation(
          deps,
          ctx,
          "pushUpstream",
          Object.keys(providerOptions).length > 0 ? [repoPath, providerOptions] : [repoPath]
        );
      },
      pullUpstream: async (ctx, [repoPath, options]) => {
        const credentialIdOverride = await resolveConfiguredCredential(deps, repoPath, options);
        const providerOptions = {
          ...options,
          ...(credentialIdOverride !== undefined ? { credentialIdOverride } : {}),
        };
        return invokeGitProviderOperation(
          deps,
          ctx,
          "pullUpstream",
          Object.keys(providerOptions).length > 0 ? [repoPath, providerOptions] : [repoPath]
        );
      },
      publishRepo: (ctx, args) => invokeGitProviderOperation(deps, ctx, "publishRepo", args),

      commitMapping: (ctx, args) => invokeGitProviderOperation(deps, ctx, "commitMapping", args),
      pushTemplateContribution: (ctx, args) =>
        invokeGitProviderOperation(deps, ctx, "pushTemplateContribution", args),
      publishTemplate: (ctx, args) =>
        invokeGitProviderOperation(deps, ctx, "publishTemplate", args),
      detachUpstream: (ctx, [repoPath, options]) => detachUpstream(ctx, deps, repoPath, options),
      importProject: (ctx, [request]) => importWorkspaceRepo(ctx, deps, request),
    }),
  };
}

function publishRepoAuthoritySelection(input: GitPublishRepoInput) {
  const repoPath = normalizeWorkspaceRepoPath(input.repoPath);
  const provider = input.provider?.trim() || "github";
  const providerName = providerDisplayName(provider);
  const repoName = input.name?.trim() || repoPath.split("/").at(-1) || repoPath;
  if (repoName.includes("/")) {
    throw new Error(
      `Repository name "${repoName}" must not contain "/" — the owner is determined by the credential`
    );
  }
  const remote = validateWorkspaceGitRemoteName(input.remote ?? "origin");
  const branch = validateWorkspaceGitRemoteBranch(input.branch ?? "main");
  const visibility = input.private === false ? "Public" : "Private";
  const automaticPushes = input.autoPush === true;
  const destination = `${providerName} / ${repoName}`;
  const credentialKey = input.credentialId?.trim() || "default";

  return fixedPreparedAuthoritySelection({
    capability: GIT_PUBLISH_CAPABILITY,
    resourceKey: `external-repository:${provider}:${credentialKey}:${repoName}`,
    challenge: {
      title: `Create and publish ${repoName}`,
      description:
        `Creates a ${visibility.toLowerCase()} repository on ${providerName}, pushes ` +
        `${repoPath}, and records it as this workspace repository's upstream.`,
      deniedReason: `Publishing ${repoPath} to ${destination} was not allowed`,
      dedupKey: `git-publish:${provider}:${credentialKey}:${repoName}`,
      resource: {
        type: "external-repository",
        label: "Destination",
        value: destination,
      },
      operation: {
        kind: "git" as const,
        verb: "create and publish a Git repository",
        object: {
          type: "external-repository",
          label: "Repository",
          value: destination,
        },
        groupKey: `git-publish:${provider}:${credentialKey}:${repoName}`,
      },
      substance: {
        kind: "change-set" as const,
        summary: `Create a ${visibility.toLowerCase()} ${providerName} repository and publish ${repoPath}`,
        facts: [
          { label: "Repository", value: destination },
          { label: "Visibility", value: visibility },
          { label: "Publish", value: `${repoPath} → ${branch}` },
          { label: "Workspace tracking", value: `${remote} tracks ${branch}` },
          {
            label: "Future changes",
            value: automaticPushes ? "Push automatically" : "Push only when requested",
          },
          ...(input.description?.trim()
            ? [{ label: "Description", value: input.description.trim() }]
            : []),
          ...(input.force === true ? [{ label: "First push", value: "Force update allowed" }] : []),
        ],
      },
      details: [
        { label: "Workspace repository", value: repoPath },
        { label: "Provider", value: providerName },
        { label: "Remote name", value: remote },
        { label: "Remote branch", value: branch },
        ...(input.credentialId ? [{ label: "Connected account", value: input.credentialId }] : []),
      ],
    },
  });
}

function templateContributionAuthoritySelection(input: GitTemplateContributionInput) {
  const normalizedUrl = normalizeTemplateGitUrl(input.url);
  const destination = templateGitTransportUrl(normalizedUrl);
  const credential = input.credential?.trim() || "anonymous";
  const parts = input.parts
    .map(({ repoPath, subdir }) => ({
      repoPath: normalizeWorkspaceRepoPath(repoPath),
      subdir: normalizeWorkspaceRepoPath(subdir),
    }))
    .sort((left, right) =>
      left.repoPath === right.repoPath
        ? compareUtf16CodeUnits(left.subdir, right.subdir)
        : compareUtf16CodeUnits(left.repoPath, right.repoPath)
    );
  const partSummary = parts.map(({ repoPath, subdir }) => `${repoPath} → ${subdir}`).join(", ");
  const requestDigest = sha256HexSyncText(
    canonicalJson({
      protocol: "vibestudio-template-contribution-authority-v1",
      operationId: input.operationId,
      destination: normalizedUrl,
      credential,
      baseCommit: input.baseCommit,
      mainEventId: input.expectedMainEventId,
      parts,
    })
  );

  return fixedPreparedAuthoritySelection({
    capability: GIT_PUBLISH_CAPABILITY,
    resourceKey: `template-contribution:${requestDigest}`,
    challenge: {
      title: `Push a contribution to ${input.alias}`,
      description:
        `Exports ${parts.length} workspace ${parts.length === 1 ? "repository" : "repositories"} ` +
        `from protected main ${input.expectedMainEventId} and pushes a contribution branch to ${destination}.`,
      deniedReason: `Publishing a template contribution to ${destination} was not allowed`,
      dedupKey: `template-contribution:${requestDigest}`,
      resource: {
        type: "external-repository",
        label: "Destination",
        value: destination,
      },
      operation: {
        kind: "git" as const,
        verb: "push a template contribution branch",
        object: {
          type: "external-repository",
          label: "Repository",
          value: destination,
        },
        groupKey: `template-contribution:${credential}:${normalizedUrl}`,
      },
      substance: {
        kind: "change-set" as const,
        summary: `Publish ${parts.length} exact protected-main ${parts.length === 1 ? "part" : "parts"} to ${input.alias}`,
        facts: [
          { label: "Protected main", value: input.expectedMainEventId },
          { label: "Template base", value: input.baseCommit },
          { label: "Parts", value: partSummary },
        ],
      },
      details: [
        { label: "Template", value: input.alias },
        { label: "Destination", value: destination },
        { label: "Credential", value: credential },
        { label: "Operation", value: input.operationId },
      ],
    },
  });
}

function templatePublishAuthoritySelection(input: GitTemplatePublishInput) {
  const provider = input.destination.provider.trim();
  const providerName = providerDisplayName(provider);
  const repoName = input.destination.name.trim();
  if (repoName.includes("/")) {
    throw new Error(`Repository name "${repoName}" must not contain "/"`);
  }
  const owner = input.destination.owner.trim();
  const credential = input.credentialId?.trim() || "default";
  const parts = input.parts
    .map(({ repoPath, subdir }) => ({
      repoPath: normalizeWorkspaceRepoPath(repoPath),
      subdir: normalizeWorkspaceRepoPath(subdir),
    }))
    .sort((left, right) => compareUtf16CodeUnits(left.repoPath, right.repoPath));
  const destination = `${providerName} / ${owner}/${repoName}`;
  const requestDigest = sha256HexSyncText(
    canonicalJson({
      protocol: "vibestudio-template-publish-authority-v1",
      operationId: input.operationId,
      provider,
      repository: repoName,
      owner,
      private: input.creation?.private ?? true,
      version: input.version,
      mainEventId: input.expectedMainEventId,
      manifestDigest: input.manifestDigest,
      parts,
    })
  );
  return fixedPreparedAuthoritySelection({
    capability: GIT_PUBLISH_CAPABILITY,
    resourceKey: `template-publication:${requestDigest}`,
    challenge: {
      title: `Publish ${input.version} to ${repoName}`,
      description:
        `Publishes a new immutable version to ${destination}, creating a ` +
        `${(input.creation?.private ?? true) ? "private" : "public"} repository only when absent, ` +
        `from ${parts.length} exact protected-main parts.`,
      deniedReason: `Publishing ${input.templateName} to ${destination} was not allowed`,
      dedupKey: `template-publication:${requestDigest}`,
      resource: {
        type: "external-repository",
        label: "Destination",
        value: destination,
      },
      operation: {
        kind: "git" as const,
        verb: "publish an immutable template version",
        object: {
          type: "external-repository",
          label: "Repository",
          value: destination,
        },
        groupKey: `template-publication:${credential}:${provider}:${owner}/${repoName}`,
      },
      substance: {
        kind: "change-set" as const,
        summary: `Publish ${input.templateName} ${input.version} from exact protected main`,
        facts: [
          { label: "Protected main", value: input.expectedMainEventId },
          { label: "Version", value: input.version },
          { label: "Manifest", value: input.manifestDigest },
          {
            label: "Parts",
            value: parts.map(({ repoPath, subdir }) => `${repoPath} → ${subdir}`).join(", "),
          },
        ],
      },
      details: [
        { label: "Template", value: input.templateName },
        { label: "Destination", value: destination },
        { label: "Operation", value: input.operationId },
      ],
    },
  });
}

function providerDisplayName(provider: string): string {
  if (provider.toLowerCase() === "github") return "GitHub";
  return provider
    .replace(/[-_]+/gu, " ")
    .replace(/\b\p{L}/gu, (character) => character.toUpperCase());
}

async function resolveConfiguredCredential(
  deps: Pick<GitInteropServiceDeps, "workspaceId" | "workspaceConfig" | "resolveCredential">,
  repoPathInput: string,
  options?: {
    remote?: string;
    credentialIdOverride?: string | null;
  }
): Promise<string | null | undefined> {
  if (options?.credentialIdOverride !== undefined) return options.credentialIdOverride;
  if (!deps.workspaceConfig) return undefined;
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const upstream = getDeclaredUpstreamForRepo(deps.workspaceConfig, repoPath);
  if (!upstream?.credential) return null;
  const remoteName = options?.remote ?? upstream.remote;
  const remote = getDeclaredRemoteForRepo(deps.workspaceConfig, repoPath, remoteName);
  if (!remote) throw new Error(`No approved remote ${remoteName} is declared for ${repoPath}`);
  if (!deps.workspaceId || !deps.resolveCredential) {
    throw new Error(
      `Git credential "${upstream.credential}" cannot be resolved because profile credential selection is unavailable`
    );
  }
  const credentialId = await deps.resolveCredential({
    workspaceId: deps.workspaceId,
    name: upstream.credential,
    url: remote.url,
  });
  if (!credentialId) {
    throw new Error(
      `No active profile credential named "${upstream.credential}" authorizes Git HTTP access to ${remote.url}`
    );
  }
  return credentialId;
}

async function invokeGitProviderOperation<M extends GitInteropProviderOperation>(
  deps: Pick<GitInteropServiceDeps, "invokeGitProvider">,
  ctx: ServiceContext,
  method: M,
  args: unknown[]
): Promise<GitInteropProviderResult<M>> {
  const contract = gitInteropProviderMethods[method];
  const parsedArgs = contract.args.safeParse(args);
  if (!parsedArgs.success) {
    throw new Error(`Invalid gitInterop.${method} arguments: ${parsedArgs.error.message}`);
  }
  const result = await invokeConfiguredGitProvider(
    deps,
    ctx,
    method,
    parsedArgs.data as GitInteropProviderArgs<M>
  );
  return result;
}

async function invokeConfiguredGitProvider<M extends GitInteropProviderMethod>(
  deps: Pick<GitInteropServiceDeps, "invokeGitProvider">,
  ctx: ServiceContext,
  method: M,
  args: GitInteropProviderArgs<M>
): Promise<GitInteropProviderResult<M>> {
  if (!deps.invokeGitProvider) {
    throw new Error("Git upstream provider is unavailable");
  }
  const contract = gitInteropProviderMethods[method];
  const parsedArgs = contract.args.safeParse(args);
  if (!parsedArgs.success) {
    throw new Error(`Invalid gitInterop.${method} provider arguments: ${parsedArgs.error.message}`);
  }
  const result = await deps.invokeGitProvider(
    ctx,
    method,
    parsedArgs.data as GitInteropProviderArgs<M>
  );
  const parsedResult = contract.returns.safeParse(result);
  if (!parsedResult.success) {
    throw new Error(`Invalid gitInterop.${method} provider result: ${parsedResult.error.message}`);
  }
  return parsedResult.data as GitInteropProviderResult<M>;
}

/**
 * Remove upstream tracking (and optionally the declared remote) in ONE config
 * persist — never the two-call remove-upstream-then-remove-remote sequence
 * whose second half can be denied, leaving half-detached config reported as
 * success.
 */
async function detachUpstream(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
  repoPath: string,
  options: GitDetachUpstreamOptions | undefined
): Promise<GitDetachUpstreamResult> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, repoPath);
  const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
  let existing: ReturnType<typeof getDeclaredUpstreamForRepo> = null;
  try {
    existing = getDeclaredUpstreamForRepo(deps.workspaceConfig, validRepoPath);
  } catch {
    existing = null;
  }
  const forgetRemote = options?.forgetRemote === true;
  const remoteName = forgetRemote ? (options?.remote ?? existing?.remote ?? "origin") : null;

  const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
    mutate: (currentConfig) => {
      const withoutUpstream = removeDeclaredUpstreamFromConfig(currentConfig, validRepoPath);
      return forgetRemote && remoteName
        ? removeDeclaredRemoteFromConfig(withoutUpstream, validRepoPath, remoteName)
        : withoutUpstream;
    },
    summary:
      workspaceConfigUpstreamSummary(validRepoPath, existing, "remove") +
      (forgetRemote && remoteName ? ` and removes remote ${remoteName}` : ""),
  });
  await propagateSharedRemote(deps, validRepoPath);
  deps.requestGitReconciliation?.([validRepoPath]);
  return {
    upstreams: persisted.nextConfig.git?.upstreams ?? {},
    remotes: persisted.nextConfig.git?.remotes ?? {},
    removedRemote: forgetRemote ? remoteName : null,
  };
}

async function importWorkspaceRepo(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
  request: GitImportProjectRequest
): Promise<GitImportedWorkspaceRepo> {
  if (!deps.workspacePath) throw new Error("No workspace path configured");
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  if (!deps.invokeGitProvider) throw new Error("Project import is unavailable");

  const { normalizedRepoPath } = resolveWorkspaceRepoPath(deps.workspacePath, request.path);
  const validRepoPath = normalizeWorkspaceRepoPath(normalizedRepoPath);
  if (!isSupportedImportRepoPath(validRepoPath)) {
    throw new Error(`Imports must target one of: ${WORKSPACE_IMPORT_PARENT_DIRS.join(", ")}`);
  }
  let normalizedRemote = validateWorkspaceGitRemote(request.remote);
  const requestedBranch = normalizedRemote.branch;
  const existingRemote = getDeclaredRemoteForRepo(
    deps.workspaceConfig,
    validRepoPath,
    normalizedRemote.name
  );
  const existingUpstream = getDeclaredUpstreamConfigOrNull(deps.workspaceConfig, validRepoPath);
  const declarationConflicts: string[] = [];
  if (existingRemote && existingRemote.url !== normalizedRemote.url) {
    declarationConflicts.push(
      `remote ${normalizedRemote.name} URL is ${existingRemote.url}, requested ${normalizedRemote.url}`
    );
  }
  if (existingUpstream && existingUpstream.remote !== normalizedRemote.name) {
    declarationConflicts.push(
      `upstream selects ${existingUpstream.remote}, requested ${normalizedRemote.name}`
    );
  }
  if (normalizedRemote.branch && existingRemote?.branch !== undefined) {
    if (existingRemote.branch !== normalizedRemote.branch) {
      declarationConflicts.push(
        `remote ${normalizedRemote.name} branch is ${existingRemote.branch}, requested ${normalizedRemote.branch}`
      );
    }
  }
  const resolvedExistingUpstream =
    existingRemote && existingUpstream?.remote === normalizedRemote.name
      ? getDeclaredUpstreamForRepo(deps.workspaceConfig, validRepoPath)
      : null;
  if (
    requestedBranch &&
    resolvedExistingUpstream &&
    resolvedExistingUpstream.branch !== requestedBranch
  ) {
    declarationConflicts.push(
      `upstream branch is ${resolvedExistingUpstream.branch}, requested ${requestedBranch}`
    );
  }
  if (!existingRemote && existingUpstream) {
    declarationConflicts.push(`upstream selects missing remote ${existingUpstream.remote}`);
  }
  if (declarationConflicts.length > 0) {
    throw new Error(
      `Import declaration for ${validRepoPath} conflicts with meta/vibestudio.yml: ` +
        `${declarationConflicts.join("; ")}. Edit the remote/upstream declaration explicitly before importing.`
    );
  }

  if (existingRemote) {
    normalizedRemote = {
      name: existingRemote.name,
      url: existingRemote.url,
      ...(existingRemote.branch !== undefined
        ? { branch: existingRemote.branch }
        : existingUpstream?.branch !== undefined
          ? { branch: existingUpstream.branch }
          : {}),
    };
  } else if (!normalizedRemote.branch) {
    // No branch declared: resolve the remote's ACTUAL default (ls-remote
    // symref HEAD) instead of assuming `main`, and bake it into the declared
    // config so every later clone/push/pull tracks the real branch.
    const discovered = await invokeConfiguredGitProvider(deps, ctx, "remoteDefaultBranch", [
      {
        url: normalizedRemote.url,
        ...(request.credentialIdOverride !== undefined
          ? { credentialIdOverride: request.credentialIdOverride }
          : {}),
      },
    ]);
    if (!discovered.branch) {
      throw new Error(
        `Remote ${normalizedRemote.url} does not advertise a default branch; specify remote.branch explicitly`
      );
    }
    normalizedRemote = { ...normalizedRemote, branch: discovered.branch };
  }
  if (existingRemote && existingUpstream && existingUpstream.remote === normalizedRemote.name) {
    return cloneWorkspaceRepo(ctx, deps, {
      operation: "git.importProject",
      repoPath: validRepoPath,
      remote: normalizedRemote,
      credentialIdOverride: request.credentialIdOverride,
    });
  }

  const mutateConfig: WorkspaceConfigMutation = (currentConfig) => {
    previousDeclaration = snapshotWorkspaceRepoGitDeclaration(
      currentConfig,
      validRepoPath,
      normalizedRemote.name
    );
    const withRemote = previousDeclaration.remote
      ? currentConfig
      : setDeclaredRemoteInConfig(currentConfig, validRepoPath, normalizedRemote);
    return setDeclaredUpstreamInConfig(withRemote, validRepoPath, {
      remote: normalizedRemote.name,
      branch: normalizedRemote.branch,
      autoPush: false,
    });
  };
  let previousDeclaration: WorkspaceRepoGitDeclarationSnapshot | undefined;

  const persisted = await persistWorkspaceConfigMutation(ctx, deps, {
    mutate: mutateConfig,
    summary: workspaceConfigImportSummary(validRepoPath, normalizedRemote),
  });
  if (!previousDeclaration) {
    throw new Error(`Workspace config persistence did not evaluate the import of ${validRepoPath}`);
  }
  const declarationBeforeImport = previousDeclaration;
  const writtenDeclaration = snapshotWorkspaceRepoGitDeclaration(
    persisted.nextConfig,
    validRepoPath,
    normalizedRemote.name
  );
  return cloneWorkspaceRepo(ctx, deps, {
    operation: "git.importProject",
    repoPath: validRepoPath,
    remote: normalizedRemote,
    credentialIdOverride: request.credentialIdOverride,
    transaction: {
      changed: persisted.changed,
      rollbackIfCurrent: (currentConfig) =>
        isDeepStrictEqual(
          snapshotWorkspaceRepoGitDeclaration(currentConfig, validRepoPath, normalizedRemote.name),
          writtenDeclaration
        )
          ? restoreWorkspaceRepoGitDeclaration(
              currentConfig,
              validRepoPath,
              normalizedRemote.name,
              declarationBeforeImport
            )
          : currentConfig,
      matchesPrevious: (config) =>
        isDeepStrictEqual(
          snapshotWorkspaceRepoGitDeclaration(config, validRepoPath, normalizedRemote.name),
          declarationBeforeImport
        ),
    },
  });
}

async function cloneWorkspaceRepo(
  ctx: ServiceContext,
  deps: GitInteropServiceDeps,
  input: {
    operation: "git.importProject";
    repoPath: string;
    remote: WorkspaceGitRemoteConfig;
    credentialIdOverride?: string | null;
    transaction?: WorkspaceRepoConfigTransaction;
  }
): Promise<GitImportedWorkspaceRepo> {
  let candidate: GitImportResult;
  try {
    candidate = await invokeConfiguredGitProvider(deps, ctx, "cloneRepo", [
      {
        repoPath: input.repoPath,
        ...(input.credentialIdOverride !== undefined
          ? { credentialIdOverride: input.credentialIdOverride }
          : {}),
      },
    ]);
  } catch (err) {
    // Restore the declaration this operation replaced only while the values it
    // wrote are still current. A newer edit owns the declaration and must win.
    let rolledBack = false;
    let rollbackConflict = false;
    let rollbackFailure: unknown;
    if (input.transaction?.changed) {
      try {
        const rollback = await persistWorkspaceConfigMutation(ctx, deps, {
          mutate: input.transaction.rollbackIfCurrent,
          summary: `meta/vibestudio.yml rolls back failed import of ${input.repoPath}`,
        });
        rolledBack = input.transaction.matchesPrevious(rollback.nextConfig);
        rollbackConflict = !rolledBack;
      } catch (error) {
        rollbackFailure = error;
        // The error below reports that the declaration survived. There is no
        // source-tree notification: config persistence already publishes its
        // own semantic mutation, while Git checkout bytes live in host state.
      }
    }
    const detail = err instanceof Error ? err.message : String(err);
    const configOutcome = !input.transaction?.changed
      ? `Workspace Git configuration was unchanged.`
      : rolledBack
        ? `The workspace Git declaration was restored to its prior value.`
        : rollbackConflict
          ? `Workspace Git configuration changed again while the clone was running, so rollback ` +
            `was skipped to preserve the newer edit.`
          : `Workspace Git configuration WAS changed but could not be rolled back.`;
    const failure = new Error(
      `Import of ${input.repoPath} failed during clone: ${detail}. ` +
        `${configOutcome} Inspect meta/vibestudio.yml and \`vibestudio vcs git status\` before ` +
        `re-running the import because the Git provider may have retained import state.`,
      { cause: err }
    );
    Object.defineProperty(failure, "errorData", {
      value: {
        operation: input.operation,
        repoPath: input.repoPath,
        stage: "clone",
        primary: operationErrorDetail(err),
        config: {
          changed: input.transaction?.changed ?? false,
          rolledBack,
          ...(rollbackConflict ? { rollbackConflict: true } : {}),
          ...(rollbackFailure === undefined
            ? {}
            : { rollbackFailure: operationErrorDetail(rollbackFailure) }),
        },
      },
      writable: true,
      configurable: true,
    });
    throw failure;
  }
  return { path: input.repoPath, remote: input.remote, candidate };
}

function snapshotWorkspaceRepoGitDeclaration(
  config: WorkspaceConfig,
  repoPath: string,
  remoteName: string
): WorkspaceRepoGitDeclarationSnapshot {
  const remote = getDeclaredRemoteForRepo(config, repoPath, remoteName);
  return {
    remote:
      remote === null
        ? null
        : {
            name: remote.name,
            url: remote.url,
            ...(remote.branch !== undefined ? { branch: remote.branch } : {}),
          },
    upstream: getDeclaredUpstreamConfigOrNull(config, repoPath),
  };
}

function restoreWorkspaceRepoGitDeclaration(
  config: WorkspaceConfig,
  repoPath: string,
  remoteName: string,
  snapshot: WorkspaceRepoGitDeclarationSnapshot
): WorkspaceConfig {
  const withRemote =
    snapshot.remote === null
      ? removeDeclaredRemoteFromConfig(config, repoPath, remoteName)
      : setDeclaredRemoteInConfig(config, repoPath, snapshot.remote);
  return snapshot.upstream === null
    ? removeDeclaredUpstreamFromConfig(withRemote, repoPath)
    : setDeclaredUpstreamInConfig(withRemote, repoPath, snapshot.upstream);
}

function getDeclaredUpstreamConfigOrNull(
  config: WorkspaceConfig,
  repoPathInput: string
): WorkspaceGitUpstreamConfig | null {
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const [section, ...repoParts] = repoPath.split("/");
  if (!section) return null;
  const declaration = config.git?.upstreams?.[section]?.[repoParts.join("/")];
  return declaration === undefined ? null : validateWorkspaceGitUpstream(declaration);
}

async function persistWorkspaceConfigMutation(
  ctx: ServiceContext,
  deps: Pick<GitInteropServiceDeps, "workspaceConfig" | "persistWorkspaceConfigMutation">,
  input: {
    mutate: WorkspaceConfigMutation;
    summary: string;
  }
): Promise<WorkspaceConfigMutationResult> {
  if (!deps.workspaceConfig) throw new Error("Workspace config is unavailable");
  if (!deps.persistWorkspaceConfigMutation) {
    throw new Error("Workspace config persistence is unavailable");
  }
  const result = await deps.persistWorkspaceConfigMutation({
    ctx,
    mutate: input.mutate,
    summary: input.summary,
  });
  mutateWorkspaceConfig(deps.workspaceConfig, result.nextConfig);
  return result;
}

async function propagateSharedRemote(
  deps: Pick<GitInteropServiceDeps, "workspacePath" | "workspaceConfig">,
  repoPath: string
): Promise<void> {
  if (!deps.workspacePath || !deps.workspaceConfig) return;
  await syncDeclaredRemoteForRepo({
    config: deps.workspaceConfig,
    workspaceRoot: deps.workspacePath,
    repoPath,
  });
}

function mutateWorkspaceConfig(target: WorkspaceConfig, next: WorkspaceConfig): void {
  for (const key of Object.keys(target) as Array<keyof WorkspaceConfig>) {
    deleteDynamicProperty(target, key);
  }
  Object.assign(target, next);
}

function getRemoteForApproval(
  config: WorkspaceConfig,
  repoPath: string,
  remoteName: string
): WorkspaceGitRemoteConfig {
  const normalizedRemoteName = validateWorkspaceGitRemoteName(remoteName);
  const remote = getDeclaredRemoteForRepo(config, repoPath, remoteName);
  return remote ? { name: remote.name, url: remote.url } : { name: normalizedRemoteName, url: "" };
}

function displayRemoteUrl(value: string): string {
  return normalizeRemoteUrl(value).replace(/^https?:\/\//, "");
}

function workspaceConfigImportSummary(unitPath: string, remote: WorkspaceGitRemoteConfig): string {
  const branch = remote.branch ? ` on ${remote.branch}` : "";
  return `meta/vibestudio.yml records ${remote.name}=${displayRemoteUrl(remote.url)} for ${unitPath}${branch}`;
}

function workspaceConfigRemoteSummary(
  unitPath: string,
  remote: WorkspaceGitRemoteConfig,
  operation: "set" | "remove"
): string {
  if (operation === "remove") {
    return `meta/vibestudio.yml removes ${remote.name} for ${unitPath}`;
  }
  return workspaceConfigImportSummary(unitPath, remote);
}

function workspaceConfigUpstreamSummary(
  unitPath: string,
  upstream: Pick<
    WorkspaceGitUpstreamConfig,
    "remote" | "branch" | "autoPush" | "credential"
  > | null,
  operation: "set" | "remove"
): string {
  if (operation === "remove") {
    return `meta/vibestudio.yml removes upstream tracking for ${unitPath}`;
  }
  const branch = upstream?.branch ? ` ${upstream.branch}` : "";
  const autoPush = upstream?.autoPush ? "auto-push on" : "auto-push off";
  const credentials = upstream?.credential
    ? `logical credential ${upstream.credential}`
    : "anonymous Git HTTP";
  return (
    `meta/vibestudio.yml tracks ${unitPath} on ${upstream?.remote ?? "origin"}${branch} ` +
    `(${autoPush}, ${credentials})`
  );
}
