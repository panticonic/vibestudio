import { describe, expect, it, vi } from "vitest";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import {
  commitPreparedPanelNavigation,
  PanelNavigationCommitError,
  type PanelNavigationTransactionClients,
} from "./panelNavigationTransaction.js";

const slotId = asPanelSlotId("panel:tree/news");
const previousEntityId = asPanelEntityId("panel:nav-about-new");
const nextEntityId = asPanelEntityId("panel:nav-news");
const input = {
  slotId,
  expectedCurrentEntityId: previousEntityId,
  mutation: {
    kind: "append" as const,
    entry: {
      entryKey: "nav-news",
      entityId: nextEntityId,
      source: "panels/news",
      contextId: "ctx-news",
    },
  },
};

function clients(): PanelNavigationTransactionClients {
  return {
    workspaceState: {
      commitPreparedNavigation: vi.fn(async () => ({
        previousEntityId,
        currentEntityId: nextEntityId,
        currentEntryKey: "nav-news",
        cursor: 1,
      })),
    },
    runtime: { retireEntity: vi.fn(async () => undefined) },
  };
}

describe("commitPreparedPanelNavigation", () => {
  it("awaits the durable semantic commit before retiring the displaced runtime", async () => {
    const deps = clients();
    let finishHandoff!: () => void;
    const handoffPending = new Promise<void>((resolve) => {
      finishHandoff = resolve;
    });
    vi.mocked(deps.workspaceState.commitPreparedNavigation).mockImplementationOnce(async () => {
      await handoffPending;
      return {
        previousEntityId,
        currentEntityId: nextEntityId,
        currentEntryKey: "nav-news",
        cursor: 1,
      };
    });

    const commit = commitPreparedPanelNavigation(deps, input);
    await vi.waitFor(() =>
      expect(deps.workspaceState.commitPreparedNavigation).toHaveBeenCalledOnce()
    );
    expect(deps.runtime.retireEntity).not.toHaveBeenCalled();

    finishHandoff();
    await expect(commit).resolves.toMatchObject({ retirement: { status: "retired" } });
    expect(deps.runtime.retireEntity).toHaveBeenCalledWith(previousEntityId);
  });

  it("reports a semantic commit failure without guessing which entity is current", async () => {
    const deps = clients();
    const cause = new Error("workspace state unavailable");
    vi.mocked(deps.workspaceState.commitPreparedNavigation).mockRejectedValueOnce(cause);

    const failure = await commitPreparedPanelNavigation(deps, input).catch((error) => error);

    expect(failure).toBeInstanceOf(PanelNavigationCommitError);
    expect(failure).toMatchObject({ errors: [cause] });
    expect(deps.runtime.retireEntity).not.toHaveBeenCalled();
  });

  it("does not retire the prepared entity after an ambiguous commit response", async () => {
    const deps = clients();
    vi.mocked(deps.workspaceState.commitPreparedNavigation).mockRejectedValueOnce(
      new Error("navigation conflict")
    );

    await expect(commitPreparedPanelNavigation(deps, input)).rejects.toThrow(
      "navigation conflict"
    );
    expect(deps.runtime.retireEntity).not.toHaveBeenCalled();
  });
});
