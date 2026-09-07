import { describe, expect, it, vi } from "vitest";
import { WorkspaceSessionDirectory } from "./workspaceSessionDirectory.js";

function session(workspaceId: string) {
  return { workspaceId, close: vi.fn(async () => {}) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("desktop workspace session ownership", () => {
  it("opens lazily, deduplicates concurrent requests and preserves previous sessions", async () => {
    const personal = session("personal");
    const project = session("project");
    const connect = vi.fn(async () => project);
    const directory = new WorkspaceSessionDirectory(personal, connect);
    expect(connect).not.toHaveBeenCalled();
    const first = directory.get("project");
    expect(directory.get("project")).toBe(first);
    expect(await first).toBe(project);
    expect(await directory.get("personal")).toBe(personal);
    expect(personal.close).not.toHaveBeenCalled();
    await directory.close();
    expect(personal.close).toHaveBeenCalledTimes(1);
    expect(project.close).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight opening during shutdown and blocks later opening", async () => {
    const pending = deferred<ReturnType<typeof session>>();
    const project = session("project");
    const directory = new WorkspaceSessionDirectory(session("personal"), () => pending.promise);
    const opening = directory.get("project");
    const closing = directory.close();
    expect(directory.close()).toBe(closing);
    await expect(directory.get("another")).rejects.toThrow("closing");
    pending.resolve(project);
    await opening;
    await closing;
    expect(project.close).toHaveBeenCalledTimes(1);
  });

  it("retries failed connection attempts without replacing another workspace", async () => {
    const project = session("project");
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValue(project);
    const directory = new WorkspaceSessionDirectory(session("personal"), connect);
    await expect(directory.get("project")).rejects.toThrow("Disconnected");
    expect(await directory.get("project")).toBe(project);
    await directory.close();
  });

  it("rejects an unexpected workspace identity and closes the wrong connection", async () => {
    const wrong = session("wrong");
    const directory = new WorkspaceSessionDirectory(session("personal"), async () => wrong);
    await expect(directory.get("project")).rejects.toThrow("different workspace identity");
    expect(wrong.close).toHaveBeenCalledTimes(1);
    await directory.close();
  });

  it("membership removal waits for opening and only releases the affected workspace", async () => {
    const personal = session("personal");
    const project = session("project");
    const pending = deferred<typeof project>();
    const directory = new WorkspaceSessionDirectory(personal, () => pending.promise);
    void directory.get("project");
    const release = directory.release("project");
    await expect(directory.get("project")).rejects.toThrow("closing");
    pending.resolve(project);
    await release;
    expect(project.close).toHaveBeenCalledTimes(1);
    expect(personal.close).not.toHaveBeenCalled();
    await directory.close();
  });

  it("reports cleanup failures and does not abandon other owned sessions", async () => {
    const personal = session("personal");
    personal.close.mockRejectedValue(new Error("Still attached"));
    const project = session("project");
    const directory = new WorkspaceSessionDirectory(personal, async () => project);
    await directory.get("project");
    await expect(directory.close()).rejects.toThrow("Workspace session cleanup failed");
    expect(project.close).toHaveBeenCalledTimes(1);
    await expect(directory.get("personal")).rejects.toThrow("closing");
  });
  it("retains a rejected identity when its physical connection fails to close", async () => {
    const wrong = session("wrong");
    wrong.close.mockRejectedValue(new Error("Native transport still attached"));
    const directory = new WorkspaceSessionDirectory(session("personal"), async () => wrong);
    await expect(directory.get("project")).rejects.toThrow("still attached");
    await expect(directory.get("project")).rejects.toThrow("closing");
    await expect(directory.close()).rejects.toThrow("Workspace session cleanup failed");
    expect(wrong.close).toHaveBeenCalledTimes(1);
  });
});
