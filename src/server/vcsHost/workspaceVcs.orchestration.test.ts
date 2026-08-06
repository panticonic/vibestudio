import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contextMaterializationCommand } from "@vibestudio/shared/vcs/workspaceProjection";
import { EMPTY_STATE_HASH, sha256Hex } from "@vibestudio/content-addressing";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  blobPath,
  ensureLayout,
  getBytes,
  mirrorWorktreeTree,
  putBytes,
  putTree,
} from "../services/blobstoreService.js";
import { createProtectedRefStore } from "../services/protectedRefStore.js";
import { createWorkspaceSemanticPort } from "../workspaceSourceProvider.js";
import { WorkspaceVcs } from "./workspaceVcs.js";

const roots: string[] = [];
const TEST_PROVIDER = { source: "test/provider", className: "TestProvider", objectKey: "test" };

function providerFromWireCall(call: (method: string, input: unknown) => Promise<unknown>) {
  return createWorkspaceSemanticPort(
    {
      dispatch: (_provider: unknown, method: string, input: unknown) => call(method, input),
    } as never,
    TEST_PROVIDER
  );
}

function emptyRepairCommand(
  input: { contextId: string; materializedState: null | { kind: string } },
  targetState: { kind: "event"; eventId: string } | { kind: "application"; applicationId: string }
) {
  return contextMaterializationCommand({
    contextId: input.contextId,
    commandId: `repair:${input.contextId}`,
    mode: "replace",
    previousState: input.materializedState as never,
    targetState,
    repositories: [],
    blobs: [],
  });
}

async function harness() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workspace-vcs-orchestration-"));
  roots.push(root);
  const blobsDir = path.join(root, "blobs");
  ensureLayout(blobsDir);
  const refs = createProtectedRefStore({
    statePath: path.join(root, "refs"),
    gate: vi.fn(async () => undefined),
  });
  await fsp.mkdir(path.join(root, "source"), { recursive: true });
  const deps = {
    workspaceId: "workspace:test",
    blobsDir,
    workspaceRoot: path.join(root, "source"),
    contextProjectionsRoot: path.join(root, "contexts"),
    buildSourcesRoot: path.join(root, "builds"),
    refs,
  };
  const vcs = new WorkspaceVcs(deps);
  return { root, blobsDir, refs, vcs, deps };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("WorkspaceVcs semantic host orchestration", () => {
  it("reads channel provenance through the GAD log API, outside semantic VCS dispatch", async () => {
    const { vcs } = await harness();
    const call = vi.fn(async () => ({ contentClass: "external" as const }));
    await vcs.attachGad(providerFromWireCall(call));

    await expect(
      vcs.getChannelEnvelopeIntegrity({ channelId: "channel:one", envelopeId: "message:one" })
    ).resolves.toEqual({ contentClass: "external" });
    expect(call).toHaveBeenCalledWith("getChannelEnvelope", {
      channelId: "channel:one",
      envelopeId: "message:one",
    });
  });

  it("keeps cached composed workspace views rooted during content GC", async () => {
    const { blobsDir, vcs } = await harness();
    const cached = await putBytes(blobsDir, Buffer.from("cached-composed-view"));
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    await vcs.attachGad({
      contentGcRoots: vi.fn(async () => ({ contentRoots: [], contentHashes: [] })),
    } as never);
    vi.spyOn(vcs.repositories, "collectCachedReachableDigests").mockResolvedValue({
      treeDigests: [],
      contentDigests: [cached.digest],
    });

    await expect(
      vcs.runGc({ minAgeMs: 0, epoch: 1, executionSourceRoots: [] })
    ).resolves.toMatchObject({ swept: 1 });
    await expect(getBytes(blobsDir, cached.digest)).resolves.toEqual(
      Buffer.from("cached-composed-view")
    );
    await expect(getBytes(blobsDir, unreachable.digest)).resolves.toBeNull();
  });

  it("rechecks semantic roots before committing a GC epoch", async () => {
    const { blobsDir, vcs } = await harness();
    const retained = await putBytes(blobsDir, Buffer.from("materialized during preflight"));
    const source = await putTree(
      blobsDir,
      [{ name: "index.ts", kind: "file", contentHash: retained.digest, mode: 0o100644 }],
      { root: true }
    );
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    let roots: string[] = [];
    await vcs.attachGad({
      contentGcRoots: vi.fn(async () => ({ contentRoots: roots, contentHashes: [] })),
    } as never);

    const prepared = await vcs.prepareGc({ minAgeMs: 0, epoch: 1, executionSourceRoots: [] });
    // This simulates a context materialization completing after the read-only
    // preflight but before the destructive commit.
    roots = [source.stateHash!];
    await prepared.commit();

    await expect(getBytes(blobsDir, retained.digest)).resolves.toEqual(
      Buffer.from("materialized during preflight")
    );
    await expect(getBytes(blobsDir, unreachable.digest)).resolves.toBeNull();
  });

  it("keeps a retained execution source composition rooted during content GC", async () => {
    const { blobsDir, vcs } = await harness();
    const retained = await putBytes(blobsDir, Buffer.from("retained build source"));
    const source = await putTree(
      blobsDir,
      [{ name: "index.ts", kind: "file", contentHash: retained.digest, mode: 0o100644 }],
      { root: true }
    );
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    await vcs.attachGad({
      contentGcRoots: vi.fn(async () => ({ contentRoots: [], contentHashes: [] })),
    } as never);

    await expect(
      vcs.runGc({
        minAgeMs: 0,
        epoch: 1,
        executionSourceRoots: [{ repoPath: "panels/retained", stateHash: source.stateHash! }],
      })
    ).resolves.toMatchObject({ swept: 1 });
    await expect(getBytes(blobsDir, retained.digest)).resolves.toEqual(
      Buffer.from("retained build source")
    );
    await expect(getBytes(blobsDir, unreachable.digest)).resolves.toBeNull();
  });

  it("fails closed when an execution source root is missing from the content store", async () => {
    const { blobsDir, vcs } = await harness();
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    await vcs.attachGad({
      contentGcRoots: vi.fn(async () => ({ contentRoots: [], contentHashes: [] })),
    } as never);

    await expect(
      vcs.runGc({
        minAgeMs: 0,
        epoch: 1,
        executionSourceRoots: [
          { repoPath: "panels/retained", stateHash: `state:${"0".repeat(64)}` },
        ],
      })
    ).rejects.toThrow("is missing from the content store");
    await expect(getBytes(blobsDir, unreachable.digest)).resolves.toEqual(
      Buffer.from("unreachable")
    );
  });

  it("fails closed before sweeping when an execution source closure is corrupt", async () => {
    const { blobsDir, vcs } = await harness();
    const retained = await putBytes(blobsDir, Buffer.from("retained build source"));
    const source = await putTree(
      blobsDir,
      [{ name: "index.ts", kind: "file", contentHash: retained.digest, mode: 0o100644 }],
      { root: true }
    );
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    await fsp.unlink(blobPath(blobsDir, retained.digest));
    await vcs.attachGad({
      contentGcRoots: vi.fn(async () => ({ contentRoots: [], contentHashes: [] })),
    } as never);

    await expect(
      vcs.prepareGc({
        minAgeMs: 0,
        epoch: 1,
        executionSourceRoots: [{ repoPath: "panels/retained", stateHash: source.stateHash! }],
      })
    ).rejects.toThrow(`Content object missing from store: ${retained.digest}`);
    await expect(getBytes(blobsDir, unreachable.digest)).resolves.toEqual(
      Buffer.from("unreachable")
    );
  });

  it("reuses one stable context-initialization command across host instances", async () => {
    const { vcs, deps } = await harness();
    const restarted = new WorkspaceVcs(deps);
    const calls: unknown[] = [];
    const gad = {
      contextMaterializationCommand: vi.fn(async (input: unknown) =>
        emptyRepairCommand(input as never, {
          kind: "event",
          eventId: "event:main",
        })
      ),
      ensureContext: vi.fn(async (input: unknown) => {
        calls.push(input);
        return {
          kind: "complete" as const,
          result: { working: { ref: { kind: "event" as const, eventId: "event:main" } } },
        };
      }),
    };
    await Promise.all([vcs.attachGad(gad as never), restarted.attachGad(gad as never)]);

    await vcs.ensureContext("context:stable");
    await restarted.ensureContext("context:stable");

    expect(calls).toHaveLength(2);
    expect((calls[0] as { commandId: string }).commandId).toBe(
      (calls[1] as { commandId: string }).commandId
    );
  });

  it("imports source facts without duplicating host-observed content descriptors", async () => {
    const { root, vcs } = await harness();
    const workspaceRoot = path.join(root, "source");
    const unicodeText = "é🙂\n";
    const invalidUtf8 = Buffer.from([0x66, 0x80, 0x6f]);
    await Promise.all([
      fsp.mkdir(path.join(workspaceRoot, "meta"), { recursive: true }),
      fsp.mkdir(path.join(workspaceRoot, "projects", "coordinates"), { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(path.join(workspaceRoot, "meta", "vibestudio.yml"), "systemEpoch: 57\n"),
      fsp.writeFile(
        path.join(workspaceRoot, "projects", "coordinates", "unicode.txt"),
        unicodeText
      ),
      fsp.writeFile(
        path.join(workspaceRoot, "projects", "coordinates", "invalid.bin"),
        invalidUtf8
      ),
    ]);

    type ImportedSnapshot = {
      repositories: Array<{
        repoPath: string;
        files: Array<{
          path: string;
          contentHash: string;
          mode: number;
        }>;
      }>;
    };
    const importedSnapshots: ImportedSnapshot[] = [];
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsContextMaterializationCommand") {
        return emptyRepairCommand(input as never, {
          kind: "event",
          eventId: "event:genesis",
        });
      }
      if (method === "vcsEnsureContext") {
        return {
          kind: "complete",
          result: { working: { ref: { kind: "event", eventId: "event:genesis" } } },
        };
      }
      const dispatch = { method, request: input as { input: unknown } };
      if (dispatch.method === "vcsInspect") {
        return {
          kind: "complete",
          result: {
            root: { kind: "event", eventId: "event:genesis" },
            node: { kind: "event", value: { kind: "genesis", eventId: "event:genesis" } },
            edges: [],
            hasMoreEdges: false,
          },
        };
      }
      if (dispatch.method === "vcsImportSnapshot") {
        importedSnapshots.push(dispatch.request.input as ImportedSnapshot);
        return { kind: "complete", result: { eventId: "event:import" } };
      }
      if (dispatch.method === "vcsPush") {
        return { kind: "complete", result: { eventId: "event:import" } };
      }
      throw new Error(`unexpected ${dispatch.method}`);
    });
    await vcs.attachGad(providerFromWireCall(call));

    await expect(vcs.activateWorkspaceFromSource()).resolves.toMatchObject({ initialized: true });

    expect(importedSnapshots).toHaveLength(1);
    const coordinateRepository = importedSnapshots[0]?.repositories.find(
      (repository) => repository.repoPath === "projects/coordinates"
    );
    expect(coordinateRepository?.files.map(({ path }) => path)).toEqual([
      "invalid.bin",
      "unicode.txt",
    ]);
    for (const file of coordinateRepository?.files ?? []) {
      expect(file).toEqual({
        path: file.path,
        contentHash: expect.any(String),
        mode: 0o644,
      });
    }
  });

  it("imports one exact external root as per-repo Git snapshots and publishes once", async () => {
    const { root, deps } = await harness();
    const workspaceRoot = path.join(root, "source");
    await fsp.mkdir(path.join(workspaceRoot, "meta"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "meta", "vibestudio.yml"), "systemEpoch: 57\n");
    const encoder = new TextEncoder();
    const subtreeDigest = `v1-sha256:${"b".repeat(64)}` as const;
    const pin = {
      url: "https://example.test/news.git",
      ref: "refs/tags/v1",
      commit: "1".repeat(40),
      snapshot: `v1-sha256:${"c".repeat(64)}` as const,
    };
    const templateBytes = encoder.encode("export const news = true;\n");
    const templateHash = sha256Hex(templateBytes);
    const prepared = {
      pin,
      config: {
        id: "workspace:test",
        systemEpoch: 57,
      },
      repositories: [
        {
          repoPath: "panels/news",
          subdir: "panels/news",
          snapshot: subtreeDigest,
          files: [
            {
              path: "index.ts",
              contentHash: templateHash,
              size: templateBytes.byteLength,
              mode: 0o644 as const,
            },
          ],
        },
      ],
    };
    const rootTemplateBootstrap = {
      prepareSource: vi.fn(async () => pin),
      prepareInitialization: vi.fn(async () => prepared),
    };
    const templateVcs = new WorkspaceVcs({ ...deps, rootTemplateBootstrap });
    vi.spyOn(templateVcs, "ensureContext").mockImplementation(async () => ({
      kind: "event",
      eventId: "event:genesis",
    }));
    vi.spyOn(templateVcs, "ensureFresh").mockResolvedValue({ stateHash: EMPTY_STATE_HASH });
    await templateVcs.attachGad(
      providerFromWireCall(async (method) => {
        if (method !== "vcsInspect") throw new Error(`unexpected ${method}`);
        return {
          kind: "complete",
          result: {
            node: {
              kind: "event",
              value: { kind: "genesis", eventId: "event:genesis" },
            },
          },
        };
      })
    );
    const initializeExactSnapshot = vi.fn(async () => ({
      state: "ready" as const,
      commandId: `workspace-source:${pin.commit}:${pin.snapshot}`,
      receipt: {
        commandId: `workspace-source:${pin.commit}:${pin.snapshot}`,
        pin,
        initializedEventId: "event:template",
        initializedStateHash: EMPTY_STATE_HASH,
      },
    }));
    templateVcs.attachWorkspaceSourceProvider({
      initializeExactSnapshot,
      resolveSource: vi.fn(),
      currentSource: vi.fn(),
      inspectInitialization: vi.fn(async () => ({ state: "empty" as const })),
      health: vi.fn(),
    } as never);

    await expect(templateVcs.activateWorkspaceFromSource()).resolves.toMatchObject({
      initialized: true,
    });

    expect(initializeExactSnapshot).toHaveBeenCalledWith({
      commandId: `workspace-source:${pin.commit}:${pin.snapshot}`,
      pin,
      repositories: [
        expect.objectContaining({
          repoPath: "panels/news",
          subdir: "panels/news",
          snapshot: subtreeDigest,
        }),
      ],
    });
  });

  it("does not replay root initialization after semantic main has advanced", async () => {
    const { deps } = await harness();
    const pin = {
      url: "https://example.test/root.git",
      ref: "refs/tags/v1",
      commit: "1".repeat(40),
      snapshot: `v1-sha256:${"2".repeat(64)}` as const,
    };
    const prepared = { pin, repositories: [] };
    const prepareInitialization = vi.fn(async () => prepared);
    const vcs = new WorkspaceVcs({
      ...deps,
      rootTemplateBootstrap: {
        prepareSource: vi.fn(async () => pin),
        prepareInitialization,
      },
    });
    const initializeExactSnapshot = vi.fn();
    vcs.attachWorkspaceSourceProvider({
      initializeExactSnapshot,
      resolveSource: vi.fn(),
      currentSource: vi.fn(),
      inspectInitialization: vi.fn(async () => ({
        state: "ready" as const,
        commandId: "workspace-source:root",
        receipt: {
          commandId: "workspace-source:root",
          pin,
          initializedEventId: "event:root",
          initializedStateHash: `state:${"3".repeat(64)}`,
        },
      })),
      health: vi.fn(),
    });
    vi.spyOn(vcs, "ensureFresh").mockResolvedValue({ stateHash: `state:${"4".repeat(64)}` });

    await expect(vcs.activateWorkspaceFromSource()).resolves.toMatchObject({
      stateHash: `state:${"4".repeat(64)}`,
      initialized: false,
    });
    expect(initializeExactSnapshot).not.toHaveBeenCalled();
    expect(prepareInitialization).not.toHaveBeenCalled();
  });

  it("recovers an interrupted initial publication and recognizes the initialized workspace", async () => {
    const { vcs, refs } = await harness();
    const contextId = "workspace-initialization:workspace:test";
    const genesisEventId = "event:genesis";
    const importedEventId = "event:initial-import";
    let refsInstalled = true;
    let pending = true;
    const publishEffect = {
      effectId: "effect:interrupted-initial-push",
      scopeKind: "workspace",
      scopeId: "workspace:test",
      commandId: `initial-push:${importedEventId}`,
      kind: "publish-main",
      payload: {
        contextId,
        previousEventId: genesisEventId,
        publishedEventId: importedEventId,
        repositories: [],
      },
      payloadDigest: "effect-digest:initial-push",
      status: "pending",
      receipt: null,
      createdAt: "2026-07-16T12:00:00.000Z",
    } as const;
    vi.spyOn(refs, "listMains").mockImplementation(() =>
      refsInstalled
        ? ([
            {
              repoPath: "meta",
              contentRoot: EMPTY_STATE_HASH,
            },
          ] as never)
        : []
    );
    vi.spyOn(refs, "updateMains").mockImplementation(async () => {
      refsInstalled = true;
      return { updated: [], replayed: false };
    });
    vi.spyOn(refs, "readAppliedPublication").mockReturnValue({
      publicationId: publishEffect.effectId,
      previousEventId: genesisEventId,
      publishedEventId: importedEventId,
      hostRefsBasisDigest: "host-refs-basis:test",
      resultHostRefsBasisDigest: "host-refs-basis:test",
      entries: [],
      appliedAt: Date.parse("2026-07-16T12:00:00.000Z"),
      observersAppliedAt: Date.parse("2026-07-16T12:00:00.000Z"),
      semanticAcknowledgedAt: null,
    });

    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsPendingSemanticEffects") return pending ? [publishEffect] : [];
      if (method === "vcsSemanticEffectAck") {
        pending = false;
        return { kind: "complete", result: { eventId: importedEventId } };
      }
      if (method === "vcsEnsureContext") {
        return {
          kind: "complete",
          result: { working: { ref: { kind: "event", eventId: importedEventId } } },
        };
      }
      if (method === "vcsContextMaterializationCommand") {
        return emptyRepairCommand(input as never, {
          kind: "event",
          eventId: importedEventId,
        });
      }
      const dispatch = {
        method,
        request: input as { input: Record<string, unknown> },
      };
      if (dispatch.method === "vcsInspect") {
        return {
          kind: "complete",
          result: {
            root: { kind: "event", eventId: importedEventId },
            node: {
              kind: "event",
              value: {
                eventId: importedEventId,
                workspaceId: "workspace:test",
                commandId: "initial-import:source-state",
                kind: "commit",
                workspaceFactRootId: "workspace-fact-root:initial",
                parentEventIds: [genesisEventId],
                applicationIds: ["application:initial-import"],
                decisionIds: [],
                message: "Import initial workspace snapshot",
                semanticProtocol: "semantic-vcs:test",
                createdAt: "2026-07-16T12:00:00.000Z",
              },
            },
            edges: [],
            hasMoreEdges: false,
          },
        };
      }
      throw new Error(`unexpected ${dispatch.method}`);
    });
    await vcs.attachGad(providerFromWireCall(call));

    await expect(vcs.recoverPendingSemanticEffects()).resolves.toBe(1);
    await expect(vcs.activateWorkspaceFromSource()).resolves.toMatchObject({ initialized: false });
    expect(refs.updateMains).not.toHaveBeenCalled();
    expect(pending).toBe(false);
  });

  it("never grants restart authority to an unapplied pending publication", async () => {
    const { refs, vcs } = await harness();
    const publishEffect = {
      effectId: "effect:caller-publication",
      scopeKind: "context",
      scopeId: "context:caller",
      commandId: "command:caller-push",
      kind: "publish-main",
      payload: {
        contextId: "context:caller",
        previousEventId: "event:main",
        publishedEventId: "event:caller",
        repositories: [],
      },
      payloadDigest: "effect-digest:caller-push",
      status: "pending",
    } as const;
    const call = vi.fn(async (method: string) => {
      if (method === "vcsPendingSemanticEffects") return [publishEffect];
      throw new Error(`unexpected ${method}`);
    });
    vi.spyOn(refs, "readAppliedPublication").mockReturnValue(null);
    vi.spyOn(refs, "updateMains");
    await vcs.attachGad(providerFromWireCall(call));

    await expect(vcs.recoverPendingSemanticEffects()).resolves.toBe(0);
    expect(refs.updateMains).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalledWith("vcsSemanticEffectAck", expect.anything());
  });

  it("recovers later safe effects without granting authority to an earlier publication", async () => {
    const { refs, vcs } = await harness();
    const unauthorizedPublication = {
      effectId: "effect:unapplied-publication",
      scopeKind: "context",
      scopeId: "context:caller",
      commandId: "command:unapplied-publication",
      kind: "publish-main",
      payload: {
        contextId: "context:caller",
        previousEventId: "event:main",
        publishedEventId: "event:caller",
        repositories: [],
      },
      payloadDigest: "effect-digest:unapplied-publication",
      status: "pending",
    } as const;
    const observation = {
      effectId: "effect:observation",
      scopeKind: "context",
      scopeId: "context:other",
      commandId: "command:observation",
      kind: "observe-content",
      payload: { representation: "descriptor", files: [] },
      payloadDigest: "effect-digest:observation",
      status: "pending",
    } as const;
    const appliedPublication = {
      ...unauthorizedPublication,
      effectId: "effect:applied-publication",
      commandId: "command:applied-publication",
      payloadDigest: "effect-digest:applied-publication",
    };
    const pending = [unauthorizedPublication, observation, appliedPublication];
    const acknowledgements: Array<{ effectId: string; receipt: Record<string, unknown> }> = [];
    vi.spyOn(refs, "readAppliedPublication").mockImplementation((effectId) =>
      effectId === appliedPublication.effectId
        ? {
            publicationId: appliedPublication.effectId,
            previousEventId: "event:main",
            publishedEventId: "event:caller",
            hostRefsBasisDigest: "host-refs-basis:before",
            resultHostRefsBasisDigest: "host-refs-basis:after",
            entries: [],
            appliedAt: Date.parse("2026-07-16T12:00:00.000Z"),
            observersAppliedAt: Date.parse("2026-07-16T12:00:00.000Z"),
            semanticAcknowledgedAt: null,
          }
        : null
    );
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsPendingSemanticEffects") return pending;
      if (method === "vcsSemanticEffectAck") {
        const acknowledgement = (input as { acknowledgement: (typeof acknowledgements)[number] })
          .acknowledgement;
        acknowledgements.push(acknowledgement);
        pending.splice(
          pending.findIndex((effect) => effect.effectId === acknowledgement.effectId),
          1
        );
        return { kind: "complete", result: null };
      }
      throw new Error(`unexpected ${method}`);
    });
    await vcs.attachGad(providerFromWireCall(call));

    await expect(vcs.recoverPendingSemanticEffects()).resolves.toBe(2);
    expect(pending).toEqual([unauthorizedPublication]);
    expect(acknowledgements).toEqual([
      {
        effectId: observation.effectId,
        payloadDigest: observation.payloadDigest,
        receipt: { files: [] },
      },
      {
        effectId: appliedPublication.effectId,
        payloadDigest: appliedPublication.payloadDigest,
        receipt: { applied: true, appliedAt: "2026-07-16T12:00:00.000Z" },
      },
    ]);
  });

  it("does not turn a generic trusted host call into publication authority", async () => {
    const { refs, vcs } = await harness();
    const updateMains = vi.spyOn(refs, "updateMains");
    const call = vi.fn(async (method: string) => {
      if (method !== "vcsPush") throw new Error(`unexpected ${method}`);
      return {
        kind: "effects-pending",
        result: null,
        effects: [
          {
            effectId: "effect:generic-host-push",
            scopeKind: "workspace",
            scopeId: "workspace:test",
            commandId: "command:generic-host-push",
            kind: "publish-main",
            payload: {
              previousEventId: "event:main",
              publishedEventId: "event:next",
              repositories: [],
            },
            payloadDigest: "effect-digest:generic-host-push",
            status: "pending",
          },
        ],
      };
    });
    await vcs.attachGad(providerFromWireCall(call));

    await expect(vcs.semanticDirectCall("vcsPush", {})).rejects.toThrow(
      "protected publication has no verified gate context"
    );
    expect(updateMains).not.toHaveBeenCalled();
  });

  it("releases the context lifecycle lock when caller publication is aborted", async () => {
    const { refs, vcs } = await harness();
    const heldPublication = new Promise<never>(() => {});
    const updateMains = vi
      .spyOn(refs, "updateMains")
      .mockImplementation(async () => heldPublication);
    const call = vi.fn(async (method: string, _request: unknown) => {
      const semanticMethod = method;
      if (semanticMethod === "vcsStatus") {
        return { kind: "complete", result: { recovered: true } };
      }
      if (semanticMethod !== "vcsPush") throw new Error(`unexpected ${semanticMethod}`);
      return {
        kind: "effects-pending",
        result: null,
        effects: [
          {
            effectId: "effect:aborted-publication",
            scopeKind: "context",
            scopeId: "context:aborted-publication",
            commandId: "command:aborted-publication",
            kind: "publish-main",
            payload: {
              previousEventId: "event:main",
              publishedEventId: "event:aborted",
              repositories: [],
            },
            payloadDigest: "effect-digest:aborted-publication",
            status: "pending",
          },
        ],
      };
    });
    await vcs.attachGad(providerFromWireCall(call));
    const controller = new AbortController();
    const caller = createVerifiedCaller("panel:test", "panel", {
      callerId: "panel:test",
      callerKind: "panel",
      repoPath: "panels/test",
      effectiveVersion: "test-version",
    });

    const publication = vcs.semanticPublishCall(
      { contextId: "context:aborted-publication" },
      null,
      caller,
      { class: "internal", externalKeys: [] },
      controller.signal
    );
    await vi.waitFor(() => expect(updateMains).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Publication cancelled", "AbortError"));

    await expect(publication).rejects.toMatchObject({
      name: "AbortError",
      message: "Publication cancelled",
    });
    await expect(
      vcs.semanticCall("vcsStatus", {
        input: { contextId: "context:aborted-publication" },
        ingress: {
          causalParent: null,
          contextIntegrity: { class: "internal", externalKeys: [] },
        },
      })
    ).resolves.toEqual({ recovered: true });
  });

  it("refuses to reconstruct an initial publication without its source plan", async () => {
    const { refs, vcs } = await harness();
    const imported = { kind: "event", eventId: "event:initial-import" } as const;
    vi.spyOn(vcs, "ensureContext").mockResolvedValue(imported);
    vi.spyOn(refs, "listMains").mockReturnValue([]);
    const updateMains = vi.spyOn(refs, "updateMains");
    const semanticDirectCall = vi
      .spyOn(vcs, "semanticDirectCall")
      .mockImplementation(async (method: string, input: unknown) => {
        if (method === "vcsInspect") {
          const node = (input as { node: { eventId?: string } }).node;
          if (node.eventId === "event:genesis") {
            return {
              root: { kind: "event", eventId: "event:genesis" },
              node: {
                kind: "event",
                value: {
                  eventId: "event:genesis",
                  kind: "genesis",
                  parentEventIds: [],
                  applicationIds: [],
                },
              },
              edges: [],
              hasMoreEdges: false,
            };
          }
          return {
            root: imported,
            node: {
              kind: "event",
              value: {
                eventId: imported.eventId,
                workspaceId: "workspace:test",
                commandId: "command:initial-import",
                kind: "commit",
                workspaceFactRootId: "workspace-fact-root:initial",
                parentEventIds: ["event:genesis"],
                applicationIds: ["application:initial-import"],
                decisionIds: [],
                message: "Import initial workspace snapshot",
                semanticProtocol: "semantic-vcs:test",
                createdAt: "2026-07-16T12:00:00.000Z",
              },
            },
            edges: [],
            hasMoreEdges: false,
          };
        }
        throw new Error(`unexpected ${method}`);
      });
    const call = vi.fn(async (method: string) => {
      if (method === "vcsPush") {
        return {
          kind: "effects-pending",
          result: { eventId: imported.eventId },
          effects: [
            {
              effectId: "effect:initial-publication-retry",
              scopeKind: "workspace",
              scopeId: "workspace:test",
              commandId: `initial-push:${imported.eventId}`,
              kind: "publish-main",
              payload: {
                previousEventId: "event:genesis",
                publishedEventId: imported.eventId,
                repositories: [],
              },
              payloadDigest: "effect-digest:initial-publication-retry",
              status: "pending",
            },
          ],
        };
      }
      if (method === "vcsSemanticEffectAck") {
        return { kind: "complete", result: { eventId: imported.eventId } };
      }
      throw new Error(`unexpected ${method}`);
    });
    await vcs.attachGad(providerFromWireCall(call));

    await expect(vcs.activateWorkspaceFromSource()).rejects.toThrow(
      "workspace source is missing meta/vibestudio.yml"
    );
    expect(semanticDirectCall).toHaveBeenCalledTimes(4);
    expect(updateMains).not.toHaveBeenCalled();
  });

  it("coalesces concurrent initialization of the same large context", async () => {
    const { vcs } = await harness();
    let complete!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      complete = resolve;
    });
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsContextMaterializationCommand") {
        return emptyRepairCommand(input as never, {
          kind: "event",
          eventId: "event:main",
        });
      }
      if (method !== "vcsEnsureContext") throw new Error(`unexpected ${method}`);
      return await pending;
    });
    await vcs.attachGad(providerFromWireCall(call));

    const first = vcs.ensureContext("context:large");
    const second = vcs.ensureContext("context:large");
    expect(call).toHaveBeenCalledOnce();

    complete({
      kind: "complete",
      result: { working: { ref: { kind: "event", eventId: "event:main" } } },
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "event", eventId: "event:main" },
      { kind: "event", eventId: "event:main" },
    ]);
  });

  it("establishes a runtime context without materializing its filesystem projection", async () => {
    const { root, vcs } = await harness();
    const contextId = "context:runtime";
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method !== "vcsEnsureContext") throw new Error(`unexpected ${method}`);
      expect(input).toMatchObject({ projection: "deferred" });
      return {
        kind: "complete",
        result: { working: { ref: { kind: "event", eventId: "event:main" } } },
      };
    });
    await vcs.attachGad(providerFromWireCall(call));

    await expect(vcs.ensureSemanticContext(contextId)).resolves.toEqual({
      kind: "event",
      eventId: "event:main",
    });

    expect(call).toHaveBeenCalledOnce();
    await expect(
      fsp.stat(path.join(root, "contexts", contextId, ".gad", "context-materialization.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("linearizes deletion after initialization and removes projection bytes first", async () => {
    const { root, vcs } = await harness();
    let completeEnsure!: (value: unknown) => void;
    const pendingEnsure = new Promise((resolve) => {
      completeEnsure = resolve;
    });
    const contextId = "context:lifecycle";
    const contextDir = path.join(root, "contexts", contextId);
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsEnsureContext") return pendingEnsure;
      if (method === "vcsContextMaterializationCommand") {
        return emptyRepairCommand(input as never, {
          kind: "event",
          eventId: "event:main",
        });
      }
      if (method === "vcsDropContext") {
        await expect(fsp.stat(contextDir)).rejects.toMatchObject({ code: "ENOENT" });
        return { dropped: true };
      }
      throw new Error(`unexpected ${method}`);
    });
    await vcs.attachGad(providerFromWireCall(call));

    const initialization = vcs.ensureContext(contextId);
    const deletion = vcs.dropContext(contextId);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenLastCalledWith("vcsEnsureContext", expect.anything());

    completeEnsure({
      kind: "complete",
      result: { working: { ref: { kind: "event", eventId: "event:main" } } },
    });
    await initialization;
    await deletion;
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "vcsEnsureContext",
      "vcsContextMaterializationCommand",
      "vcsDropContext",
    ]);
  });

  it("materializes a self-contained effect and acknowledges its derived content root", async () => {
    const { root, blobsDir, vcs } = await harness();
    const bytes = Buffer.from("hello from semantics\n");
    const contentHash = (await putBytes(blobsDir, bytes)).digest;
    const command = contextMaterializationCommand({
      contextId: "context:one",
      commandId: "command:edit",
      mode: "initialize",
      previousState: null,
      targetState: { kind: "application", applicationId: "application:one" },
      repositories: [
        {
          repositoryId: "repository:app",
          repoPath: "packages/app",
          presence: "present",
          fileManifestId: "manifest:app",
          source: {
            kind: "snapshot",
            files: [
              {
                path: "index.ts",
                contentHash,
                mode: 0o644,
              },
            ],
          },
        },
      ],
      blobs: [],
    });
    const effect = {
      ...command,
      scopeKind: "context" as const,
      scopeId: command.contextId,
      kind: "materialize-context" as const,
      payload: command,
      status: "pending" as const,
    };
    let receipt: Record<string, unknown> | null = null;
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsEdit") {
        return { kind: "effects-pending", result: { pending: true }, effects: [effect] };
      }
      if (method === "vcsSemanticEffectAck") {
        receipt = (input as { acknowledgement: { receipt: Record<string, unknown> } })
          .acknowledgement.receipt;
        return { kind: "complete", result: { ok: true } };
      }
      throw new Error(`unexpected ${method}`);
    });
    await vcs.attachGad(providerFromWireCall(call));

    await expect(
      vcs.semanticCall("vcsEdit", {
        input: {},
        ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
      })
    ).resolves.toEqual({ ok: true });
    await expect(
      fsp.readFile(
        path.join(root, "contexts", "context:one", "packages", "app", "index.ts"),
        "utf8"
      )
    ).resolves.toBe("hello from semantics\n");
    expect(receipt).toMatchObject({
      materializationId: command.materializationId,
      targetState: command.targetState,
      repositories: [
        {
          repositoryId: "repository:app",
          repoPath: "packages/app",
          contentRoot: expect.stringMatching(/^state:[0-9a-f]{64}$/),
        },
      ],
    });
  });

  it("executes a derived repair command directly without journaling or acknowledging it", async () => {
    const { vcs } = await harness();
    const command = contextMaterializationCommand({
      contextId: "context:replay",
      commandId: "command:replay",
      mode: "replace",
      previousState: null,
      targetState: { kind: "application", applicationId: "application:replay" },
      repositories: [],
      blobs: [],
    });
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsEnsureContext") {
        return { kind: "complete", result: { working: { ref: command.targetState } } };
      }
      if (method === "vcsContextMaterializationCommand") {
        expect(input).toEqual({ contextId: command.contextId, materializedState: null });
        return command;
      }
      throw new Error(`unexpected ${method}`);
    });
    await vcs.attachGad(providerFromWireCall(call));

    await expect(vcs.ensureContext(command.contextId)).resolves.toEqual(command.targetState);
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "vcsEnsureContext",
      "vcsContextMaterializationCommand",
    ]);
  });

  it("verifies a recovered projection once and trusts its exact receipt for this host generation", async () => {
    const { vcs, deps } = await harness();
    const contextId = "context:verified-projection";
    const targetState = { kind: "event" as const, eventId: "event:main" };
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsEnsureContext") {
        return { kind: "complete", result: { working: { ref: targetState } } };
      }
      if (method === "vcsContextMaterializationCommand") {
        return emptyRepairCommand(input as never, targetState);
      }
      throw new Error(`unexpected ${method}`);
    });
    await vcs.attachGad(providerFromWireCall(call));
    const firstGenerationMatches = vi.spyOn(
      (
        vcs as unknown as {
          materializer: { projectionMatches: (state: unknown) => Promise<boolean> };
        }
      ).materializer,
      "projectionMatches"
    );

    await vcs.ensureContext(contextId);
    await vcs.ensureContext(contextId);
    expect(firstGenerationMatches).not.toHaveBeenCalled();

    const restarted = new WorkspaceVcs(deps);
    await restarted.attachGad(providerFromWireCall(call));
    const recoveredMatches = vi.spyOn(
      (
        restarted as unknown as {
          materializer: { projectionMatches: (state: unknown) => Promise<boolean> };
        }
      ).materializer,
      "projectionMatches"
    );

    await restarted.ensureContext(contextId);
    await restarted.ensureContext(contextId);
    expect(recoveredMatches).toHaveBeenCalledOnce();
  });

  it("observes import digests as intrinsic descriptors without returning blob bytes", async () => {
    const { blobsDir, vcs } = await harness();
    const original = Buffer.from("imported\n");
    const contentHash = (await putBytes(blobsDir, original)).digest;
    const observation = {
      effectId: "effect:import-observe",
      scopeKind: "context" as const,
      scopeId: "context:import",
      commandId: "command:import",
      kind: "observe-content" as const,
      payloadDigest: "digest:import-observe",
      payload: {
        method: "importSnapshot",
        representation: "descriptor",
        files: [{ contentHash }],
      },
      status: "pending" as const,
    };
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsImportSnapshot") {
        return { kind: "effects-pending", result: null, effects: [observation] };
      }
      const receipt = (input as { acknowledgement: { receipt: Record<string, unknown> } })
        .acknowledgement.receipt;
      expect(receipt).toEqual({
        files: [
          {
            contentHash,
            contentKind: "text",
            byteLength: original.byteLength,
            coordinateExtent: "imported\n".length,
          },
        ],
      });
      return { kind: "complete", result: { eventId: "event:import" } };
    });
    await vcs.attachGad(providerFromWireCall(call));

    await expect(
      vcs.semanticCall("vcsImportSnapshot", {
        input: {},
        ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
      })
    ).resolves.toEqual({ eventId: "event:import" });
  });

  it("drains observation then materialization without an authorship channel", async () => {
    const { blobsDir, vcs } = await harness();
    const original = Buffer.from("before\n");
    const contentHash = (await putBytes(blobsDir, original)).digest;
    const materialization = contextMaterializationCommand({
      contextId: "context:one",
      commandId: "command:edit",
      mode: "initialize",
      previousState: null,
      targetState: { kind: "application", applicationId: "application:one" },
      repositories: [],
      blobs: [],
    });
    const observation = {
      effectId: "effect:observe",
      scopeKind: "context" as const,
      scopeId: "context:one",
      commandId: "command:edit",
      kind: "observe-content" as const,
      payloadDigest: "digest:observe",
      payload: {
        method: "edit",
        representation: "bytes",
        files: [{ contentHash }],
      },
      status: "pending" as const,
    };
    const materializeEffect = {
      ...materialization,
      scopeKind: "context" as const,
      scopeId: "context:one",
      kind: "materialize-context" as const,
      payload: materialization,
      status: "pending" as const,
    };
    let acknowledgements = 0;
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsEdit") {
        return { kind: "effects-pending", result: null, effects: [observation] };
      }
      const acknowledgement = (input as { acknowledgement: { receipt: Record<string, unknown> } })
        .acknowledgement;
      acknowledgements += 1;
      if (acknowledgements === 1) {
        expect(acknowledgement.receipt).toEqual({
          files: [{ contentHash, base64: original.toString("base64") }],
        });
        return { kind: "effects-pending", result: null, effects: [materializeEffect] };
      }
      return { kind: "complete", result: { applicationId: "application:one" } };
    });
    await vcs.attachGad(providerFromWireCall(call));
    await expect(
      vcs.semanticCall("vcsEdit", {
        input: {},
        ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
      })
    ).resolves.toEqual({ applicationId: "application:one" });
    expect(acknowledgements).toBe(2);
  });

  it("derives a new repository root from one exact changed path", async () => {
    const { root, blobsDir, vcs } = await harness();
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    const beforeHash = (await putBytes(blobsDir, before)).digest;
    const afterHash = (await putBytes(blobsDir, after)).digest;
    const basis = await mirrorWorktreeTree(blobsDir, [
      { path: "index.ts", contentHash: beforeHash, mode: 33188 },
    ]);
    const command = contextMaterializationCommand({
      contextId: "context:delta",
      commandId: "command:delta",
      mode: "initialize",
      previousState: null,
      targetState: { kind: "application", applicationId: "application:delta" },
      repositories: [
        {
          repositoryId: "repository:app",
          repoPath: "packages/app",
          presence: "present",
          fileManifestId: "manifest:delta",
          source: {
            kind: "delta",
            basisContentRoot: basis.stateHash,
            changes: [
              {
                path: "index.ts",
                expected: { contentHash: beforeHash, mode: 0o644 },
                result: { contentHash: afterHash, mode: 0o644 },
              },
            ],
          },
        },
      ],
      blobs: [],
    });
    const effect = {
      ...command,
      scopeKind: "context" as const,
      scopeId: command.contextId,
      kind: "materialize-context" as const,
      payload: command,
      status: "pending" as const,
    };
    let receipt: Record<string, unknown> | null = null;
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsMove") {
        return { kind: "effects-pending", result: null, effects: [effect] };
      }
      receipt = (input as { acknowledgement: { receipt: Record<string, unknown> } }).acknowledgement
        .receipt;
      return { kind: "complete", result: { ok: true } };
    });
    await vcs.attachGad(providerFromWireCall(call));

    await vcs.semanticCall("vcsMove", {
      input: {},
      ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
    });

    await expect(
      fsp.readFile(
        path.join(root, "contexts", "context:delta", "packages", "app", "index.ts"),
        "utf8"
      )
    ).resolves.toBe("after\n");
    expect(receipt).toMatchObject({
      repositories: [
        {
          repositoryId: "repository:app",
          contentRoot: expect.stringMatching(/^state:[0-9a-f]{64}$/),
        },
      ],
    });
  });

  it("publishes exact repository manifests through protected event and content CAS", async () => {
    const { blobsDir, refs, vcs } = await harness();
    const bytes = Buffer.from("published\n");
    const contentHash = (await putBytes(blobsDir, bytes)).digest;
    const otherContentHash = (await putBytes(blobsDir, Buffer.from("other\n"))).digest;
    const firstEffect = {
      effectId: "effect:publish",
      scopeKind: "context" as const,
      scopeId: "context:one",
      commandId: "command:push",
      kind: "publish-main" as const,
      payloadDigest: "digest:publish",
      status: "pending" as const,
      payload: {
        contextId: "context:one",
        previousEventId: "event:genesis",
        publishedEventId: "event:one",
        repositories: [
          {
            repositoryId: "repository:app",
            repoPath: "packages/app",
            presence: "present",
            fileManifestId: "manifest:app",
            source: {
              kind: "snapshot",
              files: [
                {
                  path: "index.ts",
                  contentHash,
                  mode: 0o644,
                },
              ],
            },
          },
        ],
      },
    };
    const secondEffect = {
      ...firstEffect,
      effectId: "effect:publish-two",
      commandId: "command:push-two",
      payloadDigest: "digest:publish-two",
      payload: {
        ...firstEffect.payload,
        previousEventId: "event:one",
        publishedEventId: "event:two",
        repositories: [
          ...firstEffect.payload.repositories,
          {
            repositoryId: "repository:other",
            repoPath: "packages/other",
            presence: "present" as const,
            fileManifestId: "manifest:other",
            source: {
              kind: "snapshot" as const,
              files: [{ path: "index.ts", contentHash: otherContentHash, mode: 0o644 }],
            },
          },
        ],
      },
    };
    const pendingEffects = [firstEffect, secondEffect];
    const updateMains = vi.spyOn(refs, "updateMains");
    const call = vi.fn(async (method: string, input: unknown) => {
      if (method === "vcsPush") {
        const effect = pendingEffects.shift();
        if (!effect) throw new Error("unexpected semantic dispatch after queued publications");
        return { kind: "effects-pending", result: null, effects: [effect] };
      }
      const receipt = (input as { acknowledgement: { receipt: Record<string, unknown> } })
        .acknowledgement.receipt;
      expect(Object.keys(receipt).sort()).toEqual(["applied", "appliedAt"]);
      expect(receipt).toEqual({ applied: true, appliedAt: expect.any(String) });
      return { kind: "complete", result: { eventId: "event:one" } };
    });
    await vcs.attachGad(providerFromWireCall(call));
    await vcs.semanticCall(
      "vcsPush",
      {
        input: {},
        ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
      },
      {
        kind: "caller",
        caller: createVerifiedCaller("panel:test", "panel", {
          callerId: "panel:test",
          callerKind: "panel",
          repoPath: "panels/test",
          effectiveVersion: "test-version",
        }),
      }
    );
    expect(refs.listMains()).toEqual([
      expect.objectContaining({
        repoPath: "packages/app",
        contentRoot: expect.stringMatching(/^state:[0-9a-f]{64}$/),
      }),
    ]);
    expect(refs.readAppliedPublication("effect:publish")).toMatchObject({
      previousEventId: "event:genesis",
      publishedEventId: "event:one",
    });
    const firstGateContext = updateMains.mock.calls[0]?.[0].gateContext as
      | { kind?: string; candidateWorkspaceState?: string }
      | undefined;
    expect(firstGateContext).toMatchObject({
      kind: "caller",
      candidateWorkspaceState: expect.stringMatching(/^state:[0-9a-f]{64}$/),
    });
    if (firstGateContext?.kind !== "caller" || !firstGateContext.candidateWorkspaceState) {
      throw new Error("publication did not carry its exact candidate workspace state");
    }
    expect(vcs.executionStateForContent(firstGateContext.candidateWorkspaceState)).toEqual({
      kind: "event",
      eventId: "event:one",
    });

    await vcs.semanticCall(
      "vcsPush",
      {
        input: {},
        ingress: { causalParent: null, contextIntegrity: { class: "internal", externalKeys: [] } },
      },
      {
        kind: "caller",
        caller: createVerifiedCaller("panel:test", "panel", {
          callerId: "panel:test",
          callerKind: "panel",
          repoPath: "panels/test",
          effectiveVersion: "test-version",
        }),
      }
    );
    expect(updateMains.mock.calls.at(-1)?.[0].entries).toEqual([
      expect.objectContaining({ repoPath: "packages/other", expectedOld: null }),
    ]);
  });
});
