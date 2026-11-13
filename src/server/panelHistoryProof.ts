import {
  disprovesBuild,
  type PanelAttempt,
  type PanelFailureCode,
} from "@vibestudio/shared/panel/observation";
import type { BuildProofState, PanelRuntimeStore } from "./panelRuntimeStore.js";

/**
 * Updates that never break the page (tendrils, docs/tendrils-plan.md 4.4).
 *
 * The coordinator's attempt lifecycle is the evidence. The first time a build
 * (by build key) reaches `ready` it is proven, finally. If a build that was
 * never proven fails by its own code before starting (`disprovesBuild`), it is
 * marked failed and, when it is still the slot's current entry, the slot goes
 * back to its newest proven entry. Network, host and lease failures never
 * disprove a build, and failures after a build is proven never revert.
 *
 * The page restored by the revert learns of the failure from `proofForSlot`
 * (exposed as `panelRuntime.historyProof`) and reports it to the agent once
 * per build; a waiting rebuild/navigate call also returns the failure itself.
 */
export interface HistoryEntryProof {
  entryKey: string;
  entityId: string;
  buildKey: string | null;
  state: BuildProofState;
  failure: unknown;
}

export interface PanelHistoryProof {
  proofForSlot(slotId: string): Promise<HistoryEntryProof[]>;
  /** Settles when every revert started so far has finished (tests, shutdown). */
  idle(): Promise<void>;
  dispose(): void;
}

export interface PanelHistoryProofDeps {
  store: PanelRuntimeStore;
  coordinator: {
    onAttemptChanged(listener: (attemptId: string) => void): () => void;
    attemptById(attemptId: string): PanelAttempt | null;
  };
  /** Newest first. */
  slotHistory(slotId: string): Promise<ReadonlyArray<{ entry_key: string; entity_id: string }>>;
  /** The build key an entity runs (its active build), if it has one. */
  entityBuildKey(entityId: string): Promise<string | null>;
  currentEntity(slotId: string): Promise<string | null>;
  /** Make `entryKey` the slot's current entry, provided `expectedCurrentEntityId` still is. */
  revertTo(slotId: string, expectedCurrentEntityId: string, entryKey: string): Promise<void>;
  onError(error: unknown, context: string): void;
}

export function createPanelHistoryProof(deps: PanelHistoryProofDeps): PanelHistoryProof {
  const inFlight = new Set<Promise<void>>();

  const revertIfCurrent = async (attempt: PanelAttempt): Promise<void> => {
    const { slotId, runtimeEntityId } = attempt;
    if ((await deps.currentEntity(slotId)) !== runtimeEntityId) return; // someone navigated away
    for (const entry of await deps.slotHistory(slotId)) {
      if (entry.entity_id === runtimeEntityId) continue;
      const buildKey = await deps.entityBuildKey(entry.entity_id);
      if (buildKey && deps.store.proofOf(buildKey) === "proven") {
        await deps.revertTo(slotId, runtimeEntityId, entry.entry_key);
        return;
      }
    }
    // No proven entry to return to: the failure stays visible and is reported.
  };

  const track = (work: Promise<void>, context: string) => {
    const tracked = work.catch((error) => deps.onError(error, context));
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
  };

  const unsubscribe = deps.coordinator.onAttemptChanged((attemptId) => {
    const attempt = deps.coordinator.attemptById(attemptId);
    if (!attempt?.buildKey) return;
    if (attempt.phase === "ready") {
      deps.store.recordProof(attempt.buildKey, { state: "proven" });
      return;
    }
    if (attempt.phase !== "failed" || !attempt.failure) return;
    if (!disprovesBuild(attempt.failure.code as PanelFailureCode)) return;
    const result = deps.store.recordProof(attempt.buildKey, {
      state: "failed",
      failure: attempt.failure,
    });
    // Revert once, on the transition that disproved a never-proven build.
    if (result.changed && result.state === "failed") {
      track(revertIfCurrent(attempt), `revert unproven build of ${attempt.slotId}`);
    }
  });

  return {
    async proofForSlot(slotId) {
      const out: HistoryEntryProof[] = [];
      for (const entry of await deps.slotHistory(slotId)) {
        const buildKey = await deps.entityBuildKey(entry.entity_id);
        out.push({
          entryKey: entry.entry_key,
          entityId: entry.entity_id,
          buildKey,
          state: buildKey ? deps.store.proofOf(buildKey) : "unproven",
          failure: buildKey ? deps.store.failureOf(buildKey) : null,
        });
      }
      return out;
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    dispose: unsubscribe,
  };
}
