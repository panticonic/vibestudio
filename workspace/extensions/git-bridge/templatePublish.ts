import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  canonicalSnapshotDigest,
  compareUtf16CodeUnits,
  sha256Hex,
} from "@vibestudio/content-addressing";
import { GitClient, withTemporaryGitCheckout } from "@vibestudio/git";
import type {
  GitTemplatePublishInput,
  GitTemplatePublishResult,
} from "@vibestudio/service-schemas/gitInterop";
import { normalizeWorkspaceRepoPath } from "@vibestudio/workspace/remotes";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import { resolveGitHubPublishOperation } from "@workspace/integrations/github";
import { getRemoteProvider } from "@workspace/integrations/remoteProviders";
import { GitBridge, type ProtectedRepositorySnapshot } from "./bridge.js";
import type { ExtensionContextLike } from "./context.js";

const MANIFEST_PATH = "meta/template.yml";
const BRANCH = "main";

function safeJoin(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split("/"));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Template publication path escapes checkout: ${relative}`);
  }
  return target;
}

function versionTag(value: string): string {
  return value.startsWith("v") ? value : `v${value}`;
}

interface PartSnapshot {
  repoPath: string;
  subdir: string;
  snapshot: ProtectedRepositorySnapshot;
}

export class TemplatePublishEngine {
  constructor(
    private readonly ctx: ExtensionContextLike,
    private readonly bridge: GitBridge
  ) {}

  async publish(input: GitTemplatePublishInput): Promise<GitTemplatePublishResult> {
    const providerId = input.destination.provider ?? "github";
    const provider = getRemoteProvider(providerId);
    if (!provider) throw new Error(`Unknown remote provider: ${providerId}`);
    const repoName = input.destination.name ?? input.templateName;
    if (repoName.includes("/")) throw new Error("Template repository name must not contain '/'");
    if (`v1-sha256:${sha256Hex(new TextEncoder().encode(input.manifest))}` !== input.manifestDigest) {
      throw new Error("Template manifest bytes do not match the inspected manifest digest");
    }
    const seen = new Set<string>();
    const parts = input.parts
      .map((part) => ({
        repoPath: normalizeWorkspaceRepoPath(part.repoPath),
        subdir: normalizeWorkspaceRepoPath(part.subdir),
      }))
      .sort((left, right) => compareUtf16CodeUnits(left.repoPath, right.repoPath));
    for (const part of parts) {
      if (seen.has(part.repoPath)) throw new Error(`Duplicate template part ${part.repoPath}`);
      seen.add(part.repoPath);
    }
    const snapshots: PartSnapshot[] = [];
    for (const part of parts) {
      snapshots.push({
        ...part,
        snapshot: await this.bridge.readProtectedRepository(
          part.repoPath,
          input.expectedMainEventId
        ),
      });
    }

    let organization = input.destination.organization?.trim() || undefined;
    let credentialId = input.destination.credentialId?.trim() || undefined;
    if (providerId === "github") {
      const resolved = await resolveGitHubPublishOperation(this.ctx.credentials, {
        ...(credentialId ? { credentialId } : {}),
        ...(organization ? { organization } : {}),
      });
      credentialId = resolved.credentialId;
      organization = resolved.organization;
    }
    const created = await provider.createRepo(this.ctx.credentials, {
      name: repoName,
      ...(organization ? { organization } : {}),
      private: input.destination.private ?? true,
      description: input.destination.description ?? input.templateName,
      ...(credentialId ? { credentialId } : {}),
    });
    const git = new GitClient(fsp, {
      http: this.ctx.credentials.gitHttp({ credentialId: credentialId ?? null }),
    });
    const info = await this.ctx.workspace.getInfo();
    return withTemporaryGitCheckout(
      fsp,
      path.join(info.statePath, "git-checkouts", "_template-publications"),
      input.operationId,
      async (checkout) => {
        await git.init(checkout, BRANCH);
        const manifestPath = safeJoin(checkout, MANIFEST_PATH);
        await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
        await fsp.writeFile(manifestPath, input.manifest, "utf8");
        const digestEntries = [
          {
            path: MANIFEST_PATH,
            contentHash: sha256Hex(new TextEncoder().encode(input.manifest)),
            size: new TextEncoder().encode(input.manifest).byteLength,
            mode: 0o100644,
          },
        ];
        for (const part of snapshots) {
          for (const file of part.snapshot.files) {
            const relative = `${part.subdir}/${file.path}`;
            const destination = safeJoin(checkout, relative);
            await fsp.mkdir(path.dirname(destination), { recursive: true });
            await fsp.writeFile(destination, file.bytes);
            await fsp.chmod(destination, file.mode & 0o111 ? 0o755 : 0o644);
            digestEntries.push({
              path: relative,
              contentHash: file.contentHash,
              size: file.size,
              mode: file.mode === 0o755 ? 0o100755 : 0o100644,
            });
          }
        }
        await git.addAll(checkout);
        const commit = await git.commit({
          dir: checkout,
          message:
            `Publish ${input.templateName} ${versionTag(input.version)}\n\n` +
            `Vibestudio-Template-Operation: ${input.operationId}\n` +
            `Vibestudio-State: ${input.expectedMainEventId}\n` +
            `Vibestudio-Template-Manifest: ${input.manifestDigest}`,
          author: { name: "Vibestudio", email: "vibestudio@local" },
        });
        try {
          await git.push({
            dir: checkout,
            url: created.cloneUrl,
            ref: BRANCH,
            remoteRef: `refs/heads/${BRANCH}`,
          });
          const tag = versionTag(input.version);
          await git.push({
            dir: checkout,
            url: created.cloneUrl,
            ref: BRANCH,
            remoteRef: `refs/tags/${tag}`,
          });
          return {
            operationId: input.operationId,
            provider: provider.id,
            remoteUrl: created.cloneUrl,
            webUrl: created.webUrl,
            templateUrl: normalizeTemplateGitUrl(created.cloneUrl),
            ref: `refs/tags/${tag}`,
            commit,
            snapshot: canonicalSnapshotDigest(digestEntries),
            parts: parts.map(({ repoPath }) => repoPath),
          };
        } catch (error) {
          throw new Error(
            `Created ${created.webUrl}, but publishing ${input.templateName} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error }
          );
        }
      }
    );
  }
}
