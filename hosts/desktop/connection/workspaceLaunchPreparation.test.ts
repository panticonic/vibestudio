import { describe, expect, it, vi } from "vitest";
import type { ConnectedSession } from "../main/serverSession.js";
import { createWorkspaceLaunchPreparation } from "./workspaceLaunchPreparation.js";
import { reconcileWorkspaceLaunchUpdates } from "./workspaceLaunchUpdates.js";

vi.mock("./workspaceLaunchUpdates.js", () => ({ reconcileWorkspaceLaunchUpdates: vi.fn() }));
const pin = (name: string) => ({
  url: `git+https://example.test/${name}.git`,
  ref: "refs/heads/main",
  commit: "a".repeat(40),
});
const targets = { base: pin("base"), system: pin("system"), personal: pin("personal") };
const env = {
  VIBESTUDIO_APP_ROOT: "/product",
  VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(targets),
};
function fixture() {
  const calls = {
    system: vi.fn(async (service: string) =>
      service === "vcs" ? { kind: "event", eventId: "system-main" } : ([] as unknown)
    ),
    personal: vi.fn(async (service: string) =>
      service === "vcs" ? { kind: "event", eventId: "personal-main" } : ([] as unknown)
    ),
  };
  const get = vi.fn(async (id: keyof typeof calls) => ({ serverClient: { call: calls[id] } }));
  const hub = vi.fn(async () => [
    {
      workspaceId: "system",
      name: "System",
      privateRole: "system",
      lastOpened: 0,
      running: true,
      pendingApprovalCount: 0,
    },
    {
      workspaceId: "personal",
      name: "Personal",
      privateRole: "personal",
      lastOpened: 0,
      running: true,
      pendingApprovalCount: 0,
    },
    {
      workspaceId: "shared",
      name: "Shared",
      lastOpened: 0,
      running: true,
      pendingApprovalCount: 0,
    },
  ]);
  const session = {
    connectionMode: "local",
    workspaceId: "system",
    hubControlClient: { call: hub },
  } as unknown as ConnectedSession;
  return { session, calls, get, hub };
}

describe("product workspace launch preparation", () => {
  it("leaves remote workspaces under their server's update policy", async () => {
    const t = fixture();
    t.session.connectionMode = "remote";
    expect(await createWorkspaceLaunchPreparation(t.session, t.get as never, {})).toEqual({});
    expect(t.hub).not.toHaveBeenCalled();
  });

  it("routes companion reviews and template calls to their exact owner workspaces", async () => {
    const t = fixture();
    vi.mocked(reconcileWorkspaceLaunchUpdates).mockImplementation(
      async ({ client, mainState, targets: selected }) => {
        expect(selected).toEqual(expect.arrayContaining(Object.values(targets)));
        expect(selected).toHaveLength(3);
        await client.installed();
        expect(await mainState()).toEqual(
          expect.objectContaining({ eventId: expect.stringMatching(/-main$/) })
        );
        return [];
      }
    );
    const preparation = await createWorkspaceLaunchPreparation(t.session, t.get as never, env);
    expect(preparation.companions).toHaveLength(1);
    await preparation.companions![0]!("shellApproval", "listPending", []);
    expect(t.calls.personal).toHaveBeenCalledWith("shellApproval", "listPending", []);
    expect(await preparation.prepare!()).toEqual({ notices: [] });
    for (const [id, call] of Object.entries(t.calls)) {
      expect(call).toHaveBeenCalledWith("extensions", "invoke", ["templates", "installed", []]);
      expect(call).toHaveBeenCalledWith("vcs", "mainState", []);
      expect(await call("vcs")).toEqual({ kind: "event", eventId: `${id}-main` });
    }
    expect(t.get.mock.calls.every(([id]) => id !== ("shared" as string))).toBe(true);
  });

  it("keeps a failed workspace on its installed version without hiding another's review", async () => {
    const t = fixture();
    const failure = new Error("Templates service unavailable");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(reconcileWorkspaceLaunchUpdates)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([{ status: "conflicts", operationId: "op:personal" }] as Awaited<
        ReturnType<typeof reconcileWorkspaceLaunchUpdates>
      >);
    const preparation = await createWorkspaceLaunchPreparation(t.session, t.get as never, env);
    expect(await preparation.prepare!()).toEqual({
      notices: [
        {
          id: "workspace-update-failed:system",
          title: "Workspace update didn't finish",
          message:
            "System is staying on its installed version for now. Templates service unavailable",
        },
        {
          id: "workspace-update:op:personal",
          title: "Workspace update needs review",
          message:
            "Local changes need review before Personal can update. Resume Templates update op:personal.",
        },
      ],
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("system"), failure);
    error.mockRestore();
  });
});
