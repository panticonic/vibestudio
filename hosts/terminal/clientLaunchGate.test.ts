import { describe, expect, it, vi } from "vitest";
import type { ClientLauncher, LaunchState } from "@vibestudio/client-host-core";
import { ChangeSignal, runClientLaunchGate } from "./clientLaunchGate.js";

const launched = { client: { id: "chat" } } as never;
const ready: LaunchState = { state: "ready", launched };
const preparing = (reason = "Building"): LaunchState => ({
  state: "preparing",
  phase: "build",
  reason,
});

function launcherOf(states: LaunchState[], onChanged: LaunchState[] = []) {
  return {
    launch: vi.fn(async () => states.shift()!),
    onClientsChanged: vi.fn(async () => onChanged.shift() ?? null),
    resolveApprovals: vi.fn(),
  } as unknown as ClientLauncher & {
    launch: ReturnType<typeof vi.fn>;
    onClientsChanged: ReturnType<typeof vi.fn>;
    resolveApprovals: ReturnType<typeof vi.fn>;
  };
}

describe("ChangeSignal", () => {
  it("wakes a waiter on the next bump and not before", async () => {
    const signal = new ChangeSignal();
    const after = signal.revision();
    let woke = false;
    const waiting = signal.wait(after).then(() => {
      woke = true;
    });
    await Promise.resolve();
    expect(woke).toBe(false);
    signal.bump();
    await waiting;
    expect(woke).toBe(true);
  });

  it("does not miss a change that happened after the revision was read", async () => {
    const signal = new ChangeSignal();
    const after = signal.revision();
    signal.bump();
    await expect(signal.wait(after)).resolves.toBeUndefined();
  });

  it("rejects with the owner's reason when cancelled", async () => {
    const signal = new ChangeSignal();
    const owner = new AbortController();
    const waiting = signal.wait(signal.revision(), owner.signal);
    const reason = new Error("interrupted");
    owner.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });
});

describe("runClientLaunchGate", () => {
  it("returns a ready launch", async () => {
    const launcher = launcherOf([ready]);
    await expect(
      runClientLaunchGate(launcher, { select: { default: true }, changes: new ChangeSignal() })
    ).resolves.toEqual({ status: "ready", launched, approvalsResolved: 0 });
    expect(launcher.launch).toHaveBeenCalledWith({ default: true });
  });

  it("reports an unavailable client with what it is missing", async () => {
    const launcher = launcherOf([
      { state: "unavailable", reason: "nope", missing: { capabilities: ["camera"] } },
    ]);
    await expect(
      runClientLaunchGate(launcher, { select: { id: "chat" }, changes: new ChangeSignal() })
    ).resolves.toMatchObject({ status: "unavailable", missing: { capabilities: ["camera"] } });
  });

  it("waits for a server event while preparing instead of asking again on a timer", async () => {
    vi.useFakeTimers();
    try {
      const changes = new ChangeSignal();
      const progress: string[] = [];
      const launcher = launcherOf([preparing("Building the client")], [ready]);
      const gate = runClientLaunchGate(launcher, {
        select: { default: true },
        changes,
        onProgress: (line) => progress.push(line),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      // A minute of silence from the server is not a reason to ask again.
      expect(launcher.onClientsChanged).not.toHaveBeenCalled();
      expect(progress).toEqual(["Building the client"]);
      changes.bump();
      await expect(gate).resolves.toMatchObject({ status: "ready" });
      expect(launcher.onClientsChanged).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting when the owner cancels", async () => {
    const owner = new AbortController();
    const launcher = launcherOf([preparing()]);
    const gate = runClientLaunchGate(launcher, {
      select: { default: true },
      changes: new ChangeSignal(),
      signal: owner.signal,
    });
    await vi.waitFor(() => expect(launcher.launch).toHaveBeenCalled());
    const reason = new Error("SIGTERM");
    owner.abort(reason);
    await expect(gate).rejects.toBe(reason);
  });

  const approvals = [
    {
      kind: "unit-install-review",
      approvalId: "gate-1",
      callerId: "system:startup",
      callerKind: "system",
      repoPath: "meta",
      effectiveVersion: "",
      requestedAt: 1,
      executionPlatform: "linux",
      mode: "adopt-root",
      title: "Start this workspace?",
      description: "",
      parts: [
        {
          identityKey: "clients/chat@ev",
          kind: "client",
          label: "Client",
          surfaces: [],
          name: "@workspace-clients/chat",
          title: "Chat",
          purpose: "Chat in a terminal.",
          repoPath: "clients/chat",
          effectiveVersion: "ev",
          version: "1.0.0",
          requiredUnitKeys: [],
          runsInBackground: false,
          runtime: "terminal",
          origin: {
            url: null,
            originKey: "vibestudio",
            registrableDomain: null,
            version: "1.4.0",
            isHostBuild: true,
            isWorkspaceRoot: true,
            firstEncounter: false,
          },
          notableRows: [],
          everydayRows: [],
          change: "added",
          section: "template",
        },
      ],
      summary: { panels: 0, agents: 0, services: 0, clients: 1, extensions: 0 },
      unchangedPartCount: 0,
    },
  ] as never;
  const written: string[] = [];
  const output = {
    write: (text: string) => written.push(text),
    columns: 80,
  } as unknown as NodeJS.WriteStream;

  it("answers an approval with --yes once and carries on", async () => {
    const launcher = launcherOf([{ state: "approval-required", approvals }]);
    launcher.resolveApprovals.mockResolvedValue(ready);
    await expect(
      runClientLaunchGate(launcher, {
        select: { default: true },
        changes: new ChangeSignal(),
        yes: true,
        output,
      })
    ).resolves.toMatchObject({ status: "ready", approvalsResolved: 1 });
    expect(launcher.resolveApprovals).toHaveBeenCalledWith(approvals, "once");
    expect(written.join("")).toContain("Terminal");
  });

  it("refuses to ask a question that nobody can answer", async () => {
    const launcher = launcherOf([{ state: "approval-required", approvals }]);
    const input = { isTTY: false } as NodeJS.ReadStream;
    await expect(
      runClientLaunchGate(launcher, {
        select: { default: true },
        changes: new ChangeSignal(),
        input,
        output,
      })
    ).rejects.toThrow(/needs your approval, but this is not an interactive terminal/);
    expect(launcher.resolveApprovals).not.toHaveBeenCalled();
  });
});
