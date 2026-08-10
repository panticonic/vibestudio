import type { PanelSlotId } from "@vibestudio/shared/panel/idValues";
import type {
  SlotCommitPreparedNavigationInput,
  SlotCommitPreparedNavigationResult,
} from "./workspaceStateClient.js";

export interface PanelNavigationWorkspaceClient {
  commitPreparedNavigation(
    input: SlotCommitPreparedNavigationInput
  ): Promise<SlotCommitPreparedNavigationResult>;
}

export interface PanelNavigationTransactionClients {
  runtime: { retireEntity(id: string): Promise<void> };
  workspaceState: PanelNavigationWorkspaceClient;
}

export interface PanelNavigationCommitResult extends SlotCommitPreparedNavigationResult {
  retirement:
    | { status: "unchanged" }
    | { status: "retired" }
    | { status: "failed"; error: unknown };
}

/**
 * The durable semantic commit failed or its response was lost. Presentation is
 * deliberately not part of this transaction: hosts converge independently
 * from the slot's durable current entity.
 */
export class PanelNavigationCommitError extends Error {
  readonly errors: readonly unknown[];

  constructor(options: { slotId: PanelSlotId; errors: readonly unknown[] }) {
    const firstError = options.errors[0];
    const detail = firstError instanceof Error ? firstError.message : String(firstError);
    super(`Panel navigation commit failed for ${options.slotId}: ${detail}`);
    this.name = "PanelNavigationCommitError";
    this.errors = options.errors;
  }
}

/**
 * The sole userland transaction for making a prepared panel incarnation
 * current. This is a userland semantic transaction. Host presentation is a
 * derived projection and is never another command that callers coordinate.
 */
export async function commitPreparedPanelNavigation(
  clients: PanelNavigationTransactionClients,
  input: SlotCommitPreparedNavigationInput
): Promise<PanelNavigationCommitResult> {
  let transition: SlotCommitPreparedNavigationResult;
  try {
    transition = await clients.workspaceState.commitPreparedNavigation(input);
  } catch (commitError) {
    // A transport failure is ambiguous: the server may have completed its
    // durable semantic commit before the response was lost. Never retire
    // the prepared entity here; durable runtime GC can collect a genuinely
    // uncommitted preparation without risking retirement of the current one.
    throw new PanelNavigationCommitError({
      slotId: input.slotId,
      errors: [commitError],
    });
  }

  if (transition.previousEntityId === transition.currentEntityId) {
    return { ...transition, retirement: { status: "unchanged" } };
  }

  try {
    await clients.runtime.retireEntity(transition.previousEntityId);
    return { ...transition, retirement: { status: "retired" } };
  } catch (error) {
    return { ...transition, retirement: { status: "failed", error } };
  }
}
