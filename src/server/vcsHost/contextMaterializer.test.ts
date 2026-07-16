import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sha256HexSyncText } from "@vibestudio/content-addressing";
import {
  CONTEXT_BINDING_FILE,
  CONTEXT_BINDING_PROTOCOL,
  parseContextBinding,
} from "@vibestudio/shared/contextBinding";
import { contextMaterializationCommand } from "@vibestudio/shared/vcs/workspaceProjection";
import { ContentProjectionStore } from "./contentProjectionStore.js";
import { ContextMaterializer } from "./contextMaterializer.js";
import { DiskProjector } from "./diskProjector.js";

describe("ContextMaterializer binding protocol", () => {
  let root: string;
  let materializer: ContextMaterializer;
  let contexts: string;
  let blobsDir: string;
  let disk: DiskProjector;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "context-materializer-"));
    blobsDir = path.join(root, "blobs");
    contexts = path.join(root, "contexts");
    disk = new DiskProjector({
      contentProjection: new ContentProjectionStore({ blobsDir }),
      workspaceRoot: path.join(root, "source"),
      contextProjectionsRoot: contexts,
    });
    materializer = new ContextMaterializer({
      blobsDir,
      workspaceId: "workspace-1",
      disk,
    });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("keeps the public binding identity-only and the receipt private", async () => {
    const text = "export const answer = 42;\n";
    const contentHash = sha256HexSyncText(text);
    const command = contextMaterializationCommand({
      contextId: "context-1",
      commandId: "command-1",
      mode: "initialize",
      previousState: null,
      targetState: { kind: "event", eventId: "event-1" },
      repositories: [
        {
          repositoryId: "repository-1",
          repoPath: "projects/default",
          presence: "present",
          fileManifestId: "manifest-1",
          source: {
            kind: "snapshot",
            files: [{ path: "src/index.ts", contentHash, mode: 0o644 }],
          },
        },
      ],
      blobs: [{ contentHash, base64: Buffer.from(text).toString("base64") }],
    });

    const receipt = await materializer.materialize(command);
    const contextDir = path.join(contexts, "context-1");
    const publicValue = JSON.parse(
      await fsp.readFile(path.join(contextDir, CONTEXT_BINDING_FILE), "utf8")
    );
    expect(parseContextBinding(publicValue)).toEqual({
      protocol: CONTEXT_BINDING_PROTOCOL,
      workspaceId: "workspace-1",
      contextId: "context-1",
    });
    expect(publicValue).not.toHaveProperty("serverUrl");
    expect(publicValue).not.toHaveProperty("effectId");
    expect(publicValue).not.toHaveProperty("repositories");

    const privateValue = JSON.parse(
      await fsp.readFile(path.join(contextDir, ".gad", "context-materialization.json"), "utf8")
    );
    expect(privateValue).toMatchObject({
      protocol: "vibestudio.context-materialization-state.v4",
      materializationId: receipt.materializationId,
      targetState: receipt.targetState,
      repositories: receipt.repositories,
    });
    expect(receipt).not.toHaveProperty("generation");
    expect(receipt).not.toHaveProperty("workspaceFactRootId");
    expect(privateValue).not.toHaveProperty("generation");
    expect(privateValue).not.toHaveProperty("workspaceFactRootId");
    await expect(
      materializer.materialize({ ...command, generation: "legacy" } as never)
    ).rejects.toThrow(/not canonical or has an invalid identity/u);
    if (process.platform !== "win32") {
      expect((await fsp.stat(path.join(contextDir, CONTEXT_BINDING_FILE))).mode & 0o777).toBe(
        0o644
      );
      expect(
        (await fsp.stat(path.join(contextDir, ".gad", "context-materialization.json"))).mode & 0o777
      ).toBe(0o600);
    }
    expect(await materializer.materializationState("context-1")).toEqual(privateValue);
  });

  it("serializes deletion after an active materialization", async () => {
    const firstText = "first\n";
    const firstHash = sha256HexSyncText(firstText);
    const first = contextMaterializationCommand({
      contextId: "context-1",
      commandId: "command-1",
      mode: "initialize",
      previousState: null,
      targetState: { kind: "event", eventId: "event-1" },
      repositories: [
        {
          repositoryId: "repository-1",
          repoPath: "projects/default",
          presence: "present",
          fileManifestId: "manifest-1",
          source: {
            kind: "snapshot",
            files: [{ path: "value.txt", contentHash: firstHash, mode: 0o644 }],
          },
        },
      ],
      blobs: [{ contentHash: firstHash, base64: Buffer.from(firstText).toString("base64") }],
    });
    await materializer.materialize(first);

    const secondText = "second\n";
    const secondHash = sha256HexSyncText(secondText);
    const second = contextMaterializationCommand({
      contextId: "context-1",
      commandId: "command-2",
      mode: "replace",
      previousState: first.targetState,
      targetState: { kind: "event", eventId: "event-2" },
      repositories: [
        {
          repositoryId: "repository-1",
          repoPath: "projects/default",
          presence: "present",
          fileManifestId: "manifest-2",
          source: {
            kind: "snapshot",
            files: [{ path: "value.txt", contentHash: secondHash, mode: 0o644 }],
          },
        },
      ],
      blobs: [{ contentHash: secondHash, base64: Buffer.from(secondText).toString("base64") }],
    });

    const project = disk.projectContextRepository.bind(disk);
    let enterProjection!: () => void;
    let releaseProjection!: () => void;
    const projectionEntered = new Promise<void>((resolve) => {
      enterProjection = resolve;
    });
    const projectionReleased = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    vi.spyOn(disk, "projectContextRepository").mockImplementation(async (input) => {
      enterProjection();
      await projectionReleased;
      return project(input);
    });

    const materializing = materializer.materialize(second);
    await projectionEntered;
    let deletionFinished = false;
    const deleting = materializer.drop("context-1").then(() => {
      deletionFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deletionFinished).toBe(false);

    releaseProjection();
    await Promise.all([materializing, deleting]);
    await expect(materializer.materializationState("context-1")).resolves.toBeNull();
    await expect(fsp.stat(path.join(contexts, "context-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses private state after restart to verify the basis and remove retired repos", async () => {
    const text = "old\n";
    const contentHash = sha256HexSyncText(text);
    const first = contextMaterializationCommand({
      contextId: "context-1",
      commandId: "command-1",
      mode: "initialize",
      previousState: null,
      targetState: { kind: "event", eventId: "event-1" },
      repositories: [
        {
          repositoryId: "repository-1",
          repoPath: "projects/old",
          presence: "present",
          fileManifestId: "manifest-1",
          source: {
            kind: "snapshot",
            files: [{ path: "old.txt", contentHash, mode: 0o644 }],
          },
        },
      ],
      blobs: [{ contentHash, base64: Buffer.from(text).toString("base64") }],
    });
    await materializer.materialize(first);

    materializer = new ContextMaterializer({ blobsDir, workspaceId: "workspace-1", disk });
    const second = contextMaterializationCommand({
      contextId: "context-1",
      commandId: "command-2",
      mode: "patch",
      previousState: { kind: "event", eventId: "event-1" },
      targetState: { kind: "event", eventId: "event-2" },
      repositories: [
        {
          repositoryId: "repository-1",
          repoPath: "projects/old",
          presence: "deleted",
        },
      ],
      blobs: [],
    });
    await materializer.materialize(second);

    await expect(
      fsp.stat(path.join(contexts, "context-1", "projects", "old"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await materializer.materializationState("context-1")).toMatchObject({
      targetState: { kind: "event", eventId: "event-2" },
      repositories: [],
    });
  });

  it("applies a basis-bound repository patch without walking or dropping untouched repositories", async () => {
    const oldA = "old-a\n";
    const newA = "new-a\n";
    const stableB = "stable-b\n";
    const oldAHash = sha256HexSyncText(oldA);
    const newAHash = sha256HexSyncText(newA);
    const stableBHash = sha256HexSyncText(stableB);
    const first = contextMaterializationCommand({
      contextId: "context-1",
      commandId: "command-1",
      mode: "initialize",
      previousState: null,
      targetState: { kind: "event", eventId: "event-1" },
      repositories: [
        {
          repositoryId: "repository-a",
          repoPath: "projects/a",
          presence: "present",
          fileManifestId: "manifest-a-1",
          source: {
            kind: "snapshot",
            files: [{ path: "value.txt", contentHash: oldAHash, mode: 0o644 }],
          },
        },
        {
          repositoryId: "repository-b",
          repoPath: "projects/b",
          presence: "present",
          fileManifestId: "manifest-b-1",
          source: {
            kind: "snapshot",
            files: [{ path: "value.txt", contentHash: stableBHash, mode: 0o644 }],
          },
        },
      ],
      blobs: [
        { contentHash: oldAHash, base64: Buffer.from(oldA).toString("base64") },
        { contentHash: stableBHash, base64: Buffer.from(stableB).toString("base64") },
      ],
    });
    const firstReceipt = await materializer.materialize(first);
    const basisA = firstReceipt.repositories.find(
      (repository) => repository.repositoryId === "repository-a"
    )!;
    const second = contextMaterializationCommand({
      contextId: "context-1",
      commandId: "command-2",
      mode: "patch",
      previousState: { kind: "event", eventId: "event-1" },
      targetState: { kind: "application", applicationId: "application-2" },
      repositories: [
        {
          repositoryId: "repository-a",
          repoPath: "projects/a",
          presence: "present",
          fileManifestId: "manifest-a-2",
          source: {
            kind: "delta",
            basisContentRoot: basisA.contentRoot,
            changes: [
              {
                path: "value.txt",
                expected: { contentHash: oldAHash, mode: 0o644 },
                result: { contentHash: newAHash, mode: 0o644 },
              },
            ],
          },
        },
      ],
      blobs: [{ contentHash: newAHash, base64: Buffer.from(newA).toString("base64") }],
    });

    const receipt = await materializer.materialize(second);
    expect(receipt.repositories.map((repository) => repository.repositoryId)).toEqual([
      "repository-a",
    ]);
    expect(
      (await materializer.materializationState("context-1"))?.repositories.map(
        (repository) => repository.repositoryId
      )
    ).toEqual(["repository-a", "repository-b"]);
    await expect(
      fsp.readFile(path.join(contexts, "context-1", "projects", "a", "value.txt"), "utf8")
    ).resolves.toBe(newA);
    await expect(
      fsp.readFile(path.join(contexts, "context-1", "projects", "b", "value.txt"), "utf8")
    ).resolves.toBe(stableB);
    await fsp.writeFile(
      path.join(contexts, "context-1", "projects", "a", "value.txt"),
      "tampered with same projection metadata"
    );
    await fsp.writeFile(
      path.join(contexts, "context-1", "projects", "b", "value.txt"),
      "tampered untouched repository"
    );
    await fsp.writeFile(path.join(contexts, "context-1", "projects", "a", "untracked.txt"), "x");
    await expect(materializer.materialize(second)).resolves.toEqual(receipt);
    await expect(
      fsp.readFile(path.join(contexts, "context-1", "projects", "a", "value.txt"), "utf8")
    ).resolves.toBe(newA);
    await expect(
      fsp.readFile(path.join(contexts, "context-1", "projects", "b", "value.txt"), "utf8")
    ).resolves.toBe(stableB);
    await expect(
      fsp.stat(path.join(contexts, "context-1", "projects", "a", "untracked.txt"))
    ).rejects.toMatchObject({ code: "ENOENT" });

    const wrongBasis = contextMaterializationCommand({
      ...second,
      commandId: "command-3",
      previousState: { kind: "event", eventId: "wrong-event" },
      targetState: { kind: "event", eventId: "event-3" },
    });
    await expect(materializer.materialize(wrongBasis)).rejects.toThrow(
      /materialization basis changed/u
    );

    await expect(materializer.materialize(first)).rejects.toThrow(
      /materialization basis changed: expected absence/u
    );

    const stableBRoot = firstReceipt.repositories.find(
      (repository) => repository.repositoryId === "repository-b"
    )!;
    const repair = contextMaterializationCommand({
      contextId: "context-1",
      commandId: "command-repair",
      mode: "replace",
      previousState: second.targetState,
      targetState: second.targetState,
      repositories: [
        {
          repositoryId: "repository-a",
          repoPath: "projects/a",
          presence: "present",
          fileManifestId: "manifest-a-2",
          source: { kind: "content-root", contentRoot: receipt.repositories[0]!.contentRoot },
        },
        {
          repositoryId: "repository-b",
          repoPath: "projects/b",
          presence: "present",
          fileManifestId: "manifest-b-1",
          source: { kind: "content-root", contentRoot: stableBRoot.contentRoot },
        },
      ],
      blobs: [],
    });
    await expect(materializer.materialize(repair)).resolves.toMatchObject({
      targetState: second.targetState,
    });

    const advanced = contextMaterializationCommand({
      contextId: "context-1",
      commandId: "command-advanced",
      mode: "patch",
      previousState: second.targetState,
      targetState: { kind: "event", eventId: "event-3" },
      repositories: [],
      blobs: [],
    });
    await materializer.materialize(advanced);
    await expect(materializer.materialize(repair)).rejects.toThrow(
      /materialization basis changed/u
    );
  });

  it("defends the shared path boundary while allowing project-owned output", async () => {
    const text = "built\n";
    const contentHash = sha256HexSyncText(text);
    const commandFor = (commandId: string, filePath: string) =>
      contextMaterializationCommand({
        contextId: "context-1",
        commandId,
        mode: "initialize",
        previousState: null,
        targetState: { kind: "event", eventId: `event-${commandId}` },
        repositories: [
          {
            repositoryId: "repository-1",
            repoPath: "projects/default",
            presence: "present",
            fileManifestId: `manifest-${commandId}`,
            source: {
              kind: "snapshot",
              files: [{ path: filePath, contentHash, mode: 0o644 }],
            },
          },
        ],
        blobs: [{ contentHash, base64: Buffer.from(text).toString("base64") }],
      });

    await expect(materializer.materialize(commandFor("reserved", ".git/config"))).rejects.toThrow(
      /platform-reserved directory/u
    );
    await materializer.materialize(commandFor("ordinary-output", "dist/index.js"));
    await expect(
      fsp.readFile(
        path.join(contexts, "context-1", "projects", "default", "dist", "index.js"),
        "utf8"
      )
    ).resolves.toBe(text);
  });
});
