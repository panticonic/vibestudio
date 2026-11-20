import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONTEXT_BINDING_FILE, parseContextBinding } from "@vibestudio/shared/contextBinding";
import {
  EMPTY_STATE_HASH,
  sha256Hex,
  sha256HexSyncText,
} from "@vibestudio/content-addressing";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import * as blobstoreService from "../services/blobstoreService.js";
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
import { editWorkspaceParticipant, workspaceParticipantIdentity } from "./workspaceHistoryHost.js";
import { WorkspaceRepositories } from "./workspaceRepositories.js";
import { WorkspaceVcs } from "./workspaceVcs.js";

const roots: string[] = [];
const TEST_PROVIDER = { source: "test/provider", className: "TestProvider", objectKey: "test" };

const editInput = (contextId = "context:test") => ({
  commandId: "command:test",
  contextId,
  expectedWorkingHead: { kind: "event" as const, eventId: "event:test" },
  changes: [{ kind: "repository-delete" as const, repositoryId: "repository:test" }],
});
function mutationResult(input: {
  commandId: string;
  contextId: string;
  expectedWorkingHead: { kind: "event" | "application"; eventId?: string; applicationId?: string };
}) {
  return {
    commandId: input.commandId,
    contextId: input.contextId,
    workUnitId: "work-unit:test",
    applicationId: "application:test",
    changeCount: 0,
    changeIds: [],
    incorporatedChangeCount: 0,
    incorporatedChangeIds: [],
    decisionIds: [],
    workingHead: input.expectedWorkingHead,
  };
}

function providerFromWireCall(call: (method: string, input: unknown) => Promise<unknown>) {
  return createWorkspaceSemanticPort(
    {
      dispatch: (_provider: unknown, method: string, input: unknown) => call(method, input),
    } as never,
    TEST_PROVIDER
  );
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
  const attachGcHistory = async (
    readRoots: (owner: typeof TEST_PROVIDER) => string[] = () => [],
    participants: string[] = []
  ) => {
    const canonical = { ...TEST_PROVIDER, objectKey: "canonical" };
    const eventId = "event:gc-main";
    vi.spyOn(refs, "readMainSemanticState").mockReturnValue({ kind: "event", eventId });
    const dispatch = vi.fn(async (owner: typeof canonical, method: string) => {
      switch (method) {
        case "readHistoryMain": return { head: "main", eventId };
        case "listHistoryAppliedPublications": return [];
        case "listHistoryRetainedParticipants": return participants;
        case "readHistoryContentRoots": return readRoots(owner);
        default: throw new Error(`Unexpected history method ${method}`);
      }
    });
    await vcs.attachParticipantHistory({ dispatch: { dispatch }, canonical });
  };
  return { root, blobsDir, refs, vcs, deps, attachGcHistory };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("WorkspaceVcs semantic host orchestration", () => {
  it("admits recall causes only from the bound participant and protected workspace revisions", async () => {
    const { vcs, refs } = await harness();
    const eventId = "published-event";
    const contextId = "context:reader";
    const owner = { ...TEST_PROVIDER, objectKey: "reader" };
    const canonical = { ...TEST_PROVIDER, objectKey: "canonical" };
    const caller = {
      ...createVerifiedCaller("agent:reader", "server"),
      agentBinding: { contextId, channelId: "channel:reader", entityId: "agent:reader" },
    } satisfies Parameters<WorkspaceVcs["participantRecallCauses"]>[0];
    const privateCause = ["private-log", "main", "private-invocation"];
    const sharedCause = ["shared-log", "main", "shared-invocation"];
    const dispatch = vi.fn(async (_target: typeof owner, method: string, input: unknown) => {
      if (method === "readHistoryRecallBasis") return ["private-revision", "protected-revision"];
      if (method === "readHistorySearchCauses") {
        return (input as { revision: string }).revision === "private-revision"
          ? [privateCause, sharedCause] : [sharedCause];
      }
      throw new Error(`Unexpected history call ${method}`);
    });
    const scope = vi.spyOn(vcs, "openParticipantScope").mockResolvedValue({
      dispatch: { dispatch }, canonical, owner, caller, contextId, ownerContextId: contextId,
      workingHead: "private-revision",
    });
    vi.spyOn(refs, "readMainSemanticState").mockReturnValue({ kind: "event", eventId });
    await expect(vcs.participantRecallCauses(caller, [{ query: "Northstar" }]))
      .resolves.toEqual([privateCause, sharedCause]);
    expect(scope).toHaveBeenCalledExactlyOnceWith({ caller, contextId, ownerContextId: contextId });
    expect(dispatch.mock.calls).toEqual([
      [owner, "readHistoryRecallBasis", { contextId, protectedEventId: eventId }],
      [owner, "readHistorySearchCauses", { revision: "private-revision", after: null }],
      [owner, "readHistorySearchCauses", { revision: "protected-revision", after: null }],
    ]);
    await expect(vcs.participantRecallCauses(caller, [{ query: "Northstar", kinds: ["commit"] }]))
      .resolves.toEqual([]);
    await expect(vcs.participantRecallCauses(createVerifiedCaller("panel:reader", "panel"), [{ query: "Northstar" }]))
      .resolves.toEqual([]);
    expect(scope).toHaveBeenCalledTimes(1);
  });

  it("rebuilds commit recall from the exact protected event when native history attaches", async () => {
    const { vcs, refs } = await harness();
    const eventId = "native-main";
    const head = "a".repeat(40);
    const canonical = { ...TEST_PROVIDER, objectKey: "canonical" };
    const document = { eventId, revision: head, text: "Keep the published configuration", createdAt: "2026-08-14T00:00:00Z" };
    vi.spyOn(refs, "readMainSemanticState").mockReturnValue({ kind: "event", eventId });
    const recordHistoryCommitMemory = vi.fn();
    await vcs.attachGad({ recordHistoryCommitMemory } as never);
    const dispatch = vi.fn(async (_target: typeof TEST_PROVIDER, method: string, input?: unknown) => {
      switch (method) {
        case "readHistoryMain":
          return input === undefined ? { head, eventId } : { head, eventId, commitMemory: document };
        case "listHistoryAppliedPublications":
          return [];
        default:
          throw new Error(`Unexpected native history call ${method}`);
      }
    });
    await vcs.attachParticipantHistory({ canonical, dispatch: { dispatch } });
    expect(dispatch).toHaveBeenCalledWith(canonical, "readHistoryMain", { commitMemoryEventId: eventId });
    expect(recordHistoryCommitMemory).toHaveBeenCalledExactlyOnceWith(document);
  });

  it("reopens separate participant copies and reclaims directories after archival", async () => {
    const { vcs, blobsDir, refs } = await harness();
    vi.spyOn(refs, "readMainSemanticState").mockReturnValue({ kind: "event", eventId: "main-event" });
    const canonical = { ...TEST_PROVIDER, objectKey: "canonical" };
    const contextId = "ctx-shared";
    const content = (await putBytes(blobsDir, Buffer.from("participant-only bytes"))).digest;
    const state = { kind: "event", eventId: "private-event" };
    const allocated = new Set<string>();
    let refuseRetirement = true;
    const dispatch = vi.fn(async (owner: typeof TEST_PROVIDER, method: string, raw?: unknown) => {
      if (method === "readHistoryMain") return { head: "main", eventId: "main-event" };
      if (method === "listHistoryAppliedPublications") return [];
      if (method === "reserveHistoryParticipant") {
        const { participantId } = raw as { participantId: string };
        const objectKey = `work-${sha256HexSyncText(participantId)}`;
        allocated.add(objectKey);
        return {
          targetId: `do:${owner.source}:${owner.className}:${objectKey}`,
          head: "initial",
          origin: { ref: "canonical", token: "grant" },
        };
      }
      if (method === "retireHistoryContext") {
        expect(owner).toEqual(canonical);
        expect(raw).toEqual({ contextId });
        if (refuseRetirement) throw new Error("Archive incomplete");
        return { contextId, targets: [...allocated] };
      }
      if (method === "bindHistoryContext") {
        const binding = raw as { contextId: string };
        expect(binding.contextId).toBe(contextId);
        const belongsToOwner = owner.objectKey === `work-${sha256HexSyncText(
          workspaceParticipantIdentity(taskCaller(1), contextId)
        )}`;
        return belongsToOwner ? "private-working" : "main";
      }
      if (method === "readHistoryProjection") {
        return {
          head: "private-working",
          state,
          repositories: [{
            repositoryId: "repository", repoPath: "meta", presence: "present", fileManifestId: "files",
            source: { kind: "snapshot", files: [{ path: "note.txt", contentHash: content, mode: 420 }] },
          }],
        };
      }
      throw new Error(`Unexpected participant dispatch ${method}`);
    });
    const taskCaller = (agent: number) => ({
      runtime: { kind: "do", id: `agent-${agent}` },
      nativeInvocation: {
        owner: { runtimeId: `agent-${agent}`, authoritySessionId: "sealed" },
        task: { conversationId: 0, taskId: 1 },
        operation: { kind: "tool", assistantEntryId: 0, callId: "bind" },
      },
    } as const);
    const bind = (agent: number) => vcs.bindParticipantFilesystem({
      contextId,
      caller: taskCaller(agent),
      isTracked: async () => true,
    });
    await expect(bind(1)).rejects.toThrow("Participant workspace history is unavailable");
    const destroyRetiredStorage = vi.fn(async (_owner: typeof TEST_PROVIDER) => {});
    let permitAttachment!: () => void;
    const attachmentAllowed = new Promise<void>((resolve) => {
      permitAttachment = resolve;
    });
    void vcs.startSemanticInitialization(async () => {
      await attachmentAllowed;
      await vcs.attachParticipantHistory({ dispatch: { dispatch }, canonical, destroyRetiredStorage });
    });
    const pending = bind(1);
    permitAttachment();
    const [first, second] = await Promise.all([pending, bind(2)]);
    expect(first.sourceRoot).not.toBe(second.sourceRoot);
    const { vcs: restarted, refs: restartedRefs } = await harness();
    vi.spyOn(restartedRefs, "readMainSemanticState").mockReturnValue({ kind: "event", eventId: "main-event" });
    await restarted.attachParticipantHistory({ dispatch: { dispatch }, canonical });
    await expect(restarted.openParticipantScope({
      contextId, ownerContextId: contextId, caller: taskCaller(1),
    })).resolves.toMatchObject({ workingHead: "private-working" });
    await expect(restarted.openParticipantScope({
      contextId, ownerContextId: contextId, caller: taskCaller(2),
    })).resolves.toMatchObject({ workingHead: "main" });
    await first.bridge.ensureMaterialized(contextId, "all");
    await expect(first.bridge.isMaterialized(contextId, "meta")).resolves.toBe(true);
    await expect(second.bridge.isMaterialized(contextId, "meta")).resolves.toBe(false);
    await expect(fsp.readFile(path.join(first.sourceRoot, "meta/note.txt"), "utf8")).resolves.toBe("participant-only bytes");
    await expect(vcs.dropContext(contextId)).rejects.toThrow("Archive incomplete");
    expect(destroyRetiredStorage).not.toHaveBeenCalled();
    await expect(fsp.stat(first.sourceRoot)).resolves.toBeDefined();
    await expect(bind(1)).rejects.toThrow("context has retired");
    refuseRetirement = false;
    await vcs.dropContext(contextId);
    expect(destroyRetiredStorage.mock.calls.map(([owner]) => owner)).toEqual(
      [...allocated].map((objectKey) => ({ ...canonical, objectKey }))
    );
    await expect(fsp.stat(first.sourceRoot)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("registers, lists, and retires contexts in native history", async () => {
    const { vcs, refs } = await harness();
    const canonical = { ...TEST_PROVIDER, objectKey: "canonical" };
    const contextId = "native-runtime-context";
    const infrastructureContextId = "native-history-provider";
    const contexts = new Set<string>();
    let finishAdmission!: () => void;
    let noticeAdmission!: () => void;
    const admissionRequested = new Promise<void>((resolve) => { noticeAdmission = resolve; });
    const admissionAllowed = new Promise<void>((resolve) => { finishAdmission = resolve; });
    let holdAdmission = false;
    vi.spyOn(refs, "readMainSemanticState").mockReturnValue({ kind: "event", eventId: "main-event" });
    const legacy = vi.fn(async () => { throw new Error("Unexpected legacy workspace call"); });
    await vcs.attachGad(providerFromWireCall(legacy));
    const dispatch = vi.fn(async (owner: typeof canonical, method: string, value?: unknown) => {
      expect(owner).toEqual(canonical);
      switch (method) {
        case "readHistoryMain": return { head: "main", eventId: "main-event" };
        case "listHistoryAppliedPublications": return [];
        case "ensureHistoryRuntimeContext":
          expect(value).toEqual({ contextId });
          if (holdAdmission) {
            noticeAdmission();
            await admissionAllowed;
          }
          contexts.add(contextId);
          return;
        case "listHistoryRuntimeContexts":
          expect(value).toEqual({ prefix: "native-runtime" });
          return [...contexts];
        case "retireHistoryContext":
          expect(value).toEqual({ contextId });
          contexts.delete(contextId);
          return { contextId, targets: [] };
        default: throw new Error(`Unexpected participant dispatch ${method}`);
      }
    });
    await expect(vcs.ensureRuntimeContext(contextId)).rejects.toThrow("history is unavailable");
    await expect(vcs.listSemanticContexts()).rejects.toThrow("history is unavailable");
    await expect(vcs.dropContext(contextId)).rejects.toThrow("history is unavailable");
    await vcs.attachParticipantHistory({ canonical, dispatch: { dispatch }, infrastructureContextId });
    await vcs.ensureRuntimeContext(infrastructureContextId);
    await vcs.ensureRuntimeContext(contextId);
    await expect(vcs.listSemanticContexts("native-runtime")).resolves.toEqual([contextId]);
    holdAdmission = true;
    const pendingAdmission = vcs.ensureRuntimeContext(contextId);
    await admissionRequested;
    const retirement = vcs.dropContext(contextId);
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalledWith(canonical, "retireHistoryContext", { contextId });
    finishAdmission();
    await Promise.all([pendingAdmission, retirement]);
    await expect(vcs.listSemanticContexts("native-runtime")).resolves.toEqual([]);
    await expect(vcs.ensureRuntimeContext(contextId)).rejects.toThrow("context has retired");
    expect(legacy).not.toHaveBeenCalled();
  });

  it("requires native proof for private build sources", async () => {
    const { vcs } = await harness();
    const caller = createVerifiedCaller("shell:build", "shell");
    const state = { kind: "application", applicationId: "private-draft" } as const;
    await expect(vcs.participantBuildStateReachable(state, caller, null)).resolves.toBe(false);
    await expect(vcs.readFile("ctx:private-draft", "meta/vibestudio.yml"))
      .rejects.toThrow("Unknown content revision");
    await expect(vcs.resolveParticipantBuildSource(`state:${"a".repeat(64)}`, caller, null))
      .rejects.toThrow("Participant workspace history is unavailable");
  });

  it("keeps participant projections separate, advances one, and repairs its binding on retry", async () => {
    const { vcs, blobsDir, deps } = await harness();
    const contextId = "context:shared";
    const actorA = {
      ...createVerifiedCaller("shell:alice", "shell"), taskAuthority: `task:${"a".repeat(64)}` as const,
    };
    const actorB = {
      ...createVerifiedCaller("shell:bob", "shell"), taskAuthority: `task:${"b".repeat(64)}` as const,
    };
    const owners = [actorA, actorB].map((actor) => ({
      ...TEST_PROVIDER,
      objectKey: `work-${sha256HexSyncText(workspaceParticipantIdentity(actor, contextId))}`,
    }));
    const original = (await putBytes(blobsDir, Buffer.from("shared content"))).digest;
    const privateEdit = (await putBytes(blobsDir, Buffer.from("private edit"))).digest;
    let aliceEdited = false;
    const projection = (edited: boolean) => ({
        head: edited ? "edited" : "initial",
        state: edited
          ? { kind: "application", applicationId: "alice-edit" }
          : { kind: "event", eventId: "genesis" },
        repositories: [{
          repositoryId: "repo",
          repoPath: "packages/example",
          presence: "present",
          fileManifestId: edited ? "edited-manifest" : "initial-manifest",
          source: { kind: "snapshot", files: [
            { path: "note.txt", contentHash: edited ? privateEdit : original, mode: 0o644 },
          ] },
        }],
    });
    const receipts = new Set<string>();
    const dispatch = vi.fn(async (owner: typeof TEST_PROVIDER, method: string, input: unknown) => {
      const edited = aliceEdited && owner.objectKey === owners[0]!.objectKey;
      if (method === "readHistoryReferenceVisibility") return edited;
      if (method === "rememberHistoryContentSource" || method === "readHistoryContentSource") {
        const { stateHash } = input as { stateHash: string };
        const receipt = JSON.stringify([owner.objectKey, stateHash, edited]);
        if (method === "rememberHistoryContentSource") {
          receipts.add(receipt);
          return;
        }
        if (!receipts.has(receipt)) return null;
        const { state, repositories } = projection(edited);
        return { state, repositories };
      }
      expect(method).toBe("readHistoryProjection");
      expect(input).toEqual({ contextId });
      return projection(edited);
    });
    const project = (owner: typeof TEST_PROVIDER) =>
      vcs.materializeParticipantContext({ dispatch: { dispatch }, owner, contextId });
    const [alice, bob] = await Promise.all(owners.map(project));
    expect(alice!.folder).not.toBe(bob!.folder);
    const read = (folder: string) => fsp.readFile(path.join(folder, "packages/example/note.txt"), "utf8");
    await expect(read(alice!.folder)).resolves.toBe("shared content");
    await expect(read(bob!.folder)).resolves.toBe("shared content");
    aliceEdited = true;
    expect((await project(owners[0]!)).head).toBe("edited");
    await expect(read(alice!.folder)).resolves.toBe("private edit");
    await expect(read(bob!.folder)).resolves.toBe("shared content");
    const binding = path.join(alice!.folder, CONTEXT_BINDING_FILE);
    await fsp.unlink(binding);
    await project(owners[0]!);
    expect(parseContextBinding(JSON.parse(await fsp.readFile(binding, "utf8")))).toMatchObject({
      workspaceId: deps.workspaceId,
      contextId,
    });

    const canonical = { ...TEST_PROVIDER, objectKey: "canonical" };
    const attachment = {
      canonical,
      dispatch: { dispatch: vi.fn(async (_owner: typeof TEST_PROVIDER, method: string) => {
        if (method === "readHistoryMain") return { head: "initial", eventId: "genesis" };
        if (method === "readHistoryMainStateVisibility") return false;
        if (method === "listHistoryAppliedPublications") return [];
        throw new Error(`Unexpected canonical dispatch ${method}`);
      }) },
    };
    vi.spyOn(deps.refs, "readMainSemanticState").mockReturnValue({ kind: "event", eventId: "genesis" });
    await vcs.attachParticipantHistory(attachment);
    const resolveScope: WorkspaceVcs["openParticipantScope"] = async (input) => ({
      dispatch: { dispatch }, canonical, contextId, ownerContextId: input.ownerContextId,
      caller: input.caller,
      owner: input.caller === actorA ? owners[0]! : owners[1]!,
      workingHead: input.caller === actorA && aliceEdited ? "edited" : "initial",
    });
    const scope = vi.spyOn(vcs, "openParticipantScope").mockImplementation(resolveScope);
    const developmentSource = { contextId, repositoryId: "repo", requiredFiles: ["note.txt"] };
    const [alicePlan, bobPlan] = await Promise.all([
      vcs.planExactContextRepository(developmentSource, { caller: actorA, ownerContextId: contextId }),
      vcs.planExactContextRepository(developmentSource, { caller: actorB, ownerContextId: contextId }),
    ]);
    expect(alicePlan.sourceState).toEqual({ kind: "application", applicationId: "alice-edit" });
    expect(alicePlan.requiredFiles[0]?.contentHash).toBe(privateEdit);
    expect(bobPlan.sourceState).toEqual({ kind: "event", eventId: "genesis" });
    expect(bobPlan.requiredFiles[0]?.contentHash).toBe(original);
    const priorProjectionReads = dispatch.mock.calls.length;
    const plans = await vcs.planExactContextRepositories({
      contextId,
      repositories: [
        { repositoryId: "repo", requiredFiles: ["note.txt"] },
        { repositoryId: "repo", requiredFiles: [] },
      ],
    }, { caller: actorA, ownerContextId: contextId });
    expect(dispatch.mock.calls.slice(priorProjectionReads)).toEqual([
      [owners[0], "readHistoryProjection", { contextId }],
    ]);
    expect(plans.map(({ sourceState }) => sourceState)).toEqual([alicePlan.sourceState, alicePlan.sourceState]);
    await expect(vcs.resolveAdoptedParticipantRepository(developmentSource, {
      caller: actorA, ownerContextId: contextId,
    })).resolves.toEqual({ repoPath: "packages/example", workingHead: alicePlan.sourceState });
    const [a] = await vcs.contextRepoTargets(contextId, actorA);
    const [b] = await vcs.contextRepoTargets(contextId, actorB);
    expect(a!.stateHash).not.toBe(b!.stateHash);
    expect(await blobstoreService.readFileAtTree(blobsDir, a!.stateHash, "note.txt")).toMatchObject({ contentHash: privateEdit });
    expect(await blobstoreService.readFileAtTree(blobsDir, b!.stateHash, "note.txt")).toMatchObject({ contentHash: original });
    const before = dispatch.mock.calls.length;
    const targets = await vcs.contextRepoTargets(contextId, actorA);
    targets[0]!.stateHash = EMPTY_STATE_HASH;
    targets.push({ repoPath: "spoofed", stateHash: EMPTY_STATE_HASH });
    expect(await vcs.contextRepoTargets(contextId, actorA)).toEqual([a]);
    expect(dispatch.mock.calls).toHaveLength(before);
    const [privateSource, sharedSource] = await Promise.all([
      vcs.resolveCallerContextState(contextId, actorA),
      vcs.resolveCallerContextState(contextId, actorB),
    ]);
    expect(privateSource.semanticState).toEqual({ kind: "application", applicationId: "alice-edit" });
    expect(sharedSource.semanticState).toEqual({ kind: "event", eventId: "genesis" });
    await expect(vcs.readFile(privateSource.stateHash, "packages/example/note.txt")).resolves
      .toMatchObject({ content: { kind: "text", text: "private edit" } });
    await expect(vcs.readFile(sharedSource.stateHash, "packages/example/note.txt")).resolves
      .toMatchObject({ content: { kind: "text", text: "shared content" } });
    expect(scope).toHaveBeenCalledWith({ caller: actorA, contextId, ownerContextId: contextId });
    await expect(vcs.contextRepoTargets(contextId)).rejects.toThrow("verified caller");
    await expect(vcs.resolveParticipantBuildSource(privateSource.stateHash, actorA, contextId))
      .resolves.toEqual(privateSource);
    await expect(vcs.resolveParticipantBuildSource(privateSource.stateHash, actorB, contextId))
      .rejects.toMatchObject({ code: "EACCES" });
    const reopened = new WorkspaceVcs(deps);
    await reopened.attachParticipantHistory(attachment);
    vi.spyOn(reopened, "openParticipantScope").mockImplementation(resolveScope);
    await expect(reopened.resolveParticipantBuildSource(privateSource.stateHash, actorA, contextId))
      .resolves.toEqual(privateSource);
    aliceEdited = false;
    await expect(reopened.resolveParticipantBuildSource(privateSource.stateHash, actorA, contextId))
      .rejects.toMatchObject({ code: "EACCES" });
  });

  it("serves prepared content while runtime requests await native attachment", async () => {
    const { deps, refs } = await harness();
    const initialContentState = `state:${"a".repeat(64)}`;
    const vcs = new WorkspaceVcs({ ...deps, initialContentState });
    const canonical = { ...TEST_PROVIDER, objectKey: "canonical" };
    const eventId = "event:initialized";
    vi.spyOn(refs, "readMainSemanticState").mockReturnValue({ kind: "event", eventId });
    const dispatch = vi.fn(async (_target: typeof canonical, method: string) => {
      switch (method) {
        case "readHistoryMain": return { head: "main", eventId };
        case "listHistoryAppliedPublications": return [];
        case "ensureHistoryRuntimeContext": return;
        default: throw new Error(`Unexpected history method ${method}`);
      }
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const initialize = vi.fn(async () => {
      await pending;
      await vcs.attachParticipantHistory({ canonical, dispatch: { dispatch } });
    });
    const flight = vcs.startSemanticInitialization(initialize);
    expect(vcs.startSemanticInitialization(initialize)).toBe(flight);
    const first = vcs.ensureRuntimeContext("context:editing");
    const second = vcs.ensureRuntimeContext("context:editing");
    // Capture the prepared content before the refs gain their published event.
    // The mocked protected ref is needed only when the native attachment starts.
    vi.mocked(refs.readMainSemanticState).mockReturnValueOnce(null);
    await expect(vcs.ensureFresh()).resolves.toEqual({ stateHash: initialContentState });
    expect(initialize).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    expect(dispatch).toHaveBeenCalledWith(canonical, "ensureHistoryRuntimeContext", {
      contextId: "context:editing",
    });
  });

  it("cancels a waiting mutation without cancelling the shared initialization or acquiring its lease", async () => {
    const { vcs } = await harness();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const flight = vcs.startSemanticInitialization(() => pending);
    const controller = new AbortController();
    const operation = vi.fn(async () => undefined);
    const mutation = vcs.withProtectedMainMutation(operation, controller.signal);
    const reason = new Error("Caller cancelled editing");
    const cancelled = expect(mutation).rejects.toBe(reason);
    controller.abort(reason);
    await cancelled;
    expect(operation).not.toHaveBeenCalled();
    finish();
    await flight;
    await vcs.withProtectedMainMutation(operation);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("propagates the original initialization failure to pending and later editing requests", async () => {
    const { vcs } = await harness();
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const failure = new Error("Initial snapshot could not be persisted");
    const flight = vcs.startSemanticInitialization(() => pending);
    const request = vcs.ensureRuntimeContext("context:editing");
    const flightFailure = expect(flight).rejects.toBe(failure);
    const requestFailure = expect(request).rejects.toBe(failure);
    fail(failure);
    await Promise.all([flightFailure, requestFailure]);
    await expect(vcs.ensureRuntimeContext("context:later")).rejects.toBe(failure);
    await expect(vcs.withProtectedMainMutation(async () => undefined)).rejects.toBe(failure);
  });

  it("uses one source owner before and after semantic publication", async () => {
    const { deps, refs } = await harness();
    const initialContentState = `state:${"a".repeat(64)}`;
    const vcs = new WorkspaceVcs({ ...deps, initialContentState });
    const view = vi.spyOn(vcs.repositories, "workspaceView");
    await expect(vcs.ensureFresh()).resolves.toEqual({ stateHash: initialContentState });
    expect(view).not.toHaveBeenCalled();
    expect(vcs.executionStateForContent(initialContentState)).toEqual({
      kind: "bootstrap-snapshot",
      snapshotHash: initialContentState,
    });
    const semantic = { kind: "event", eventId: "event:initialized" } as const;
    vi.spyOn(refs, "readMainSemanticState").mockReturnValue(semantic);
    view.mockResolvedValueOnce({ stateHash: initialContentState });
    await expect(vcs.ensureFresh()).resolves.toEqual({ stateHash: initialContentState });
    expect(vcs.executionStateForContent(initialContentState)).toEqual(semantic);
    const changed = `state:${"b".repeat(64)}`;
    view.mockResolvedValueOnce({ stateHash: changed });
    await expect(vcs.ensureFresh()).resolves.toEqual({ stateHash: changed });
    expect(vcs.executionStateForContent(changed)).toEqual(semantic);
  });

  it("verifies participant file coordinates and content against the exact read request", async () => {
    const { blobsDir, vcs } = await harness();
    const nativeInvocation = {
      owner: { runtimeId: "agent", authoritySessionId: "sealed" },
      task: { conversationId: 3, taskId: 1 },
      operation: { kind: "tool" as const, assistantEntryId: 0, callId: "call" },
    };
    const caller = { runtime: { kind: "do" as const, id: "agent" }, nativeInvocation };
    const contextId = "context:test";
    const owner = { ...TEST_PROVIDER, objectKey: `work-${sha256HexSyncText(workspaceParticipantIdentity(caller, contextId))}` };
    const state = { kind: "application" as const, applicationId: "app:test" };
    const repositoryId = "repo";
    const read = { state, files: [
      { repositoryId, file: { kind: "path" as const, path: "value" } },
      { repositoryId, file: { kind: "id" as const, fileId: "absent" } },
    ] };
    const text = "one";
    const stored = await putBytes(blobsDir, Buffer.from(text));
    const file = {
      kind: "read-semantic-blob",
      state,
      repositoryId,
      fileId: "file:test",
      repoPath: "meta",
      path: "value",
      contentHash: stored.digest,
      contentKind: "text",
      byteLength: 3,
      coordinateExtent: 3,
      externalKeys: [],
      authoredChangeId: "change:test",
      authoredByWorkUnitId: "work:test",
      contentClass: "internal",
      mode: 0o644,
    };
    const dispatch = vi.fn().mockResolvedValue([file, null]);
    const perform = () => vcs.readParticipantFiles({
      dispatch: { dispatch }, canonical: TEST_PROVIDER, owner, caller, contextId, ownerContextId: contextId, read,
    });
    await expect(perform()).resolves.toMatchObject([
      { fileId: file.fileId, content: { kind: "text", text } }, null,
    ]);
    expect(dispatch).toHaveBeenLastCalledWith(owner, "readHistoryFiles", { contextId, read });
    dispatch.mockResolvedValueOnce([{ ...file, path: "different" }, null]);
    await expect(perform()).rejects.toThrow("different file selection");
    await fsp.chmod(blobPath(blobsDir, stored.digest), 0o644);
    await fsp.writeFile(blobPath(blobsDir, stored.digest), "two");
    await expect(perform()).rejects.toThrow("does not match its digest");
  });

  it("repairs a participant's current projection when retrying a completed discard", async () => {
    const { vcs } = await harness();
    const nativeInvocation = {
      owner: { runtimeId: "agent", authoritySessionId: "sealed" },
      task: { conversationId: 3, taskId: 1 },
      operation: { kind: "tool" as const, assistantEntryId: 0, callId: "discard" },
    };
    const caller = { runtime: { kind: "do" as const, id: "agent" }, nativeInvocation };
    const contextId = "context:test";
    const owner = { ...TEST_PROVIDER, objectKey: `work-${sha256HexSyncText(workspaceParticipantIdentity(caller, contextId))}` };
    const discard = {
      contextId, commandId: "discard",
      expectedWorkingHead: { kind: "application" as const, applicationId: "original-work" },
    };
    const saved = {
      contextId, workingHead: { kind: "event", eventId: "saved" },
      discardedApplicationIds: ["original-work"],
    };
    const dispatch = vi.fn().mockResolvedValue({ head: "saved-head", discard: saved });
    const projection = vi.spyOn(vcs, "materializeParticipantContext").mockResolvedValue({
      head: "later-head", state: { kind: "application", applicationId: "later-edit" }, folder: "projection",
    });
    const cause = { parent: null };
    await expect(vcs.discardParticipantContext({
      dispatch: { dispatch }, canonical: TEST_PROVIDER, owner, caller, ownerContextId: contextId,
      discard, head: "original-head", cause,
    })).resolves.toEqual(saved);
    expect(dispatch).toHaveBeenCalledWith(owner, "discardHistoryContext", {
      discard, head: "original-head", cause,
    });
    expect(projection).toHaveBeenCalledWith({ dispatch: { dispatch }, owner, contextId });
  });

  it("includes workspace compiler config in partial build projections", async () => {
    const { blobsDir, vcs, deps } = await harness();
    const rootConfig = Buffer.from(
      JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } })
    );
    const packageConfig = Buffer.from(JSON.stringify({ extends: "../../tsconfig.json" }));
    const source = Buffer.from("export const value: string = 'ok';\n");
    const [rootWrite, packageWrite, sourceWrite] = await Promise.all([
      putBytes(blobsDir, rootConfig),
      putBytes(blobsDir, packageConfig),
      putBytes(blobsDir, source),
    ]);
    const state = await mirrorWorktreeTree(blobsDir, [
      { path: "tsconfig.json", contentHash: rootWrite.digest, mode: 0o100644 },
      {
        path: "packages/lib/tsconfig.json",
        contentHash: packageWrite.digest,
        mode: 0o100644,
      },
      { path: "packages/lib/src/index.ts", contentHash: sourceWrite.digest, mode: 0o100644 },
    ]);

    const projection = await vcs.materializeForBuild(
      [{ relativePath: "packages/lib" } as never],
      state.stateHash,
      deps.workspaceRoot
    );

    await expect(fsp.readFile(path.join(projection.sourceRoot, "tsconfig.json"))).resolves.toEqual(
      rootConfig
    );
    await expect(
      fsp.readFile(path.join(projection.sourceRoot, "packages/lib/tsconfig.json"))
    ).resolves.toEqual(packageConfig);
  });

  it("materializes disjoint immutable build trees without a state-wide lock", async () => {
    const { blobsDir, vcs, deps } = await harness();
    const [leftWrite, rightWrite] = await Promise.all([
      putBytes(blobsDir, Buffer.from("export const left = true;\n")),
      putBytes(blobsDir, Buffer.from("export const right = true;\n")),
    ]);
    const state = await mirrorWorktreeTree(blobsDir, [
      {
        path: "packages/left/index.ts",
        contentHash: leftWrite.digest,
        mode: 0o100644,
      },
      {
        path: "packages/right/index.ts",
        contentHash: rightWrite.digest,
        mode: 0o100644,
      },
    ]);
    const instrumented = vcs as unknown as {
      ensureBuildTreeMaterialized(
        stateHash: string,
        relativePath: string,
        treeHash: string,
        destination: string
      ): Promise<void>;
    };
    const materialize = instrumented.ensureBuildTreeMaterialized.bind(vcs);
    let active = 0;
    let maximumActive = 0;
    instrumented.ensureBuildTreeMaterialized = async (...args) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        await materialize(...args);
      } finally {
        active -= 1;
      }
    };

    await Promise.all([
      vcs.materializeForBuild(
        [{ relativePath: "packages/left" } as never],
        state.stateHash,
        deps.workspaceRoot
      ),
      vcs.materializeForBuild(
        [{ relativePath: "packages/right" } as never],
        state.stateHash,
        deps.workspaceRoot
      ),
    ]);

    expect(maximumActive).toBe(2);
  });

  it("repairs missing entries even when an exact build receipt exists", async () => {
    const { blobsDir, vcs, deps } = await harness();
    const [rootWrite, sourceWrite] = await Promise.all([
      putBytes(blobsDir, Buffer.from('{"compilerOptions":{"strict":true}}')),
      putBytes(blobsDir, Buffer.from("export const value = true;\n")),
    ]);
    const state = await mirrorWorktreeTree(blobsDir, [
      { path: "tsconfig.json", contentHash: rootWrite.digest, mode: 0o100644 },
      {
        path: "packages/lib/index.ts",
        contentHash: sourceWrite.digest,
        mode: 0o100644,
      },
    ]);
    const unit = [{ relativePath: "packages/lib" } as never];
    const first = await vcs.materializeForBuild(unit, state.stateHash, deps.workspaceRoot);
    await Promise.all([
      fsp.rm(path.join(first.sourceRoot, "packages/lib"), { recursive: true, force: true }),
      fsp.rm(path.join(first.sourceRoot, "tsconfig.json"), { force: true }),
    ]);

    const repaired = await vcs.materializeForBuild(unit, state.stateHash, deps.workspaceRoot);

    await expect(
      fsp.readFile(path.join(repaired.sourceRoot, "packages/lib/index.ts"))
    ).resolves.toEqual(Buffer.from("export const value = true;\n"));
    await expect(fsp.readFile(path.join(repaired.sourceRoot, "tsconfig.json"))).resolves.toEqual(
      Buffer.from('{"compilerOptions":{"strict":true}}')
    );
  });

  it("reads channel provenance through the GAD log API, outside semantic VCS dispatch", async () => {
    const { vcs } = await harness();
    const call = vi.fn(async () => ({
      envelopeId: "message:one",
      channelId: "channel:one",
      seq: 1,
      from: { kind: "user", id: "user:one" },
      payload: null,
      contentClass: "external" as const,
      externalKeys: [],
      publishedAt: "2026-07-16T12:00:00.000Z",
    }));
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
    const { blobsDir, vcs, attachGcHistory } = await harness();
    const cached = await putBytes(blobsDir, Buffer.from("cached-composed-view"));
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    await attachGcHistory();
    vi.spyOn(vcs.repositories, "collectCachedReachableDigests").mockReturnValue({
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

  it("preserves content when a retained participant cannot report its roots", async () => {
    const { blobsDir, vcs, attachGcHistory } = await harness();
    const bytes = Buffer.from("retained by offline participant");
    const retained = await putBytes(blobsDir, bytes);
    const participant = `work-${"a".repeat(64)}`;
    const failure = new Error("Retained participant could not be reached");
    let offline = false;
    await attachGcHistory((owner) => {
      if (owner.objectKey !== participant) return [];
      if (offline) throw failure;
      return [retained.digest];
    }, [participant]);
    const prepared = await vcs.prepareGc({ minAgeMs: 0, epoch: 1, executionSourceRoots: [] });
    offline = true;
    await expect(prepared.commit()).rejects.toBe(failure);
    await expect(getBytes(blobsDir, retained.digest)).resolves.toEqual(bytes);
  });

  it("keeps a retained execution source composition rooted during content GC", async () => {
    const { blobsDir, vcs, attachGcHistory } = await harness();
    const retained = await putBytes(blobsDir, Buffer.from("retained build source"));
    const source = await putTree(
      blobsDir,
      [{ name: "index.ts", kind: "file", contentHash: retained.digest, mode: 0o100644 }],
      { root: true }
    );
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    await attachGcHistory();

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
    const { blobsDir, vcs, attachGcHistory } = await harness();
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    await attachGcHistory();

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

  it("keeps private participant content across the destructive GC boundary", async () => {
    const { blobsDir, vcs, refs } = await harness();
    vi.spyOn(refs, "readMainSemanticState").mockReturnValue({ kind: "event", eventId: "main-event" });
    const before = await putBytes(blobsDir, Buffer.from("private before preparation"));
    const archived = await putBytes(blobsDir, Buffer.from("saved during retirement"));
    const recent = await putBytes(blobsDir, Buffer.from("private after preparation"));
    const discarded = await putBytes(blobsDir, Buffer.from("unreferenced"));
    const canonical = { ...TEST_PROVIDER, objectKey: "canonical" };
    const retiring = `work-${"a".repeat(64)}`;
    const active = `work-${"b".repeat(64)}`;
    let publicationPhase = false;
    let retired = false;
    const dispatch = vi.fn(async (owner: typeof TEST_PROVIDER, method: string) => {
      if (method === "readHistoryMain") return { head: "main-head", eventId: "main-event" };
      if (method === "listHistoryAppliedPublications") return [];
      if (method === "listHistoryRetainedParticipants") return retired ? [active] : [retiring, active];
      if (method !== "readHistoryContentRoots") throw new Error(`Unexpected history call ${method}`);
      if (owner.objectKey === canonical.objectKey) return retired ? [archived.digest] : [];
      if (owner.objectKey === retiring) {
        if (publicationPhase) {
          retired = true;
          throw new Error("Participant retired while collecting its roots");
        }
        return [before.digest];
      }
      if (owner.objectKey === active) return publicationPhase ? [recent.digest] : [];
      throw new Error("Unexpected participant");
    });
    await vcs.attachParticipantHistory({ dispatch: { dispatch }, canonical });
    const epoch = await vcs.prepareGc({ minAgeMs: 0, epoch: 1, executionSourceRoots: [] });
    publicationPhase = true;
    await expect(epoch.commit()).resolves.toMatchObject({ swept: 1 });
    for (const item of [before, archived, recent]) {
      await expect(getBytes(blobsDir, item.digest)).resolves.toBeInstanceOf(Buffer);
    }
    await expect(getBytes(blobsDir, discarded.digest)).resolves.toBeNull();
  });

  it("proves protected main, execution, and cached roots in one graph before GC", async () => {
    const { blobsDir, vcs, refs, attachGcHistory } = await harness();
    const sharedContent = await putBytes(blobsDir, Buffer.from("shared subtree content"));
    const sharedTree = await putTree(blobsDir, [
      { name: "shared.txt", kind: "file", contentHash: sharedContent.digest, mode: 0o100644 },
    ]);
    const protectedRoot = await putTree(
      blobsDir,
      [{ name: "shared", kind: "dir", childHash: sharedTree.treeHash }],
      { root: true }
    );
    const executionOnly = await putBytes(blobsDir, Buffer.from("execution-only content"));
    const executionRoot = await putTree(
      blobsDir,
      [
        { name: "shared", kind: "dir", childHash: sharedTree.treeHash },
        {
          name: "execution-only.txt",
          kind: "file",
          contentHash: executionOnly.digest,
          mode: 0o100644,
        },
      ],
      { root: true }
    );
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    const cachedView = await vcs.repositories.contentView([
      { repoPath: "packages/cached", stateHash: protectedRoot.stateHash! },
    ]);
    await attachGcHistory();
    vi.spyOn(refs, "listMains").mockReturnValue([
      { repoPath: "packages/published", contentRoot: protectedRoot.stateHash!, updatedAt: 1 },
    ]);

    const collect = vi.spyOn(blobstoreService, "collectTreeReachableDigestsBatch");
    await expect(
      vcs.runGc({
        minAgeMs: 0,
        epoch: 1,
        executionSourceRoots: [
          { repoPath: "panels/execution", stateHash: executionRoot.stateHash! },
        ],
      })
    ).resolves.toMatchObject({ swept: 1 });

    expect(collect).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledWith(
      blobsDir,
      expect.arrayContaining([
        protectedRoot.stateHash,
        executionRoot.stateHash,
        cachedView.stateHash,
      ]),
      { verifyContent: true }
    );
    await expect(getBytes(blobsDir, sharedContent.digest)).resolves.toEqual(
      Buffer.from("shared subtree content")
    );
    await expect(getBytes(blobsDir, unreachable.digest)).resolves.toBeNull();
    await expect(getBytes(blobsDir, executionOnly.digest)).resolves.toEqual(
      Buffer.from("execution-only content")
    );
  });

  it("evicts a missing cached composition during the shared GC proof", async () => {
    const { blobsDir, vcs, attachGcHistory } = await harness();
    const content = await putBytes(blobsDir, Buffer.from("cached source"));
    const source = await putTree(
      blobsDir,
      [{ name: "index.ts", kind: "file", contentHash: content.digest, mode: 0o100644 }],
      { root: true }
    );
    await vcs.repositories.contentView([
      { repoPath: "packages/cached", stateHash: source.stateHash! },
    ]);
    const cachedRoots = vcs.repositories.cachedViewRoots();
    expect(cachedRoots).toHaveLength(1);
    await fsp.unlink(blobPath(blobsDir, cachedRoots[0]!.stateHash.slice("state:".length)));
    await attachGcHistory();

    await expect(
      vcs.prepareGc({ minAgeMs: 0, epoch: 1, executionSourceRoots: [] })
    ).resolves.toBeDefined();
    expect(vcs.repositories.cachedViewRoots()).toEqual([]);
  });

  it("keeps cache views admitted after the GC root snapshot out of that batch", async () => {
    const { blobsDir, vcs, attachGcHistory } = await harness();
    const initialContent = await putBytes(blobsDir, Buffer.from("initial cached source"));
    const initialSource = await putTree(
      blobsDir,
      [{ name: "index.ts", kind: "file", contentHash: initialContent.digest, mode: 0o100644 }],
      { root: true }
    );
    await vcs.repositories.contentView([
      { repoPath: "packages/cached", stateHash: initialSource.stateHash! },
    ]);
    const initialCachedRoots = vcs.repositories.cachedViewRoots();
    await attachGcHistory();

    let started!: () => void;
    const batchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resume!: () => void;
    const batchGate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const collectBatch = blobstoreService.collectTreeReachableDigestsBatch;
    vi.spyOn(blobstoreService, "collectTreeReachableDigestsBatch").mockImplementation(
      async (...args) => {
        started();
        await batchGate;
        return collectBatch(...args);
      }
    );

    const prepared = vcs.prepareGc({ minAgeMs: 0, epoch: 1, executionSourceRoots: [] });
    await batchStarted;
    const laterContent = await putBytes(blobsDir, Buffer.from("later cached source"));
    const laterSource = await putTree(
      blobsDir,
      [{ name: "index.ts", kind: "file", contentHash: laterContent.digest, mode: 0o100644 }],
      { root: true }
    );
    await vcs.repositories.contentView([
      { repoPath: "packages/later", stateHash: laterSource.stateHash! },
    ]);
    resume();

    await expect(prepared).resolves.toBeDefined();
    expect(vcs.repositories.cachedViewRoots()).toEqual(
      expect.arrayContaining([
        ...initialCachedRoots,
        expect.objectContaining({ stateHash: expect.any(String) }),
      ])
    );
  });

  it("serializes a cache-miss composition with the final GC proof and sweep", async () => {
    const { blobsDir, refs, vcs, attachGcHistory } = await harness();
    const sourceContent = await putBytes(blobsDir, Buffer.from("source for composed view"));
    const source = await putTree(
      blobsDir,
      [{ name: "index.ts", kind: "file", contentHash: sourceContent.digest, mode: 0o100644 }],
      { root: true }
    );
    await attachGcHistory();
    vi.spyOn(refs, "listMains").mockReturnValue([
      { repoPath: "packages/published", contentRoot: source.stateHash!, updatedAt: 1 },
    ]);
    const repositories = [{ repoPath: "packages/old-scaffold", stateHash: source.stateHash! }];
    const otherCache = new WorkspaceRepositories({
      blobsDir,
      refs,
      contentProjection: vcs.contentProjection,
      discoverGraph: async () => {
        throw new Error("graph discovery is not used by contentView");
      },
    });
    const originalView = await otherCache.contentView(repositories);

    const prepared = await vcs.prepareGc({ minAgeMs: 0, epoch: 1, executionSourceRoots: [] });
    let batchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      batchStarted = resolve;
    });
    let resumeBatch!: () => void;
    const batchGate = new Promise<void>((resolve) => {
      resumeBatch = resolve;
    });
    const collectBatch = blobstoreService.collectTreeReachableDigestsBatch;
    vi.spyOn(blobstoreService, "collectTreeReachableDigestsBatch").mockImplementation(
      async (...args) => {
        batchStarted();
        await batchGate;
        return collectBatch(...args);
      }
    );

    const gc = prepared.commit();
    await started;
    let compositionSettled = false;
    const composition = vcs.repositories.contentView(repositories).then((view) => {
      compositionSettled = true;
      return view;
    });
    await Promise.resolve();
    expect(compositionSettled).toBe(false);

    resumeBatch();
    await gc;
    const rebuiltView = await composition;
    expect(rebuiltView.stateHash).toBe(originalView.stateHash);
    await expect(
      blobstoreService.collectTreeReachableDigestsBatch(blobsDir, [rebuiltView.stateHash], {
        verifyContent: true,
      })
    ).resolves.toMatchObject([{ status: "fulfilled", value: expect.any(Object) }]);
    await expect(getBytes(blobsDir, sourceContent.digest)).resolves.toEqual(
      Buffer.from("source for composed view")
    );
  });

  it("joins every invalid strict GC root before refusing the sweep", async () => {
    const { blobsDir, vcs, attachGcHistory } = await harness();
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    const missingA = `state:${"a".repeat(64)}`;
    const missingB = `state:${"b".repeat(64)}`;
    await attachGcHistory();

    const failure = await vcs.runGc({
      minAgeMs: 0,
      epoch: 1,
      executionSourceRoots: [{ stateHash: missingA, repoPath: null }, { stateHash: missingB, repoPath: null }],
    }).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(String(failure)).toContain(missingA);
    expect(String(failure)).toContain(missingB);
    await expect(getBytes(blobsDir, unreachable.digest)).resolves.toEqual(
      Buffer.from("unreachable")
    );
  });

  it("fails closed before sweeping when an execution source closure is corrupt", async () => {
    const { blobsDir, vcs, attachGcHistory } = await harness();
    const retained = await putBytes(blobsDir, Buffer.from("retained build source"));
    const source = await putTree(
      blobsDir,
      [{ name: "index.ts", kind: "file", contentHash: retained.digest, mode: 0o100644 }],
      { root: true }
    );
    const unreachable = await putBytes(blobsDir, Buffer.from("unreachable"));
    await fsp.unlink(blobPath(blobsDir, retained.digest));
    await attachGcHistory();

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

  it("protects prepared native content until its participant mutation commits", async () => {
    const { blobsDir, vcs, attachGcHistory } = await harness();
    const bytes = Buffer.from("content awaiting participant commit");
    const contentHash = sha256Hex(bytes);
    const owner = { ...TEST_PROVIDER, objectKey: `work-${"b".repeat(64)}` };
    const edit = editInput();
    const cause = { parent: null };
    const { workingHead: _prior, ...result } = mutationResult(edit);
    let committed = false;
    let applicationStarted!: () => void;
    let finishApplication!: () => void;
    const started = new Promise<void>((resolve) => { applicationStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishApplication = resolve; });
    const dispatch = vi.fn(async (_owner: typeof owner, method: string) => {
      if (method === "planHistoryEdit") {
        return {
          kind: "planned",
          command: { commandId: edit.commandId, method: "edit", requestDigest: "request", cause },
          application: {},
          blobs: [{ contentHash, base64: bytes.toString("base64") }],
          result,
        };
      }
      if (method === "applyHistoryApplication") {
        applicationStarted();
        await finish;
        committed = true;
        return { head: "working", value: { kind: "application", applicationId: result.applicationId } };
      }
      throw new Error(`Unexpected participant call ${method}`);
    });
    await attachGcHistory((reader) => reader.objectKey === owner.objectKey && committed
      ? [contentHash]
      : [], [owner.objectKey]);
    const gc = await vcs.prepareGc({ minAgeMs: 0, epoch: 1, executionSourceRoots: [] });
    const mutation = editWorkspaceParticipant({ dispatch: { dispatch }, owner, head: "head", edit, cause, blobsDir });
    await started;
    const sweep = gc.commit();
    finishApplication();
    await Promise.all([mutation, sweep]);
    expect(await getBytes(blobsDir, contentHash)).toEqual(bytes);
  });


});
