import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceDispatcher, createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { ContextFolderManager } from "@vibestudio/shared/contextFolderManager";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { ResourceScope } from "@vibestudio/rpc";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { authorizeVerifiedCaller } from "./authorityRuntime.js";
import { FsService } from "./fsService.js";
import { FsDisk } from "./fsDisk.js";
import { createFsServiceDefinition } from "./fsServiceDef.js";

describe("connected website file consent", () => {
  let root: string;
  let grants: CapabilityGrantStore;
  let files: FsService;
  let disk: FsDisk;
  let dispatcher: ServiceDispatcher;
  let caller: ReturnType<typeof websiteCaller>;
  let requested: Array<{
    resource: ResourceScope;
    snapshot: { capability: string };
    presentation?: { title: string };
  }>;

  function websiteCaller() {
    const subject = grants.ensureWebsiteSubject({
      userId: "user:usr_alice",
      workspaceId: "ws",
      origin: "https://example.com",
    });
    const website = {
      subject: subject.subject,
      userId: subject.userId,
      workspaceId: subject.workspaceId,
      origin: subject.identityKey,
      connected: true,
      binding: { subject: subject.subject, generation: subject.generation, documentId: "page" },
    };
    grants.registerSubjectExecution(website.binding);
    return {
      ...createVerifiedCaller("panel:site", "panel", null, null, {
        userId: "usr_alice",
        handle: "alice",
      }),
      workspaceId: "ws",
      website,
    };
  }
  function allow(capability: string, resource: ResourceScope) {
    grants.issue({
      subject: caller.website.subject,
      capability,
      resource,
      effect: "allow",
      issuedBy: "user:usr_alice",
      provenance: "acquisition",
      constraints: {
        subjectGeneration: caller.website.binding.generation,
        sourceWorkspaceId: "ws",
      },
    });
  }
  const call = (method: string, args: unknown[]) =>
    dispatcher.dispatch({ caller }, "fs", method, args);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "website-files-"));
    grants = new CapabilityGrantStore({ statePath: join(root, "authority") });
    const scratch = join(root, "scratch");
    mkdirSync(join(scratch, ".tmp", "one"), { recursive: true });
    mkdirSync(join(scratch, ".tmp", "other"), { recursive: true });
    writeFileSync(join(scratch, ".tmp", "one", "a.txt"), "one");
    writeFileSync(join(scratch, ".tmp", "one", "b.txt"), "two");
    writeFileSync(join(scratch, ".tmp", "other", "private.txt"), "private");
    disk = new FsDisk("unused");
    files = new FsService(
      {
        ensureContextFolder: async () => scratch,
        ensureContextScratch: async () => scratch,
      } as unknown as ContextFolderManager,
      { resolveContext: () => "context", resolveActive: () => null } as unknown as EntityCache,
      { disk, contextAuthority: { kind: "scratch-only" } }
    );
    caller = websiteCaller();
    requested = [];
    dispatcher = new ServiceDispatcher();
    dispatcher.setAuthorityResolver(({ caller, capability, resourceKey, tier }) =>
      authorizeVerifiedCaller(caller, {
        workspaceId: "ws",
        workspaceMember: true,
        sessionId: "session",
        audience: "files",
        capability,
        resourceKey,
        tier,
        grantStore: grants,
      })
    );
    const request: NonNullable<
      Parameters<ServiceDispatcher["setAuthorityAcquirer"]>[0]
    >["request"] = (input) => {
      requested.push(input);
      return {
        acquisitionId: "acq:files",
        ownerRuntimeId: caller.runtime.id,
        snapshotDigest: input.snapshotDigest,
        capability: input.snapshot.capability,
        resourceKey: input.snapshot.resourceKey,
        tier: input.tier,
        cardType: "permission.gated",
        renderedAction: input.renderedAction,
        pending: true,
      };
    };
    dispatcher.setAuthorityAcquirer({
      request,
      acquire: async (input) => ({ state: "closed", info: request(input) }),
      consume: vi.fn(),
      invalidate: vi.fn(),
    });
    dispatcher.registerService(createFsServiceDefinition(() => files));
    dispatcher.markInitialized();
  });
  afterEach(async () => {
    await files.stop();
    await disk.stop();
    grants.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("asks separately for the workspace structure and file contents", async () => {
    await expect(call("readdir", ["/"])).rejects.toMatchObject({ code: "EACQUIRE" });
    expect(requested.at(-1)).toMatchObject({
      resource: { kind: "prefix", prefix: "workspace-path/" },
      snapshot: { capability: "filesystem.list" },
      presentation: { title: "Show this website the workspace structure?" },
    });
    allow("filesystem.list", requested.at(-1)!.resource);
    await expect(call("readdir", [".tmp/one"])).resolves.toEqual(["a.txt", "b.txt"]);
    await expect(call("readFile", [".tmp/one/a.txt", "utf8"])).rejects.toMatchObject({
      code: "EACQUIRE",
    });
    expect(requested.at(-1)).toMatchObject({
      resource: { kind: "exact", key: "workspace-path/.tmp/one/a.txt" },
      snapshot: { capability: "filesystem.read" },
    });
  });
  it("reuses file consent only for that file, never writes or siblings", async () => {
    allow("filesystem.read", { kind: "exact", key: "workspace-path/.tmp/one/a.txt" });
    await expect(call("readFile", [".tmp/one/../one/a.txt", "utf8"])).resolves.toBe("one");
    await expect(call("readFile", [".tmp/one/b.txt", "utf8"])).rejects.toMatchObject({
      code: "EACQUIRE",
    });
    await expect(call("writeFile", [".tmp/one/a.txt", "changed"])).rejects.toMatchObject({
      code: "EACQUIRE",
    });
  });
  it("reuses a folder grant for descendants but not similarly named folders or recursive parents", async () => {
    allow("filesystem.read", { kind: "prefix", prefix: "workspace-path/.tmp/one/" });
    await expect(call("readFile", [".tmp/one/a.txt", "utf8"])).resolves.toBe("one");
    await expect(call("readFile", [".tmp/one/b.txt", "utf8"])).resolves.toBe("two");
    await expect(call("readFile", [".tmp/other/private.txt", "utf8"])).rejects.toMatchObject({
      code: "EACQUIRE",
    });
    allow("filesystem.list", { kind: "exact", key: "workspace-path/.tmp/one/" });
    await expect(call("readdir", [".tmp/one", { recursive: true }])).rejects.toMatchObject({
      code: "EACQUIRE",
    });
  });
  it("keeps old workspace-wide grants from becoming new file consent", async () => {
    allow("filesystem.read", { kind: "exact", key: "workspace-files" });
    await expect(call("readFile", [".tmp/one/a.txt", "utf8"])).rejects.toMatchObject({
      code: "EACQUIRE",
    });
  });
  it("checks copy source and destination independently", async () => {
    allow("filesystem.write", { kind: "prefix", prefix: "workspace-path/.tmp/one/" });
    await expect(
      call("copyFile", [".tmp/other/private.txt", ".tmp/one/copied.txt"])
    ).rejects.toMatchObject({ code: "EACQUIRE" });
    expect(requested.at(-1)?.snapshot.capability).toBe("filesystem.read");
    allow("filesystem.read", requested.at(-1)!.resource);
    await expect(
      call("copyFile", [".tmp/other/private.txt", ".tmp/one/copied.txt"])
    ).resolves.toBeUndefined();
    await expect(
      call("rename", [".tmp/one/copied.txt", ".tmp/other/copied.txt"])
    ).rejects.toMatchObject({ code: "EACQUIRE" });
    expect(requested.at(-1)?.resource).toEqual({
      kind: "exact",
      key: "workspace-path/.tmp/other/copied.txt",
    });
  });
  it("binds open handles and symbolic links to their actual approved file", async () => {
    symlinkSync("../other/private.txt", join(root, "scratch", ".tmp", "one", "link.txt"));
    allow("filesystem.read", { kind: "prefix", prefix: "workspace-path/.tmp/one/" });
    await expect(call("readFile", [".tmp/one/link.txt", "utf8"])).rejects.toMatchObject({
      code: "EACQUIRE",
    });
    expect(requested.at(-1)?.resource).toEqual({
      kind: "exact",
      key: "workspace-path/.tmp/other/private.txt",
    });
    const handle = (await call("open", [".tmp/one/a.txt"])) as { handleId: number };
    await expect(call("handleRead", [handle.handleId, 3, 0])).resolves.toMatchObject({
      bytesRead: 3,
    });
    await expect(call("handleWrite", [handle.handleId, "x", 0])).rejects.toMatchObject({
      code: "EACQUIRE",
    });
    await expect(call("handleClose", [handle.handleId])).resolves.toBeUndefined();
  });
  it("requires both read and write consent for a read-write open", async () => {
    allow("filesystem.read", { kind: "exact", key: "workspace-path/.tmp/one/a.txt" });
    await expect(call("open", [".tmp/one/a.txt", "r+"])).rejects.toMatchObject({
      code: "EACQUIRE",
    });
    expect(requested.at(-1)?.snapshot.capability).toBe("filesystem.write");
    allow("filesystem.write", requested.at(-1)!.resource);
    const handle = (await call("open", [".tmp/one/a.txt", "r+"])) as { handleId: number };
    await expect(call("handleClose", [handle.handleId])).resolves.toBeUndefined();
  });
  it("retains file boundaries through accepted website execution and revocation", async () => {
    allow("filesystem.read", { kind: "exact", key: "workspace-path/.tmp/one/a.txt" });
    const { website, ...base } = caller;
    const accepted = {
      ...base,
      runtime: { id: "do:accepted", kind: "do" as const },
      taskAuthority: "task:accepted" as const,
      executionAuthority: {
        kind: "website" as const,
        website: {
          ...website,
          binding: { subject: website.subject, generation: website.binding.generation },
        },
      },
    };
    await expect(
      dispatcher.dispatch({ caller: accepted }, "fs", "readFile", [".tmp/one/a.txt", "utf8"])
    ).resolves.toBe("one");
    await expect(
      dispatcher.dispatch({ caller: accepted }, "fs", "readFile", [".tmp/one/b.txt", "utf8"])
    ).rejects.toMatchObject({ code: "EACQUIRE" });
    grants.invalidateAuthoritySubject(website.subject);
    await expect(
      dispatcher.dispatch({ caller: accepted }, "fs", "readFile", [".tmp/one/a.txt", "utf8"])
    ).rejects.toThrow(/binding|current|revoked/);
  });
});
