import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextWorkspaceSession,
  ContextWorkspaceSynchronizer,
  type ContextWorkspaceAdapters,
} from "./index.js";

const roots: string[] = [];
const root = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "vs-context-workspace-"));
  roots.push(value);
  return value;
};
afterEach(() => roots.splice(0).forEach((value) => fs.rmSync(value, { recursive: true, force: true })));

function adapters(): ContextWorkspaceAdapters & { edit: ReturnType<typeof vi.fn> } {
  return {
    readState: vi.fn(async (_repo, state) => [
      { path: "src/a.bin", bytes: Buffer.from(state), mode: 0o644 as const },
      { path: ".env", bytes: Buffer.from("TRACKED=1"), mode: 0o644 as const },
    ]),
    edit: vi.fn(async () => ({ stateHash: "state-2" })),
  };
}

describe("ContextWorkspaceSynchronizer", () => {
  it("round-trips binary writes, deletes, modes, and tracked scratch-like names", async () => {
    const deps = adapters();
    const dir = root();
    const sync = await ContextWorkspaceSynchronizer.open({
      root: dir,
      repoPath: "projects/vibestudio",
      stateHash: "state-1",
      adapters: deps,
    });
    fs.writeFileSync(path.join(dir, "src/a.bin"), Buffer.from([0, 255, 1]));
    fs.chmodSync(path.join(dir, "src/a.bin"), 0o755);
    fs.rmSync(path.join(dir, ".env"));
    await sync.flush();
    const sent = deps.edit.mock.calls[0]![0];
    expect(sent.baseStateHash).toBe("state-1");
    expect(sent.edits).toEqual([
      { kind: "delete", path: ".env" },
      { kind: "write", path: "src/a.bin", bytes: Buffer.from([0, 255, 1]), mode: 0o755 },
    ]);
    expect(sync.status()).toMatchObject({ stateHash: "state-2", pendingEdits: 0, status: "ready" });
  });

  it("retries an unknown outcome with one durable client edit id", async () => {
    const deps = adapters();
    deps.edit.mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce({ stateHash: "state-2" });
    const dir = root();
    const sync = await ContextWorkspaceSynchronizer.open({ root: dir, repoPath: "projects/vibestudio", stateHash: "state-1", adapters: deps });
    fs.writeFileSync(path.join(dir, "new.txt"), "new");
    await expect(sync.flush()).rejects.toThrow("connection lost");
    const firstId = deps.edit.mock.calls[0]![0].clientEditId;
    await sync.reconnect();
    expect(deps.edit.mock.calls[1]![0].clientEditId).toBe(firstId);
  });

  it("preserves local bytes and stops on CAS conflict", async () => {
    const deps = adapters();
    deps.edit.mockRejectedValue(Object.assign(new Error("stale base"), { code: "CAS_CONFLICT" }));
    const dir = root();
    const sync = await ContextWorkspaceSynchronizer.open({ root: dir, repoPath: "projects/vibestudio", stateHash: "state-1", adapters: deps });
    fs.writeFileSync(path.join(dir, "src/a.bin"), "local");
    await expect(sync.flush()).rejects.toThrow("stale base");
    expect(fs.readFileSync(path.join(dir, "src/a.bin"), "utf8")).toBe("local");
    expect(sync.status()).toMatchObject({ status: "conflict", pendingEdits: 1 });
    await expect(sync.flush()).rejects.toThrow("unresolved CAS conflict");
  });

  it("blocks inbound overwrite while local changes are unacknowledged", async () => {
    const deps = adapters();
    const dir = root();
    const sync = await ContextWorkspaceSynchronizer.open({ root: dir, repoPath: "projects/vibestudio", stateHash: "state-1", adapters: deps });
    fs.writeFileSync(path.join(dir, "src/a.bin"), "local");
    const status = await sync.pull("remote-2");
    expect(status.status).toBe("conflict");
    expect(fs.readFileSync(path.join(dir, "src/a.bin"), "utf8")).toBe("local");
  });

  it("three-way merges disjoint inbound changes and rebases the local CAS write", async () => {
    const edit = vi.fn(async () => ({ stateHash: "state-3" }));
    const deps: ContextWorkspaceAdapters = {
      readState: vi.fn(async (_repo, state) => [
        { path: "a.txt", bytes: Buffer.from("base-a"), mode: 0o644 as const },
        {
          path: "b.txt",
          bytes: Buffer.from(state === "state-1" ? "base-b" : "remote-b"),
          mode: 0o644 as const,
        },
      ]),
      edit,
    };
    const dir = root();
    const sync = await ContextWorkspaceSynchronizer.open({
      root: dir,
      repoPath: "projects/vibestudio",
      stateHash: "state-1",
      adapters: deps,
    });
    fs.writeFileSync(path.join(dir, "a.txt"), "local-a");

    await expect(sync.pull("state-2")).resolves.toMatchObject({ status: "ready" });
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("local-a");
    expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("remote-b");
    await sync.flush();
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        baseStateHash: "state-2",
        edits: [
          { kind: "write", path: "a.txt", bytes: Buffer.from("local-a"), mode: 0o644 },
        ],
      })
    );
  });

  it("recognizes a lost-response edit in inbound state and clears its durable journal", async () => {
    const edit = vi.fn(async () => {
      throw new Error("response lost");
    });
    const deps: ContextWorkspaceAdapters = {
      readState: vi.fn(async (_repo, state) => [
        {
          path: "a.txt",
          bytes: Buffer.from(state === "state-1" ? "base" : "local"),
          mode: 0o644 as const,
        },
      ]),
      edit,
    };
    const dir = root();
    const sync = await ContextWorkspaceSynchronizer.open({
      root: dir,
      repoPath: "projects/vibestudio",
      stateHash: "state-1",
      adapters: deps,
    });
    fs.writeFileSync(path.join(dir, "a.txt"), "local");
    await expect(sync.flush()).rejects.toThrow("response lost");

    await expect(sync.pull("state-2")).resolves.toMatchObject({
      stateHash: "state-2",
      pendingEdits: 0,
      status: "ready",
    });
    await sync.flush();
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("attaches multiple repositories under one managed session", async () => {
    const deps: ContextWorkspaceAdapters = {
      readState: vi.fn(async (repoPath) => [
        { path: "identity.txt", bytes: Buffer.from(repoPath), mode: 0o644 as const },
      ]),
      edit: vi.fn(async ({ baseStateHash }) => ({ stateHash: baseStateHash })),
    };
    const dir = root();
    const session = await ContextWorkspaceSession.open({
      root: dir,
      targets: [
        { repoPath: "projects/vibestudio", stateHash: "state-project" },
        { repoPath: "packages/ui", stateHash: "state-package" },
      ],
      adapters: deps,
    });

    expect(fs.readFileSync(path.join(dir, "projects/vibestudio/identity.txt"), "utf8")).toBe(
      "projects/vibestudio"
    );
    expect(fs.readFileSync(path.join(dir, "packages/ui/identity.txt"), "utf8")).toBe(
      "packages/ui"
    );
    expect(Object.keys(session.statuses()).sort()).toEqual(["packages/ui", "projects/vibestudio"]);
    await session.stop();
  });
});
