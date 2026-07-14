import { describe, expect, it } from "vitest";
import {
  SHA2_256_HASH_ALGORITHM,
  bytesFromHex,
  bytesToHex,
  objectRefKey,
} from "@vibestudio/shared/contentStore/exactContentStore";
import {
  VIBE_BLOB_CODEC,
  contentStoreRefForSha256,
} from "@vibestudio/shared/contentStore/vibeContentCodecs";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import { sha256HexSyncText } from "@vibestudio/shared/contentTree/worktreeHash";
import { EditEngine, type WorkingFileEntry } from "@workspace/vcs-engine";
import {
  GAD_EXTERNAL_REF_COLUMNS_V1,
  GAD_HUNK_CODEC_V1,
  asGadCommitIntentId,
  asGadEditId,
  asGadFileId,
  asGadHunkId,
  createGadContextManifestTemplateV1,
  createGadWorkingSnapshotManifestTemplateV1,
  extractGadExternalObjectManifestV1,
  planSelectedCommitV1,
  projectGadFilesToVibeWorktreeV1,
  type GadCommitIntentRowV1,
  type GadEditRowV1,
  type GadFileRowV1,
  type GadHunkRowV1,
} from "./index.js";

const STORE_ID = bytesFromHex("6761642d76312d66697874757265");

function hunkRef(value: unknown) {
  return contentStoreRefForSha256(
    STORE_ID,
    GAD_HUNK_CODEC_V1,
    sha256HexSyncText(canonicalJson(value))
  );
}

describe("portable Gad repository v1 fixture", () => {
  it("preserves working/commit separation, roots refs, and projects legacy tree bytes", async () => {
    const blobs = new Map<string, Uint8Array>();
    const putText = (text: string): string => {
      const digest = sha256HexSyncText(text);
      blobs.set(digest, new TextEncoder().encode(text));
      return digest;
    };
    const selectedV1 = putText("selected v1\n");
    const excludedV1 = putText("excluded v1\n");
    const engine = new EditEngine({
      readBlob: async (digest) => blobs.get(digest)?.slice() ?? null,
      writeBlob: async (bytes) => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const digest = putText(text);
        return { digest, size: bytes.byteLength };
      },
    });
    const committedFiles = new Map<string, WorkingFileEntry>([
      ["src/selected.txt", { path: "src/selected.txt", contentHash: selectedV1, mode: 33188 }],
      ["src/excluded.txt", { path: "src/excluded.txt", contentHash: excludedV1, mode: 33188 }],
    ]);
    const edited = await engine.applyEditOps(committedFiles, [
      { kind: "write", path: "src/selected.txt", content: { kind: "text", text: "selected v2\n" } },
      { kind: "write", path: "src/excluded.txt", content: { kind: "text", text: "excluded v2\n" } },
    ]);

    const fileIds = new Map([
      ["src/selected.txt", asGadFileId("file.fixture.selected")],
      ["src/excluded.txt", asGadFileId("file.fixture.excluded")],
    ]);
    const files: GadFileRowV1[] = [...edited.files.values()].map((file) => ({
      fileId: fileIds.get(file.path)!,
      path: file.path,
      blobRef: contentStoreRefForSha256(STORE_ID, VIBE_BLOB_CODEC, file.contentHash),
      mode: file.mode,
    }));
    const editIds = [asGadEditId("edit.fixture.selected"), asGadEditId("edit.fixture.excluded")];
    const edits: GadEditRowV1[] = edited.rows.map((row, index) => ({
      editId: editIds[index]!,
      fileId: fileIds.get(row.path)!,
      commitIntentId: null,
      invocationId: "invocation.fixture",
      turnId: "turn.fixture",
      actorRef: "actor:fixture",
      ordinal: index,
      kind: row.kind,
      path: row.path,
      oldBlobRef: row.oldContentHash
        ? contentStoreRefForSha256(STORE_ID, VIBE_BLOB_CODEC, row.oldContentHash)
        : null,
      newBlobRef: row.newContentHash
        ? contentStoreRefForSha256(STORE_ID, VIBE_BLOB_CODEC, row.newContentHash)
        : null,
      binary: row.binary ?? false,
      synthetic: false,
    }));
    const hunks: GadHunkRowV1[] = edited.rows.map((row, index) => ({
      hunkId: asGadHunkId(`hunk.fixture.${index}`),
      editId: editIds[index]!,
      ordinal: 0,
      start: 0,
      end: index === 0 ? "selected v1\n".length : "excluded v1\n".length,
      bodyRef: hunkRef(row.hunks),
      origin: null,
      theirsStart: null,
      theirsEnd: null,
    }));

    // A working snapshot may have a physical immutable database output, but
    // it contains no user commit intent and every edit remains uncommitted.
    const working = { edits, hunks, commitIntents: [] } as const;
    const workingTemplate = createGadWorkingSnapshotManifestTemplateV1({
      database: { kind: "databaseOutput", outputName: "working" },
      committedBase: { kind: "artifactTemplate", artifactName: "committed_base" },
      status: "dirty",
      externalObjects: { kind: "artifactTemplate", artifactName: "working_external" },
      worktreeTree: {
        storeIdHex: bytesToHex(STORE_ID),
        codecNumber: 0x56425431,
        codecVersion: 1,
        hashAlgorithm: SHA2_256_HASH_ALGORITHM,
        digestHex: "00".repeat(32),
      },
    });
    expect(workingTemplate.kind).toBe("gad.workingSnapshot");
    expect(working.commitIntents).toHaveLength(0);
    expect(working.edits.every((edit) => edit.commitIntentId === null)).toBe(true);

    const intent: GadCommitIntentRowV1 = {
      commitIntentId: asGadCommitIntentId("commit.fixture.selected"),
      operation: "commit",
      message: "commit only selected.txt",
      actorRef: "actor:fixture",
      invocationId: "invocation.fixture",
      turnId: "turn.fixture",
      logicalTime: "2026-07-14T00:00:00.000Z",
      groupId: null,
      rebasedFromIntentId: null,
    };
    const selection = planSelectedCommitV1(working, [editIds[0]!], intent);
    expect(selection.selectedEdits.map((edit) => [edit.path, edit.commitIntentId])).toEqual([
      ["src/selected.txt", intent.commitIntentId],
    ]);
    expect(selection.residualWorkingEdits.map((edit) => [edit.path, edit.commitIntentId])).toEqual([
      ["src/excluded.txt", null],
    ]);
    expect(selection.selectedHunks.map((hunk) => hunk.editId)).toEqual([editIds[0]]);
    expect(selection.residualWorkingHunks.map((hunk) => hunk.editId)).toEqual([editIds[1]]);

    expect(GAD_EXTERNAL_REF_COLUMNS_V1.map(({ table, field }) => `${table}.${field}`)).toEqual([
      "vcs_files.blobRef",
      "vcs_edit_ops.oldBlobRef",
      "vcs_edit_ops.newBlobRef",
      "vcs_edit_hunks.bodyRef",
    ]);
    const external = extractGadExternalObjectManifestV1({ files, edits, hunks });
    const keys = external.entries.map((entry) => objectRefKey(entry.object));
    expect(keys).toEqual([...keys].sort());
    const expectedKeys = new Set([
      ...files.map((file) => objectRefKey(file.blobRef)),
      ...edits.flatMap((edit) =>
        [edit.oldBlobRef, edit.newBlobRef]
          .filter((ref) => ref !== null)
          .map((ref) => objectRefKey(ref))
      ),
      ...hunks.map((hunk) => objectRefKey(hunk.bodyRef)),
    ]);
    expect(new Set(keys)).toEqual(expectedKeys);
    expect(external.entries.flatMap((entry) => entry.sources)).toHaveLength(8);

    const projection = projectGadFilesToVibeWorktreeV1(files);
    expect(projection.rootTreeHash).toBe(
      "manifest:84785e2742e025f2a45de5196b8e6886cc363737aa7c0a6e5cffe69f1dc0e8d9"
    );
    expect(projection.stateHash).toBe(
      "state:df1134d82fd5b7c23f90f664f8f482c25b59fd7be9d0e366ef4179b1c040a6f9"
    );
    expect(projection.nodes.map((node) => node.canonicalText)).toEqual([
      '{"entries":[{"contentHash":"dc23e1a9580ca92870d74c54746158f7faa5975cdd34221bbfb9524dbbc8e2ba","kind":"file","mode":33188,"name":"excluded.txt"},{"contentHash":"e5751497d54a04dadfb810d8f1633f4a08dd8e75c9ad962d5243d1f0ff601aa1","kind":"file","mode":33188,"name":"selected.txt"}],"kind":"dir"}',
      '{"entries":[{"childHash":"manifest:5c31e1af7df487e24f7fbdedf7e7e9c490f7a2ade22aa6b99caa07a3db57a8a3","kind":"dir","name":"src"}],"kind":"dir"}',
    ]);
    expect(projection.stateNode.canonicalText).toBe(
      '{"manifestRootHash":"manifest:84785e2742e025f2a45de5196b8e6886cc363737aa7c0a6e5cffe69f1dc0e8d9"}'
    );

    const context = createGadContextManifestTemplateV1({
      contextId: "context.fixture",
      parentContextId: null,
      forkPointManifestId: null,
      baseRepositories: { kind: "artifactTemplate", artifactName: "base_repositories" },
      overrides: [
        {
          repoPath: "workers/z-last",
          state: "present",
          committed: { kind: "artifactTemplate", artifactName: "repository" },
          working: { kind: "artifactTemplate", artifactName: "working_snapshot" },
        },
        { repoPath: "meta", state: "deleted" },
      ],
    });
    expect(context.overrides.map((entry) => entry.repoPath)).toEqual(["meta", "workers/z-last"]);
  });
});
