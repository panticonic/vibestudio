import { describe, expect, it, vi } from "vitest";
import { PublishController, type VaultPublishingSession } from "./publishController";

function revision(
  overrides: Partial<{
    clean: boolean;
    mainRelation: "at" | "ahead" | "behind" | "diverged";
    changes: number;
  }> = {}
) {
  return {
    repositoryId: "repo:notes",
    status: {
      contextId: "ctx",
      committed: { kind: "event" as const, eventId: "event:local" },
      workingHead: { kind: "event" as const, eventId: "event:local" },
      clean: overrides.clean ?? true,
      mainEventId: "event:main",
      mainRelation: overrides.mainRelation ?? "ahead",
      workingCounts: { applications: 0, workUnits: 0, changes: overrides.changes ?? 0 },
    },
  };
}

function session(overrides: Partial<VaultPublishingSession> = {}): VaultPublishingSession {
  return {
    repoPath: "projects/default",
    refresh: async () => revision(),
    integrateMain: async () => "up-to-date",
    keepLocalForMain: async () => "integrated",
    commit: async () => null,
    pendingChangeCount: async () => 0,
    push: async () => ({
      contextId: "ctx",
      eventId: "event:local",
      mainEventId: "event:local",
      effectId: "effect:push",
      appliedAt: new Date(0).toISOString(),
    }),
    ...overrides,
  };
}

describe("PublishController", () => {
  it("reports canonical working counts and main relation", async () => {
    const controller = new PublishController(
      session({ refresh: async () => revision({ changes: 3, mainRelation: "diverged" }) })
    );
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ pendingChanges: 3, relationship: "diverged" });
  });

  it("commits, integrates locally, then pushes", async () => {
    const order: string[] = [];
    let calls = 0;
    const controller = new PublishController(
      session({
        refresh: async () => {
          calls += 1;
          return revision({ mainRelation: calls < 3 ? "behind" : "ahead" });
        },
        integrateMain: async () => {
          order.push("integrate");
          return "integrated";
        },
        push: async () => {
          order.push("push");
          return {
            contextId: "ctx",
            eventId: "event:local",
            mainEventId: "event:local",
            effectId: "effect:push",
            appliedAt: new Date(0).toISOString(),
          };
        },
      }),
      () => {
        order.push("reload");
      },
      async () => {
        order.push("commit");
        return { eventId: "event:local", changed: true };
      }
    );

    await expect(controller.publish()).resolves.toEqual({ status: "published" });
    expect(order).toEqual(["commit", "integrate", "reload", "push"]);
  });

  it("commits the semantic context when the active editor reports no authored change", async () => {
    const commit = vi.fn(async () => ({
      event: { kind: "event" as const, eventId: "event:all" },
      contextId: "ctx",
      committedApplicationIds: ["application:all"],
      integrationSourceEventId: null,
    }));
    const commitWorkingCopy = vi.fn(async () => ({ eventId: "", changed: false }));
    let refreshCount = 0;
    const controller = new PublishController(
      session({
        refresh: async () => {
          refreshCount += 1;
          return revision({ clean: refreshCount !== 1, mainRelation: "ahead", changes: 1 });
        },
        commit,
      }),
      undefined,
      commitWorkingCopy
    );

    await expect(controller.publish("Publish durable edits")).resolves.toEqual({
      status: "published",
    });
    expect(commitWorkingCopy).toHaveBeenCalledWith("Publish durable edits");
    expect(commit).toHaveBeenCalledWith("Publish durable edits");
  });

  it("surfaces semantic conflicts as resolvable publish state", async () => {
    const controller = new PublishController(
      session({
        integrateMain: async () => ({
          status: "conflicts",
          sourceEventId: "event:main",
          conflicts: [
            { changeId: "change:conflict", kind: "text-edit", summary: "Change the title" },
          ],
        }),
      })
    );
    await expect(controller.sync()).resolves.toBe("conflicts");
    expect(controller.getSnapshot().conflicts).toEqual([
      { changeId: "change:conflict", kind: "text-edit", summary: "Change the title" },
    ]);
  });

  it("records an explicit keep-local decision and clears resolved conflicts", async () => {
    const keepLocalForMain = vi.fn(async () => "integrated" as const);
    const controller = new PublishController(session({ keepLocalForMain }));

    await expect(controller.keepLocal(["change:conflict"])).resolves.toBe("integrated");
    expect(keepLocalForMain).toHaveBeenCalledWith(["change:conflict"]);
    expect(controller.getSnapshot().conflicts).toEqual([]);
  });
});
