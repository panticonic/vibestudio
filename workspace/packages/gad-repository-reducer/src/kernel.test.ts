import { describe, expect, it } from "vitest";
import {
  bytesFromHex,
  bytesToHex,
  cloneObjectRef,
  objectRefKey,
  type ContentStoreCodecId,
  type ContentStoreObjectRef,
} from "@vibestudio/shared/contentStore/exactContentStore";
import {
  VIBE_BLOB_CODEC,
  contentStoreRefForSha256,
} from "@vibestudio/shared/contentStore/vibeContentCodecs";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import { sha256HexSyncText } from "@vibestudio/shared/contentTree/worktreeHash";
import {
  asGadCommitIntentId,
  asGadEditId,
  asGadFileId,
  canonicalizeGadObjectRefV1,
  projectGadFilesToVibeWorktreeV1,
  type GadCommitIntentRowV1,
  type GadEditRowV1,
} from "@workspace/gad-repository-contract";
import {
  GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION,
  asGadDoltCommitHash,
  cloneRepositoryImageV1,
  cloneWorkingImageV1,
  computePortableGadExactMergeV1,
  normalizeRepositoryImageV1,
  normalizeWorkingImageV1,
  runGadRepositoryReducerV1,
  sameRepositoryDatabaseRefV1,
  type GadExactMergeAdapterRequestV1,
  type GadDoltCommitHash,
  type GadFinalizeRepositoryRequestV1,
  type GadFinalizeWorkingRequestV1,
  type GadPortableMergeOperandV1,
  type GadRepositoryDatabaseRefV1,
  type GadRepositoryImageV1,
  type GadRepositoryReducerHostAdapterV1,
  type GadRepositoryReducerRequestV1,
  type GadWorkingDatabaseRefV1,
  type GadWorkingImageV1,
} from "./index.js";

const STORE_ID = bytesFromHex("6761642d726564756365722d7631");
const DATABASE_CODEC: ContentStoreCodecId = { number: 0x47444442, version: 1 };
const utf8 = new TextEncoder();

function intent(
  id: string,
  operation: GadCommitIntentRowV1["operation"] = "commit"
): GadCommitIntentRowV1 {
  return {
    commitIntentId: asGadCommitIntentId(id),
    operation,
    message: id,
    actorRef: "actor:test",
    invocationId: `invocation:${id}`,
    turnId: `turn:${id}`,
    logicalTime: "2026-07-14T00:00:00.000Z",
    groupId: null,
    rebasedFromIntentId: null,
  };
}

function canonicalImage(image: GadRepositoryImageV1): unknown {
  return {
    ...image,
    files: image.files.map((file) => ({
      ...file,
      blobRef: canonicalizeGadObjectRefV1(file.blobRef),
    })),
    edits: image.edits.map((edit) => ({
      ...edit,
      oldBlobRef: edit.oldBlobRef ? canonicalizeGadObjectRefV1(edit.oldBlobRef) : null,
      newBlobRef: edit.newBlobRef ? canonicalizeGadObjectRefV1(edit.newBlobRef) : null,
    })),
    hunks: image.hunks.map((hunk) => ({
      ...hunk,
      bodyRef: canonicalizeGadObjectRefV1(hunk.bodyRef),
    })),
  };
}

function canonicalWorking(image: GadWorkingImageV1): unknown {
  return canonicalImage({
    schemaVersion: 1,
    files: image.files,
    edits: image.edits,
    hunks: image.hunks,
    commitIntents: [],
    headCommitIntentId: null,
  });
}

class MemoryExactHistoryHost implements GadRepositoryReducerHostAdapterV1 {
  readonly mergeRequests: GadExactMergeAdapterRequestV1[] = [];
  readonly repositoryFinalizations: GadFinalizeRepositoryRequestV1[] = [];
  readonly workingFinalizations: GadFinalizeWorkingRequestV1[] = [];
  readonly publicationSideEffects = 0;

  private readonly objects = new Map<string, Uint8Array>();
  private readonly repositories = new Map<
    string,
    { ref: GadRepositoryDatabaseRefV1; image: GadRepositoryImageV1; parents: GadDoltCommitHash[] }
  >();
  private readonly workings = new Map<string, GadWorkingImageV1>();

  getContentStoreId(): Uint8Array {
    return STORE_ID.slice();
  }

  async readExactObject(object: ContentStoreObjectRef): Promise<Uint8Array | null> {
    return this.objects.get(objectRefKey(object))?.slice() ?? null;
  }

  async putExactObject(
    codec: ContentStoreCodecId,
    bytes: Uint8Array
  ): Promise<ContentStoreObjectRef> {
    const copied = Uint8Array.from(bytes);
    const digest = bytesToHex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", copied.buffer))
    );
    const object = contentStoreRefForSha256(STORE_ID, codec, digest);
    const key = objectRefKey(object);
    const previous = this.objects.get(key);
    if (previous && bytesToHex(previous) !== bytesToHex(bytes)) {
      throw new Error("test exact object hash collision");
    }
    this.objects.set(key, bytes.slice());
    return cloneObjectRef(object);
  }

  async putText(text: string): Promise<ContentStoreObjectRef> {
    return await this.putExactObject(VIBE_BLOB_CODEC, utf8.encode(text));
  }

  async loadRepository(ref: GadRepositoryDatabaseRefV1): Promise<GadRepositoryImageV1> {
    const entry = this.repositories.get(ref.commitHash);
    if (!entry || !sameRepositoryDatabaseRefV1(entry.ref, ref)) {
      throw new Error(`unknown test repository: ${ref.commitHash}`);
    }
    return cloneRepositoryImageV1(entry.image);
  }

  async loadWorking(ref: GadWorkingDatabaseRefV1): Promise<GadWorkingImageV1> {
    const image = this.workings.get(canonicalJson(ref.database));
    if (!image) throw new Error("unknown test working database");
    return cloneWorkingImageV1(image);
  }

  async finalizeRepository(
    request: GadFinalizeRepositoryRequestV1
  ): Promise<GadRepositoryDatabaseRefV1> {
    const image = normalizeRepositoryImageV1(request.image);
    const preimage = canonicalJson({
      kind: "test.gad.repositoryDatabase",
      source: request.source,
      image: canonicalImage(image),
      parents: request.parents,
      intent: request.intent,
      purpose: request.physicalPurpose,
    });
    const digest = sha256HexSyncText(preimage);
    const ref: GadRepositoryDatabaseRefV1 = {
      kind: "gad.repositoryDatabase",
      database: canonicalizeGadObjectRefV1(
        contentStoreRefForSha256(STORE_ID, DATABASE_CODEC, digest)
      ),
      commitHash: asGadDoltCommitHash(digest.slice(0, 40)),
    };
    const previous = this.repositories.get(ref.commitHash);
    if (previous && canonicalJson(canonicalImage(previous.image)) !== canonicalJson(canonicalImage(image))) {
      throw new Error("test repository commit collision");
    }
    this.repositories.set(ref.commitHash, {
      ref,
      image: cloneRepositoryImageV1(image),
      parents: [...request.parents],
    });
    this.repositoryFinalizations.push({
      ...request,
      image: cloneRepositoryImageV1(image),
      parents: [...request.parents],
      intent: { ...request.intent },
    });
    return ref;
  }

  async finalizeWorking(request: GadFinalizeWorkingRequestV1): Promise<GadWorkingDatabaseRefV1> {
    const image = normalizeWorkingImageV1(request.image);
    const digest = sha256HexSyncText(
      canonicalJson({
        kind: "test.gad.workingDatabase",
        source: request.source,
        committedBase: request.committedBase,
        image: canonicalWorking(image),
      })
    );
    const ref: GadWorkingDatabaseRefV1 = {
      kind: "gad.workingDatabase",
      database: canonicalizeGadObjectRefV1(
        contentStoreRefForSha256(STORE_ID, DATABASE_CODEC, digest)
      ),
      committedBase: request.committedBase,
    };
    this.workings.set(canonicalJson(ref.database), cloneWorkingImageV1(image));
    this.workingFinalizations.push({
      ...request,
      image: cloneWorkingImageV1(image),
    });
    return ref;
  }

  private findMergeBase(
    left: GadRepositoryDatabaseRefV1,
    right: GadRepositoryDatabaseRefV1
  ): GadPortableMergeOperandV1 | null {
    const leftAncestors = new Set<string>();
    const queue = [left.commitHash];
    while (queue.length > 0) {
      const hash = queue.shift()!;
      if (leftAncestors.has(hash)) continue;
      leftAncestors.add(hash);
      queue.push(...(this.repositories.get(hash)?.parents ?? []));
    }
    const rightQueue = [right.commitHash];
    const seen = new Set<string>();
    while (rightQueue.length > 0) {
      const hash = rightQueue.shift()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      if (leftAncestors.has(hash)) {
        const entry = this.repositories.get(hash);
        if (!entry) throw new Error("test merge base repository is missing");
        return { ref: entry.ref, image: cloneRepositoryImageV1(entry.image) };
      }
      rightQueue.push(...(this.repositories.get(hash)?.parents ?? []));
    }
    return null;
  }

  async mergeExact(request: GadExactMergeAdapterRequestV1) {
    this.mergeRequests.push({
      ...request,
      ours: request.ours,
      oursImage: cloneRepositoryImageV1(request.oursImage),
      resolutions: request.resolutions.map((resolution) => ({ ...resolution })),
    });
    const theirsImage = await this.loadRepository(request.theirs);
    return await computePortableGadExactMergeV1(
      {
        base: this.findMergeBase(request.ours, request.theirs),
        ours: { ref: request.ours, image: request.oursImage },
        theirs: { ref: request.theirs, image: theirsImage },
        intent: request.intent,
        resolutions: request.resolutions,
      },
      this
    );
  }
}

function repositoryInput(ref: GadRepositoryDatabaseRefV1) {
  return { logicalName: "repository" as const, sqlAlias: "repository_in" as const, ref };
}

function request(
  operation: GadRepositoryReducerRequestV1["operation"],
  inputs: GadRepositoryReducerRequestV1["inputs"],
  publication: GadRepositoryReducerRequestV1["publication"] = null
): GadRepositoryReducerRequestV1 {
  return {
    protocolVersion: GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION,
    inputs,
    operation,
    publication,
  };
}

async function baseFixture(host: MemoryExactHistoryHost): Promise<GadRepositoryImageV1> {
  const imported = intent("intent.import", "import");
  const selected = await host.putText("selected v1\n");
  const excluded = await host.putText("excluded v1\n");
  const historicalDeleted = await host.putText("historical deleted bytes\n");
  return {
    schemaVersion: 1,
    files: [
      {
        fileId: asGadFileId("file.selected"),
        path: "src/selected.txt",
        blobRef: selected,
        mode: 33188,
      },
      {
        fileId: asGadFileId("file.excluded"),
        path: "src/excluded.txt",
        blobRef: excluded,
        mode: 33188,
      },
    ],
    edits: [
      {
        editId: asGadEditId("edit.historical.deleted"),
        fileId: asGadFileId("file.historical.deleted"),
        commitIntentId: imported.commitIntentId,
        invocationId: imported.invocationId,
        turnId: imported.turnId,
        actorRef: imported.actorRef,
        ordinal: 0,
        kind: "write",
        path: "src/deleted.txt",
        oldBlobRef: null,
        newBlobRef: historicalDeleted,
        binary: false,
        synthetic: true,
      },
    ],
    hunks: [],
    commitIntents: [imported],
    headCommitIntentId: imported.commitIntentId,
  };
}

describe("portable Gad repository reducer kernel", () => {
  it("imports deterministically, edits without a user commit, and commits only selected edits", async () => {
    const firstHost = new MemoryExactHistoryHost();
    const binary = new Uint8Array([0xff, 0x00, 0x80, 0x41]);
    const binaryRef = await firstHost.putExactObject(VIBE_BLOB_CODEC, binary);
    const copiedBinary = Uint8Array.from(binary);
    expect(bytesToHex(binaryRef.contentId.digest)).toBe(
      bytesToHex(
        new Uint8Array(await crypto.subtle.digest("SHA-256", copiedBinary.buffer))
      )
    );
    expect(bytesToHex((await firstHost.readExactObject(binaryRef))!)).toBe(bytesToHex(binary));
    const firstImage = await baseFixture(firstHost);
    const expectedProjection = projectGadFilesToVibeWorktreeV1(firstImage.files);
    const importRequest = request(
      {
        kind: "import",
        fixtureName: "frozen-first-repository",
        repository: firstImage,
        working: null,
        expectedWorktreeRoot: expectedProjection.rootObject,
      },
      { repository: null, working: null, merges: [] },
      {
        targetRef: "main:packages/example",
        expected: null,
        reason: "test candidate only",
      }
    );
    const imported = await runGadRepositoryReducerV1(importRequest, firstHost);
    expect(imported.publicationRequest).toMatchObject({
      kind: "gad.repositoryPublicationRequest",
      targetRef: "main:packages/example",
    });
    expect(firstHost.publicationSideEffects).toBe(0);
    expect("publish" in firstHost).toBe(false);
    expect(imported.repositoryManifest.worktreeTree).toEqual(
      canonicalizeGadObjectRefV1(expectedProjection.rootObject)
    );

    const secondHost = new MemoryExactHistoryHost();
    const secondImage = await baseFixture(secondHost);
    const repeated = await runGadRepositoryReducerV1(
      request(
        {
          kind: "import",
          fixtureName: "frozen-first-repository",
          repository: secondImage,
          working: null,
          expectedWorktreeRoot: expectedProjection.rootObject,
        },
        { repository: null, working: null, merges: [] },
        importRequest.publication
      ),
      secondHost
    );
    expect(canonicalJson(repeated)).toBe(canonicalJson(imported));

    const editResult = await runGadRepositoryReducerV1(
      request(
        {
          kind: "edit",
          edits: [
            {
              editId: asGadEditId("edit.selected.v2"),
              operation: {
                kind: "write",
                path: "src/selected.txt",
                content: { kind: "text", text: "selected v2\n" },
              },
            },
            {
              editId: asGadEditId("edit.excluded.v2"),
              operation: {
                kind: "write",
                path: "src/excluded.txt",
                content: { kind: "text", text: "excluded v2\n" },
              },
            },
          ],
          provenance: {
            actorRef: "actor:editor",
            invocationId: "invocation:edit",
            turnId: "turn:edit",
          },
        },
        { repository: repositoryInput(imported.repository), working: null, merges: [] }
      ),
      firstHost
    );
    expect(editResult.repository.commitHash).toBe(imported.repository.commitHash);
    expect(editResult.working).not.toBeNull();
    const working = await firstHost.loadWorking(editResult.working!);
    expect(working.edits.map((edit) => [edit.editId, edit.commitIntentId])).toEqual([
      ["edit.selected.v2", null],
      ["edit.excluded.v2", null],
    ]);
    expect(firstHost.repositoryFinalizations).toHaveLength(1);

    const selectedIntent = intent("intent.selected.v2");
    const committed = await runGadRepositoryReducerV1(
      request(
        {
          kind: "commitSelected",
          selectedEditIds: [asGadEditId("edit.selected.v2")],
          intent: selectedIntent,
        },
        {
          repository: repositoryInput(imported.repository),
          working: {
            logicalName: "working",
            sqlAlias: "working_in",
            ref: editResult.working!,
          },
          merges: [],
        }
      ),
      firstHost
    );
    const committedImage = await firstHost.loadRepository(committed.repository);
    const residual = await firstHost.loadWorking(committed.working!);
    expect(committedImage.headCommitIntentId).toBe(selectedIntent.commitIntentId);
    expect(
      committedImage.edits.find((edit) => edit.editId === "edit.selected.v2")?.commitIntentId
    ).toBe(selectedIntent.commitIntentId);
    expect(committedImage.files.map((file) => file.path)).toEqual([
      "src/excluded.txt",
      "src/selected.txt",
    ]);
    expect(residual.edits.map((edit) => edit.editId)).toEqual(["edit.excluded.v2"]);
    const committedSelected = committedImage.files.find(
      (file) => file.path === "src/selected.txt"
    )!;
    const residualExcluded = residual.files.find((file) => file.path === "src/excluded.txt")!;
    expect(new TextDecoder().decode((await firstHost.readExactObject(committedSelected.blobRef))!)).toBe(
      "selected v2\n"
    );
    expect(new TextDecoder().decode((await firstHost.readExactObject(residualExcluded.blobRef))!)).toBe(
      "excluded v2\n"
    );
    expect(committed.publicationRequest).toBeNull();
  });

  it("fails before immutable finalization on missing external refs or a projection mismatch", async () => {
    const missingHost = new MemoryExactHistoryHost();
    const missingImage = await baseFixture(missingHost);
    missingImage.files[0]!.blobRef = contentStoreRefForSha256(
      STORE_ID,
      VIBE_BLOB_CODEC,
      "11".repeat(32)
    );
    await expect(
      runGadRepositoryReducerV1(
        request(
          {
            kind: "import",
            fixtureName: "missing",
            repository: missingImage,
            working: null,
          },
          { repository: null, working: null, merges: [] }
        ),
        missingHost
      )
    ).rejects.toThrow("Missing Gad external object");
    expect(missingHost.repositoryFinalizations).toHaveLength(0);

    const mismatchHost = new MemoryExactHistoryHost();
    const mismatchImage = await baseFixture(mismatchHost);
    await expect(
      runGadRepositoryReducerV1(
        request(
          {
            kind: "import",
            fixtureName: "mismatch",
            repository: mismatchImage,
            working: null,
            expectedWorktreeRoot: mismatchImage.files[0]!.blobRef,
          },
          { repository: null, working: null, merges: [] }
        ),
        mismatchHost
      )
    ).rejects.toThrow("Gad worktree projection mismatch");
    expect(mismatchHost.repositoryFinalizations).toHaveLength(0);
  });

  it("performs ordered exact-hash merges and preserves both parents' provenance tables", async () => {
    const host = new MemoryExactHistoryHost();
    const baseIntent = intent("intent.base", "import");
    const baseBlob = await host.putText("one\ntwo\nthree\n");
    const baseImage: GadRepositoryImageV1 = {
      schemaVersion: 1,
      files: [
        {
          fileId: asGadFileId("file.merge"),
          path: "src/merge.txt",
          blobRef: baseBlob,
          mode: 33188,
        },
      ],
      edits: [],
      hunks: [],
      commitIntents: [baseIntent],
      headCommitIntentId: baseIntent.commitIntentId,
    };
    const base = await host.finalizeRepository({
      outputName: "repository",
      source: null,
      image: baseImage,
      parents: [],
      intent: baseIntent,
      physicalPurpose: "import",
    });
    const branch = async (
      branchIntent: GadCommitIntentRowV1,
      text: string,
      extra = false
    ): Promise<GadRepositoryDatabaseRefV1> => {
      const blob = await host.putText(text);
      const extraBlob = extra ? await host.putText("extra\n") : null;
      const edit: GadEditRowV1 = {
        editId: asGadEditId(`edit.${branchIntent.commitIntentId}`),
        fileId: asGadFileId("file.merge"),
        commitIntentId: branchIntent.commitIntentId,
        invocationId: branchIntent.invocationId,
        turnId: branchIntent.turnId,
        actorRef: branchIntent.actorRef,
        ordinal: 0,
        kind: "write",
        path: "src/merge.txt",
        oldBlobRef: baseBlob,
        newBlobRef: blob,
        binary: false,
        synthetic: true,
      };
      return await host.finalizeRepository({
        outputName: "repository",
        source: base,
        image: {
          schemaVersion: 1,
          files: [
            { ...baseImage.files[0]!, blobRef: blob },
            ...(extraBlob
              ? [
                  {
                    fileId: asGadFileId("file.extra"),
                    path: "src/extra.txt",
                    blobRef: extraBlob,
                    mode: 33188,
                  },
                ]
              : []),
          ],
          edits: [edit],
          hunks: [],
          commitIntents: [baseIntent, branchIntent],
          headCommitIntentId: branchIntent.commitIntentId,
        },
        parents: [base.commitHash],
        intent: branchIntent,
        physicalPurpose: "commit",
      });
    };
    const ours = await branch(intent("intent.ours"), "ONE\ntwo\nthree\n");
    const theirs = await branch(intent("intent.theirs"), "one\ntwo\nTHREE\n");
    const second = await branch(intent("intent.second"), "one\ntwo\nthree\n", true);
    const finalizedBefore = host.repositoryFinalizations.length;
    const result = await runGadRepositoryReducerV1(
      request(
        {
          kind: "mergeSequential",
          steps: [
            { inputName: "first_peer", intent: intent("intent.merge.first", "merge"), resolutions: [] },
            { inputName: "second_peer", intent: intent("intent.merge.second", "merge"), resolutions: [] },
          ],
        },
        {
          repository: repositoryInput(ours),
          working: null,
          merges: [
            { logicalName: "first_peer", sqlAlias: "peer_0", ref: theirs },
            { logicalName: "second_peer", sqlAlias: "peer_1", ref: second },
          ],
        }
      ),
      host
    );
    expect(host.mergeRequests).toHaveLength(2);
    expect(host.mergeRequests[0]!.ours.commitHash).toBe(ours.commitHash);
    expect(host.mergeRequests[1]!.ours.commitHash).not.toBe(ours.commitHash);
    expect(result.mergeResults.map((entry) => entry.status)).toEqual(["clean", "clean"]);
    expect(host.repositoryFinalizations).toHaveLength(finalizedBefore + 2);
    const output = await host.loadRepository(result.repository);
    expect(output.files.map((file) => file.path)).toEqual(["src/extra.txt", "src/merge.txt"]);
    const intentIds = new Set(output.commitIntents.map((entry) => entry.commitIntentId));
    expect(intentIds).toEqual(
      new Set([
        "intent.base",
        "intent.ours",
        "intent.theirs",
        "intent.second",
        "intent.merge.first",
        "intent.merge.second",
      ])
    );
    expect(output.edits.some((edit) => edit.editId === "edit.intent.theirs")).toBe(true);
    expect(output.edits.some((edit) => edit.editId === "edit.intent.second")).toBe(true);
    expect(output.hunks.some((hunk) => hunk.origin === "theirs")).toBe(true);
    const mergeFinalizations = host.repositoryFinalizations.slice(finalizedBefore);
    expect(mergeFinalizations[0]!.parents).toEqual([ours.commitHash, theirs.commitHash]);
    expect(mergeFinalizations[1]!.parents[0]).toBe(host.mergeRequests[1]!.ours.commitHash);
    expect(mergeFinalizations[1]!.parents[1]).toBe(second.commitHash);
  });

  it("returns pending working state for conflicts and records resolved content provenance", async () => {
    const host = new MemoryExactHistoryHost();
    const baseIntent = intent("intent.conflict.base", "import");
    const baseBlob = await host.putText("base\n");
    const makeImage = async (
      rowIntent: GadCommitIntentRowV1,
      text: string
    ): Promise<GadRepositoryImageV1> => {
      const blob = await host.putText(text);
      return {
        schemaVersion: 1,
        files: [
          {
            fileId: asGadFileId("file.conflict"),
            path: "src/conflict.txt",
            blobRef: blob,
            mode: 33188,
          },
        ],
        edits:
          rowIntent.operation === "import"
            ? []
            : [
                {
                  editId: asGadEditId(`edit.${rowIntent.commitIntentId}`),
                  fileId: asGadFileId("file.conflict"),
                  commitIntentId: rowIntent.commitIntentId,
                  invocationId: rowIntent.invocationId,
                  turnId: rowIntent.turnId,
                  actorRef: rowIntent.actorRef,
                  ordinal: 0,
                  kind: "write",
                  path: "src/conflict.txt",
                  oldBlobRef: baseBlob,
                  newBlobRef: blob,
                  binary: false,
                  synthetic: true,
                },
              ],
        hunks: [],
        commitIntents:
          rowIntent.operation === "import" ? [baseIntent] : [baseIntent, rowIntent],
        headCommitIntentId: rowIntent.commitIntentId,
      };
    };
    const baseImage = await makeImage(baseIntent, "base\n");
    const base = await host.finalizeRepository({
      outputName: "repository",
      source: null,
      image: baseImage,
      parents: [],
      intent: baseIntent,
      physicalPurpose: "import",
    });
    const oursIntent = intent("intent.conflict.ours");
    const theirsIntent = intent("intent.conflict.theirs");
    const ours = await host.finalizeRepository({
      outputName: "repository",
      source: base,
      image: await makeImage(oursIntent, "ours\n"),
      parents: [base.commitHash],
      intent: oursIntent,
      physicalPurpose: "commit",
    });
    const theirs = await host.finalizeRepository({
      outputName: "repository",
      source: base,
      image: await makeImage(theirsIntent, "theirs\n"),
      parents: [base.commitHash],
      intent: theirsIntent,
      physicalPurpose: "commit",
    });
    const unresolvedIntent = intent("intent.conflict.merge", "merge");
    const unresolved = await runGadRepositoryReducerV1(
      request(
        {
          kind: "mergeSequential",
          steps: [{ inputName: "peer", intent: unresolvedIntent, resolutions: [] }],
        },
        {
          repository: repositoryInput(ours),
          working: null,
          merges: [{ logicalName: "peer", sqlAlias: "peer_0", ref: theirs }],
        }
      ),
      host
    );
    expect(unresolved.repository.commitHash).toBe(ours.commitHash);
    expect(unresolved.mergeResults[0]).toMatchObject({ status: "conflicted" });
    const pending = await host.loadWorking(unresolved.working!);
    expect(pending.status).toBe("pendingMerge");
    expect(pending.pendingMerge?.ours.commitHash).toBe(ours.commitHash);
    expect(pending.pendingMerge?.theirs.commitHash).toBe(theirs.commitHash);

    const resolvedIntent = intent("intent.conflict.resolved", "merge");
    const resolved = await runGadRepositoryReducerV1(
      request(
        {
          kind: "mergeSequential",
          steps: [
            {
              inputName: "peer",
              intent: resolvedIntent,
              resolutions: [
                { path: "src/conflict.txt", choice: "content", text: "resolved\n" },
              ],
            },
          ],
        },
        {
          repository: repositoryInput(ours),
          working: null,
          merges: [{ logicalName: "peer", sqlAlias: "peer_0", ref: theirs }],
        }
      ),
      host
    );
    expect(resolved.working).toBeNull();
    expect(resolved.mergeResults[0]?.status).toBe("clean");
    const resolvedImage = await host.loadRepository(resolved.repository);
    expect(resolvedImage.headCommitIntentId).toBe(resolvedIntent.commitIntentId);
    expect(resolvedImage.hunks.some((hunk) => hunk.origin === "resolved")).toBe(true);
    const file = resolvedImage.files[0]!;
    expect(new TextDecoder().decode((await host.readExactObject(file.blobRef))!)).toBe("resolved\n");
  });

  it("supports empty fast-forward exactly and rejects unequal duplicate provenance IDs", async () => {
    const host = new MemoryExactHistoryHost();
    const baseIntent = intent("intent.empty.base", "import");
    const empty: GadRepositoryImageV1 = {
      schemaVersion: 1,
      files: [],
      edits: [],
      hunks: [],
      commitIntents: [baseIntent],
      headCommitIntentId: baseIntent.commitIntentId,
    };
    const base = await host.finalizeRepository({
      outputName: "repository",
      source: null,
      image: empty,
      parents: [],
      intent: baseIntent,
      physicalPurpose: "import",
    });
    const nextIntent = intent("intent.empty.next");
    const next = await host.finalizeRepository({
      outputName: "repository",
      source: base,
      image: { ...empty, commitIntents: [baseIntent, nextIntent], headCommitIntentId: nextIntent.commitIntentId },
      parents: [base.commitHash],
      intent: nextIntent,
      physicalPurpose: "commit",
    });
    const before = host.repositoryFinalizations.length;
    const fastForward = await runGadRepositoryReducerV1(
      request(
        {
          kind: "mergeSequential",
          steps: [{ inputName: "peer", intent: intent("intent.empty.merge", "merge"), resolutions: [] }],
        },
        {
          repository: repositoryInput(base),
          working: null,
          merges: [{ logicalName: "peer", sqlAlias: "peer_0", ref: next }],
        }
      ),
      host
    );
    expect(fastForward.mergeResults[0]?.status).toBe("fast-forward");
    expect(sameRepositoryDatabaseRefV1(fastForward.repository, next)).toBe(true);
    expect(host.repositoryFinalizations).toHaveLength(before);

    const conflictHost = new MemoryExactHistoryHost();
    const blob = await conflictHost.putText("same\n");
    const sharedEdit = (actorRef: string): GadEditRowV1 => ({
      editId: asGadEditId("edit.duplicate"),
      fileId: asGadFileId("file.duplicate"),
      commitIntentId: asGadCommitIntentId("intent.duplicate"),
      invocationId: null,
      turnId: null,
      actorRef,
      ordinal: 0,
      kind: "write",
      path: "src/duplicate.txt",
      oldBlobRef: null,
      newBlobRef: blob,
      binary: false,
      synthetic: true,
    });
    const sharedIntent = intent("intent.duplicate");
    const operand = (actorRef: string): GadRepositoryImageV1 => ({
      schemaVersion: 1,
      files: [
        {
          fileId: asGadFileId("file.duplicate"),
          path: "src/duplicate.txt",
          blobRef: blob,
          mode: 33188,
        },
      ],
      edits: [sharedEdit(actorRef)],
      hunks: [],
      commitIntents: [sharedIntent],
      headCommitIntentId: sharedIntent.commitIntentId,
    });
    const fakeHash = (character: string) => asGadDoltCommitHash(character.repeat(40));
    const fakeRef = (hash: GadRepositoryDatabaseRefV1["commitHash"]): GadRepositoryDatabaseRefV1 => ({
      kind: "gad.repositoryDatabase",
      database: canonicalizeGadObjectRefV1(
        contentStoreRefForSha256(STORE_ID, DATABASE_CODEC, "22".repeat(32))
      ),
      commitHash: hash,
    });
    await expect(
      computePortableGadExactMergeV1(
        {
          base: null,
          ours: { ref: fakeRef(fakeHash("a")), image: operand("actor:ours") },
          theirs: { ref: fakeRef(fakeHash("b")), image: operand("actor:theirs") },
          intent: intent("intent.duplicate.merge", "merge"),
          resolutions: [],
        },
        conflictHost
      )
    ).rejects.toThrow("Conflicting Gad edit identity during merge");
  });
});
