import {
  SHA2_256_HASH_ALGORITHM,
  bytesToHex,
} from "@vibestudio/shared/contentStore/exactContentStore";
import {
  VIBE_BLOB_CODEC,
  contentStoreRefForSha256,
} from "@vibestudio/shared/contentStore/vibeContentCodecs";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import {
  GAD_HUNK_CODEC_V1,
  asGadHunkId,
  canonicalizeGadObjectRefV1,
  createGadRepositoryManifestTemplateV1,
  createGadWorkingSnapshotManifestTemplateV1,
  planSelectedCommitV1,
  type GadEditRowV1,
  type GadFileRowV1,
  type GadHunkRowV1,
} from "@workspace/gad-repository-contract";
import { EditEngine, type WorkingFileEntry } from "@workspace/vcs-engine";
import {
  cloneRepositoryImageV1,
  cloneRepositoryRefV1,
  finalizeProjectionV1,
  normalizeRepositoryImageV1,
  normalizeWorkingImageV1,
  sameRepositoryDatabaseRefV1,
  verifyImageExternalObjectsV1,
} from "./state.js";
import {
  GAD_REPOSITORY_INPUT_NAME,
  GAD_REPOSITORY_OUTPUT_NAME,
  GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION,
  GAD_WORKING_INPUT_NAME,
  GAD_WORKING_OUTPUT_NAME,
  asGadDoltCommitHash,
  type GadCommitSelectedOperationV1,
  type GadEditOperationV1,
  type GadRepositoryDatabaseRefV1,
  type GadRepositoryImageV1,
  type GadRepositoryReducerHostAdapterV1,
  type GadRepositoryReducerRequestV1,
  type GadRepositoryReducerResultV1,
  type GadWorkingDatabaseRefV1,
  type GadWorkingImageV1,
} from "./types.js";

const BINDING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function requireRepositoryInput(
  request: GadRepositoryReducerRequestV1
): NonNullable<GadRepositoryReducerRequestV1["inputs"]["repository"]> {
  const input = request.inputs.repository;
  if (!input) throw new Error(`${request.operation.kind} requires a repository input`);
  if (input.logicalName !== GAD_REPOSITORY_INPUT_NAME || input.sqlAlias !== "repository_in") {
    throw new Error("Invalid named Gad repository input");
  }
  asGadDoltCommitHash(input.ref.commitHash);
  return input;
}

function validateInputs(request: GadRepositoryReducerRequestV1): void {
  if (request.protocolVersion !== GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION) {
    throw new Error("Unsupported Gad repository reducer protocol version");
  }
  const working = request.inputs.working;
  if (
    working &&
    (working.logicalName !== GAD_WORKING_INPUT_NAME || working.sqlAlias !== "working_in")
  ) {
    throw new Error("Invalid named Gad working input");
  }
  const logicalNames = new Set<string>();
  const aliases = new Set<string>();
  for (const input of request.inputs.merges) {
    if (!BINDING_NAME_RE.test(input.logicalName) || !BINDING_NAME_RE.test(input.sqlAlias)) {
      throw new Error("Invalid named Gad merge input");
    }
    if (logicalNames.has(input.logicalName) || aliases.has(input.sqlAlias)) {
      throw new Error("Duplicate named Gad merge input");
    }
    logicalNames.add(input.logicalName);
    aliases.add(input.sqlAlias);
    asGadDoltCommitHash(input.ref.commitHash);
  }
  if (request.operation.kind === "import") {
    if (request.inputs.repository || request.inputs.working || request.inputs.merges.length > 0) {
      throw new Error("Gad import must not receive pre-existing database inputs");
    }
  } else {
    const repository = requireRepositoryInput(request);
    if (
      working &&
      !sameRepositoryDatabaseRefV1(working.ref.committedBase, repository.ref)
    ) {
      throw new Error("Gad working input belongs to a different committed repository");
    }
  }
}

function repositoryFileStoreId(image: GadRepositoryImageV1): Uint8Array | null {
  return image.files[0]?.blobRef.storeId.slice() ?? null;
}

async function applyWorkingEditsV1(
  host: GadRepositoryReducerHostAdapterV1,
  repository: GadRepositoryImageV1,
  working: GadWorkingImageV1,
  operation: GadEditOperationV1
): Promise<GadWorkingImageV1> {
  if (working.status === "pendingMerge") {
    throw new Error("Ordinary Gad edits cannot bypass a pending merge");
  }
  const knownIds = new Set([
    ...repository.edits.map((edit) => edit.editId),
    ...working.edits.map((edit) => edit.editId),
  ]);
  const fileIdByPath = new Map(working.files.map((file) => [file.path, file.fileId]));
  let storeId =
    working.files[0]?.blobRef.storeId.slice() ??
    repositoryFileStoreId(repository) ??
    host.getContentStoreId().slice();
  let files = new Map<string, WorkingFileEntry>(
    working.files.map((file) => [
      file.path,
      {
        path: file.path,
        contentHash: bytesToHex(file.blobRef.contentId.digest),
        mode: file.mode,
      },
    ])
  );
  const newRows: GadEditRowV1[] = [];
  const newHunks: GadHunkRowV1[] = [];
  const startingOrdinal = working.edits.reduce(
    (maximum, edit) => Math.max(maximum, edit.ordinal + 1),
    0
  );

  for (const [requestOrdinal, requested] of operation.edits.entries()) {
    if (knownIds.has(requested.editId)) throw new Error(`Duplicate Gad edit ID: ${requested.editId}`);
    knownIds.add(requested.editId);
    const before = files.get(requested.operation.path);
    const beforeId = fileIdByPath.get(requested.operation.path);
    if (!before && !requested.newFileId) {
      throw new Error(`New Gad path requires a caller-minted file ID: ${requested.operation.path}`);
    }
    if (before && requested.newFileId && requested.newFileId !== beforeId) {
      throw new Error(`Existing Gad path cannot change file ID: ${requested.operation.path}`);
    }

    const engine = new EditEngine({
      readBlob: async (digest) => {
        if (!storeId) return null;
        return await host.readExactObject(
          contentStoreRefForSha256(storeId, VIBE_BLOB_CODEC, digest)
        );
      },
      writeBlob: async (value) => {
        const object = await host.putExactObject(VIBE_BLOB_CODEC, value);
        if (
          object.contentId.algorithm !== SHA2_256_HASH_ALGORITHM ||
          object.codec.number !== VIBE_BLOB_CODEC.number ||
          object.codec.version !== VIBE_BLOB_CODEC.version
        ) {
          throw new Error("Gad edit host returned a non-canonical Vibe blob");
        }
        if (storeId && bytesToHex(storeId) !== bytesToHex(object.storeId)) {
          throw new Error("Gad edit output crossed content stores");
        }
        storeId ??= object.storeId.slice();
        return { digest: bytesToHex(object.contentId.digest), size: value.byteLength };
      },
    });
    const applied = await engine.applyEditOps(files, [requested.operation]);
    files = applied.files;
    const draft = applied.rows[0];
    if (!draft) throw new Error("Gad edit engine returned no provenance row");
    const fileId = beforeId ?? requested.newFileId;
    if (!fileId) throw new Error(`Gad edit lacks a stable file ID: ${draft.path}`);
    if (draft.kind === "delete") fileIdByPath.delete(draft.path);
    else fileIdByPath.set(draft.path, fileId);
    const oldBlobRef =
      draft.oldContentHash && storeId
        ? contentStoreRefForSha256(storeId, VIBE_BLOB_CODEC, draft.oldContentHash)
        : null;
    const newBlobRef =
      draft.newContentHash && storeId
        ? contentStoreRefForSha256(storeId, VIBE_BLOB_CODEC, draft.newContentHash)
        : null;
    const edit: GadEditRowV1 = {
      editId: requested.editId,
      fileId,
      commitIntentId: null,
      invocationId: operation.provenance.invocationId,
      turnId: operation.provenance.turnId,
      actorRef: operation.provenance.actorRef,
      ordinal: startingOrdinal + requestOrdinal,
      kind: draft.kind,
      path: draft.path,
      oldBlobRef,
      newBlobRef,
      binary: draft.binary ?? false,
      synthetic: false,
    };
    newRows.push(edit);
    const hunks = Array.isArray(draft.hunks) ? draft.hunks : [];
    for (let hunkOrdinal = 0; hunkOrdinal < hunks.length; hunkOrdinal += 1) {
      const candidate = hunks[hunkOrdinal] as {
        start?: unknown;
        end?: unknown;
      };
      if (!Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end)) {
        throw new Error("Gad edit engine returned an invalid provenance hunk");
      }
      const bodyRef = await host.putExactObject(
        GAD_HUNK_CODEC_V1,
        new TextEncoder().encode(canonicalJson(hunks[hunkOrdinal]))
      );
      if (
        bodyRef.codec.number !== GAD_HUNK_CODEC_V1.number ||
        bodyRef.codec.version !== GAD_HUNK_CODEC_V1.version
      ) {
        throw new Error("Gad edit host returned the wrong hunk codec");
      }
      newHunks.push({
        hunkId: asGadHunkId(`${requested.editId}:hunk:${hunkOrdinal}`),
        editId: requested.editId,
        ordinal: hunkOrdinal,
        start: candidate.start as number,
        end: candidate.end as number,
        bodyRef,
        origin: null,
        theirsStart: null,
        theirsEnd: null,
      });
    }
  }
  if (!storeId || storeId.byteLength === 0) {
    throw new Error("Gad edit requires a configured content store");
  }
  const outputStoreId = storeId;
  const currentFiles: GadFileRowV1[] = [...files.values()]
    .sort((left, right) => compareText(left.path, right.path))
    .map((file) => {
      const fileId = fileIdByPath.get(file.path);
      if (!fileId) throw new Error(`Gad working file lacks a stable ID: ${file.path}`);
      return {
        fileId,
        path: file.path,
        blobRef: contentStoreRefForSha256(outputStoreId, VIBE_BLOB_CODEC, file.contentHash),
        mode: file.mode,
      };
    });
  return normalizeWorkingImageV1({
    schemaVersion: 1,
    files: currentFiles,
    edits: [...working.edits, ...newRows],
    hunks: [...working.hunks, ...newHunks],
    status: newRows.length === 0 && working.edits.length === 0 ? "clean" : "dirty",
    pendingMerge: null,
  });
}

function applySelectedCommitV1(
  repository: GadRepositoryImageV1,
  working: GadWorkingImageV1,
  operation: GadCommitSelectedOperationV1
): { repository: GadRepositoryImageV1; residual: GadWorkingImageV1 | null } {
  const selected = planSelectedCommitV1(
    { edits: working.edits, hunks: working.hunks, commitIntents: [] },
    operation.selectedEditIds,
    operation.intent
  );
  const residualPaths = new Set(selected.residualWorkingEdits.map((edit) => edit.path));
  for (const edit of selected.selectedEdits) {
    if (residualPaths.has(edit.path)) {
      throw new Error(
        `Selected Gad commits require a path-complete edit selection: ${edit.path}`
      );
    }
  }
  const committedFiles = new Map(repository.files.map((file) => [file.path, file]));
  const workingFiles = new Map(working.files.map((file) => [file.path, file]));
  for (const path of new Set(selected.selectedEdits.map((edit) => edit.path))) {
    const file = workingFiles.get(path);
    if (file) committedFiles.set(path, file);
    else committedFiles.delete(path);
  }
  const nextRepository = normalizeRepositoryImageV1({
    schemaVersion: 1,
    files: [...committedFiles.values()],
    edits: [...repository.edits, ...selected.selectedEdits],
    hunks: [...repository.hunks, ...selected.selectedHunks],
    commitIntents: [...repository.commitIntents, { ...operation.intent }],
    headCommitIntentId: operation.intent.commitIntentId,
  });
  if (selected.residualWorkingEdits.length === 0) {
    return { repository: nextRepository, residual: null };
  }
  return {
    repository: nextRepository,
    residual: normalizeWorkingImageV1({
      schemaVersion: 1,
      files: working.files,
      edits: selected.residualWorkingEdits,
      hunks: selected.residualWorkingHunks,
      status: "dirty",
      pendingMerge: null,
    }),
  };
}

async function createResultV1(input: {
  host: GadRepositoryReducerHostAdapterV1;
  request: GadRepositoryReducerRequestV1;
  repositoryRef: GadRepositoryDatabaseRefV1;
  repositoryImage: GadRepositoryImageV1;
  workingRef: GadWorkingDatabaseRefV1 | null;
  workingImage: GadWorkingImageV1 | null;
  mergeResults: GadRepositoryReducerResultV1["mergeResults"];
}): Promise<GadRepositoryReducerResultV1> {
  await verifyImageExternalObjectsV1(input.host, input.repositoryImage);
  const repositoryProjection = await finalizeProjectionV1(input.host, input.repositoryImage.files);
  const repositoryManifest = createGadRepositoryManifestTemplateV1({
    database: { kind: "databaseOutput", outputName: GAD_REPOSITORY_OUTPUT_NAME },
    history: { kind: "artifactTemplate", artifactName: "repository_history" },
    currentExternalObjects: {
      kind: "artifactTemplate",
      artifactName: "repository_external_objects",
    },
    worktreeTree: canonicalizeGadObjectRefV1(repositoryProjection.rootObject),
    headCommitIntentId: input.repositoryImage.headCommitIntentId,
  });

  let workingManifest = null;
  if (input.workingImage && input.workingRef) {
    await verifyImageExternalObjectsV1(input.host, input.workingImage);
    const workingProjection = await finalizeProjectionV1(input.host, input.workingImage.files);
    workingManifest = createGadWorkingSnapshotManifestTemplateV1({
      database: { kind: "databaseOutput", outputName: GAD_WORKING_OUTPUT_NAME },
      committedBase: { kind: "artifactTemplate", artifactName: "committed_base" },
      status: input.workingImage.status,
      externalObjects: {
        kind: "artifactTemplate",
        artifactName: "working_external_objects",
      },
      worktreeTree: canonicalizeGadObjectRefV1(workingProjection.rootObject),
    });
  }
  const publicationRequest = input.request.publication
    ? {
        kind: "gad.repositoryPublicationRequest" as const,
        targetRef: input.request.publication.targetRef,
        expected: input.request.publication.expected
          ? cloneRepositoryRefV1(input.request.publication.expected)
          : null,
        outputName: GAD_REPOSITORY_OUTPUT_NAME,
        repository: cloneRepositoryRefV1(input.repositoryRef),
        reason: input.request.publication.reason,
      }
    : null;
  return {
    protocolVersion: 1,
    repository: cloneRepositoryRefV1(input.repositoryRef),
    working: input.workingRef,
    repositoryManifest,
    workingManifest,
    publicationRequest,
    mergeResults: input.mergeResults,
  };
}

export async function runGadRepositoryReducerV1(
  request: GadRepositoryReducerRequestV1,
  host: GadRepositoryReducerHostAdapterV1
): Promise<GadRepositoryReducerResultV1> {
  validateInputs(request);

  if (request.operation.kind === "import") {
    const repositoryImage = normalizeRepositoryImageV1(request.operation.repository);
    const intent = repositoryImage.commitIntents.find(
      (candidate) => candidate.commitIntentId === repositoryImage.headCommitIntentId
    );
    if (!intent || intent.operation !== "import") {
      throw new Error("Frozen Gad import fixture requires an import head intent");
    }
    await verifyImageExternalObjectsV1(host, repositoryImage);
    await finalizeProjectionV1(host, repositoryImage.files, request.operation.expectedWorktreeRoot);
    const repositoryRef = await host.finalizeRepository({
      outputName: GAD_REPOSITORY_OUTPUT_NAME,
      source: null,
      image: repositoryImage,
      parents: [],
      intent,
      physicalPurpose: "import",
    });
    const workingImage = request.operation.working
      ? normalizeWorkingImageV1(request.operation.working)
      : null;
    const workingRef = workingImage
      ? await host.finalizeWorking({
          outputName: GAD_WORKING_OUTPUT_NAME,
          source: null,
          committedBase: repositoryRef,
          image: workingImage,
        })
      : null;
    return await createResultV1({
      host,
      request,
      repositoryRef,
      repositoryImage,
      workingRef,
      workingImage,
      mergeResults: [],
    });
  }

  const repositoryInput = requireRepositoryInput(request);
  let repositoryRef = cloneRepositoryRefV1(repositoryInput.ref);
  let repositoryImage = normalizeRepositoryImageV1(await host.loadRepository(repositoryRef));
  let workingRef = request.inputs.working?.ref ?? null;
  let workingImage = workingRef
    ? normalizeWorkingImageV1(await host.loadWorking(workingRef))
    : null;
  const mergeResults: GadRepositoryReducerResultV1["mergeResults"] = [];

  if (request.operation.kind === "edit") {
    const baseWorking =
      workingImage ??
      normalizeWorkingImageV1({
        schemaVersion: 1,
        files: repositoryImage.files,
        edits: [],
        hunks: [],
        status: "clean",
        pendingMerge: null,
      });
    workingImage = await applyWorkingEditsV1(host, repositoryImage, baseWorking, request.operation);
    await verifyImageExternalObjectsV1(host, workingImage);
    await finalizeProjectionV1(host, workingImage.files, request.operation.expectedWorktreeRoot);
    workingRef = await host.finalizeWorking({
      outputName: GAD_WORKING_OUTPUT_NAME,
      source: request.inputs.working?.ref ?? null,
      committedBase: repositoryRef,
      image: workingImage,
    });
  } else if (request.operation.kind === "commitSelected") {
    if (!workingImage) throw new Error("Selected Gad commit requires working state");
    const selected = applySelectedCommitV1(repositoryImage, workingImage, request.operation);
    await verifyImageExternalObjectsV1(host, selected.repository);
    await finalizeProjectionV1(
      host,
      selected.repository.files,
      request.operation.expectedWorktreeRoot
    );
    repositoryRef = await host.finalizeRepository({
      outputName: GAD_REPOSITORY_OUTPUT_NAME,
      source: repositoryRef,
      image: selected.repository,
      parents: [repositoryRef.commitHash],
      intent: request.operation.intent,
      physicalPurpose: "commit",
    });
    repositoryImage = selected.repository;
    workingImage = selected.residual;
    workingRef = selected.residual
      ? await host.finalizeWorking({
          outputName: GAD_WORKING_OUTPUT_NAME,
          source: request.inputs.working?.ref ?? null,
          committedBase: repositoryRef,
          image: selected.residual,
        })
      : null;
  } else {
    if (workingImage && workingImage.status !== "clean") {
      throw new Error("Sequential Gad merge requires a clean committed input");
    }
    if (
      request.operation.steps.length !== request.inputs.merges.length ||
      request.operation.steps.some(
        (step, index) => step.inputName !== request.inputs.merges[index]?.logicalName
      )
    ) {
      throw new Error("Sequential Gad merge steps must exactly match named merge input order");
    }
    workingImage = null;
    workingRef = null;
    for (let index = 0; index < request.operation.steps.length; index += 1) {
      const step = request.operation.steps[index];
      const mergeInput = request.inputs.merges[index];
      if (!step || !mergeInput) throw new Error("Missing ordered Gad merge input");
      const theirs = mergeInput.ref;
      const result = await host.mergeExact({
        ours: repositoryRef,
        oursImage: cloneRepositoryImageV1(repositoryImage),
        theirs,
        intent: step.intent,
        resolutions: step.resolutions,
      });
      const expectedParents = [repositoryRef.commitHash, theirs.commitHash];
      for (const parent of result.parents) asGadDoltCommitHash(parent);
      if (
        (result.status === "clean" || result.status === "conflicted") &&
        (result.parents.length !== 2 ||
          result.parents[0] !== expectedParents[0] ||
          result.parents[1] !== expectedParents[1])
      ) {
        throw new Error("Gad exact merge backend changed first-parent order");
      }
      if (result.baseCommitHash !== null) asGadDoltCommitHash(result.baseCommitHash);
      mergeResults.push({
        inputName: step.inputName,
        status: result.status,
        baseCommitHash: result.baseCommitHash,
        conflicts: result.conflicts.map((conflict) => ({ ...conflict })),
      });
      if (result.status === "up-to-date") continue;
      if (result.status === "fast-forward") {
        repositoryRef = cloneRepositoryRefV1(theirs);
        repositoryImage = normalizeRepositoryImageV1(result.image);
        continue;
      }
      if (result.status === "conflicted") {
        if (!result.provisionalWorking || result.conflicts.length === 0) {
          throw new Error("Conflicted Gad merge lacks provisional working state");
        }
        if (index + 1 !== request.operation.steps.length) {
          throw new Error("Sequential Gad merge cannot continue after a conflict");
        }
        workingImage = normalizeWorkingImageV1(result.provisionalWorking);
        await verifyImageExternalObjectsV1(host, workingImage);
        await finalizeProjectionV1(host, workingImage.files, request.operation.expectedWorktreeRoot);
        workingRef = await host.finalizeWorking({
          outputName: GAD_WORKING_OUTPUT_NAME,
          source: null,
          committedBase: repositoryRef,
          image: workingImage,
        });
        if (request.publication) {
          throw new Error("A conflicted Gad merge cannot request publication");
        }
        break;
      }
      repositoryImage = normalizeRepositoryImageV1(result.image);
      await verifyImageExternalObjectsV1(host, repositoryImage);
      repositoryRef = await host.finalizeRepository({
        outputName: GAD_REPOSITORY_OUTPUT_NAME,
        source: repositoryRef,
        image: repositoryImage,
        parents: result.parents,
        intent: step.intent,
        physicalPurpose: "merge",
      });
    }
  }

  if (request.operation.kind === "mergeSequential") {
    if (workingImage?.status === "pendingMerge") {
      await finalizeProjectionV1(
        host,
        workingImage.files,
        request.operation.expectedWorktreeRoot
      );
    } else {
      await finalizeProjectionV1(
        host,
        repositoryImage.files,
        request.operation.expectedWorktreeRoot
      );
    }
  }
  return await createResultV1({
    host,
    request,
    repositoryRef,
    repositoryImage,
    workingRef,
    workingImage,
    mergeResults,
  });
}
