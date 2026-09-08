import { describe, expect, it, vi } from "vitest";
import { submitWorkspaceCreation } from "./workspaceCreationClient";

function fixture() {
  const saved = new Map<string, string>();
  const receipt = { operationId: "stable-operation-0001", state: "registered" as const, workspaceId: "ws_created", name: "Example" };
  const persistence = { key: "account:alice", getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); }, newOperationId: vi.fn(() => receipt.operationId) };
  const client = { createWorkspace: vi.fn(async () => receipt), workspaceCreationReceipt: vi.fn(async () => receipt) };
  return { saved, receipt, persistence, client };
}

describe("durable workspace creation submission", () => {
  it("persists before effects, and uses a fresh receipt read after a lost reply", async () => {
    const f = fixture();
    f.client.createWorkspace.mockImplementationOnce(async () => {
      expect(f.saved.size).toBe(1);
      throw new Error("Reply lost after commit");
    });
    await expect(submitWorkspaceCreation(f.client, { workspace: "Example" }, f.persistence)).rejects.toThrow("Reply lost");
    expect(f.client.workspaceCreationReceipt).not.toHaveBeenCalled();
    await expect(submitWorkspaceCreation(f.client, { workspace: "Example" }, f.persistence)).resolves.toEqual(f.receipt);
    expect(f.client.createWorkspace).toHaveBeenCalledOnce();
    expect(f.client.workspaceCreationReceipt).toHaveBeenCalledWith({ operationId: f.receipt.operationId });
    expect(f.persistence.newOperationId).toHaveBeenCalledOnce();
    expect(f.saved.size).toBe(0);
  });

  it("keeps the original key and performs no new effect when reconciliation is denied", async () => {
    const f = fixture();
    f.client.createWorkspace.mockRejectedValueOnce(new Error("Disconnected"));
    await submitWorkspaceCreation(f.client, { workspace: "Example" }, f.persistence).catch(() => {});
    f.client.workspaceCreationReceipt.mockRejectedValueOnce(new Error("Receipt permission denied"));
    await expect(submitWorkspaceCreation(f.client, { workspace: "Example" }, f.persistence)).rejects.toThrow("Receipt permission denied");
    expect(f.saved.size).toBe(1);
    expect(f.client.createWorkspace).toHaveBeenCalledOnce();
    expect(f.persistence.newOperationId).toHaveBeenCalledOnce();
  });

  it("does not replace unresolved input or silently recreate a deleted result", async () => {
    const f = fixture();
    f.client.createWorkspace.mockRejectedValueOnce(new Error("Disconnected"));
    await submitWorkspaceCreation(f.client, { workspace: "Example" }, f.persistence).catch(() => {});
    await expect(submitWorkspaceCreation(f.client, { workspace: "Different" }, f.persistence)).rejects.toThrow("still unresolved");
    const deleted = { ...f.receipt, state: "deleted" as const };
    const client = { ...f.client, workspaceCreationReceipt: vi.fn(async () => deleted) };
    await expect(submitWorkspaceCreation(client, { workspace: "Example" }, f.persistence)).resolves.toEqual(deleted);
    expect(f.client.createWorkspace).toHaveBeenCalledOnce();
  });
});
