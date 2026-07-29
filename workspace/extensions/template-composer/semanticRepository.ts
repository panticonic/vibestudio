import { canonicalSnapshotDigest } from "@vibestudio/content-addressing";
import type { VcsListFilesResult, VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import type { TemplateCompositionPlan } from "@workspace/template-composer";
import type { ExtensionContextLike } from "./context.js";

export type SemanticRepositoryFile = NonNullable<VcsListFilesResult>["files"][number];

export async function listSemanticRepositoryFiles(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
  repositoryId: string
): Promise<SemanticRepositoryFile[]> {
  const files: SemanticRepositoryFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.rpc.call<VcsListFilesResult>("main", "vcs.listFiles", {
      state,
      repositoryId,
      ...(cursor ? { cursor } : {}),
      limit: 500,
    });
    if (!page) throw new Error(`Semantic repository ${repositoryId} disappeared`);
    files.push(...page.files);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return files;
}

export function semanticRepositoryDigest(
  files: readonly Pick<SemanticRepositoryFile, "path" | "contentHash" | "byteLength" | "mode">[]
) {
  return canonicalSnapshotDigest(
    files.map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      size: file.byteLength,
      mode: file.mode === 0o755 ? 0o100755 : 0o100644,
    }))
  );
}

export function semanticRepositoryMatches(
  actual: readonly SemanticRepositoryFile[],
  desired: TemplateCompositionPlan["repositories"][string]["files"]
): boolean {
  return (
    actual.length === desired.length &&
    actual.every((file, index) => {
      const expected = desired[index];
      return (
        expected !== undefined &&
        file.path === expected.path &&
        file.contentHash === expected.contentHash &&
        file.mode === expected.mode
      );
    })
  );
}
