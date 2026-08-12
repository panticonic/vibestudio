import type { ChatMessage } from "@workspace/agentic-core";
import type { SessionSnapshot } from "@workspace/agentic-session";
import type { TestExecutionResult, TestOrchestrationContext } from "../types.js";

const PAGE_SIZE = 100;
const MAX_VISIBLE_PANELS = 2_000;

export interface VisiblePanelNode {
  id: string;
  parentId: string | null;
  kind: "workspace" | "browser";
}

export interface PanelTreeInvariantEvidence {
  beforeIds: string[];
  afterTurnIds: string[];
  createdIds: string[];
  removedPreexistingIds: string[];
  harnessArchivedRootIds: string[];
  remainingCreatedIds: string[];
}

export interface SeededPanelGoalEvidence {
  panelId: string;
  expectedFinalUrl: string;
  initialSource: string | null;
  initialUrl: string | null;
  initialPhase: string | null;
  initialPathIds: string[];
  finalSource: string | null;
  finalUrl: string | null;
  finalPhase: string | null;
  finalPathIds: string[];
  targetPreserved: boolean;
  reachedExpectedDestination: boolean;
}

type TreeReader = Pick<
  TestOrchestrationContext["runner"]["panelTreeClient"],
  "roots" | "children" | "get"
>;

type FixtureTreeReader = TreeReader &
  Pick<TestOrchestrationContext["runner"]["panelTreeClient"], "path">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read the complete visible tree through its bounded public pages. */
export async function snapshotVisiblePanelTree(
  tree: TreeReader
): Promise<Map<string, VisiblePanelNode>> {
  const nodes = new Map<string, VisiblePanelNode>();
  const parents: Array<string | null> = [null];

  for (let parentIndex = 0; parentIndex < parents.length; parentIndex += 1) {
    const parentId = parents[parentIndex]!;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (;;) {
      const page = parentId
        ? await tree.children(parentId, { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) })
        : await tree.roots({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });

      for (const entry of page.entries) {
        const id = entry.node.slotId;
        if (nodes.has(id)) continue;
        nodes.set(id, {
          id,
          parentId: entry.node.parentSlotId ?? null,
          kind: entry.node.kind ?? "workspace",
        });
        parents.push(id);
        if (nodes.size > MAX_VISIBLE_PANELS) {
          throw new Error(
            `Panel-tree invariant refused to inspect more than ${MAX_VISIBLE_PANELS} visible panels`
          );
        }
      }

      if (!page.nextCursor) break;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error(`Panel-tree pagination repeated cursor ${page.nextCursor}`);
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  return nodes;
}

export function panelTreeDifference(
  before: ReadonlyMap<string, VisiblePanelNode>,
  after: ReadonlyMap<string, VisiblePanelNode>
): Pick<PanelTreeInvariantEvidence, "createdIds" | "removedPreexistingIds"> {
  return {
    createdIds: [...after.keys()].filter((id) => !before.has(id)).sort(),
    removedPreexistingIds: [...before.keys()].filter((id) => !after.has(id)).sort(),
  };
}

export function createdPanelRoots(
  createdIds: readonly string[],
  after: ReadonlyMap<string, VisiblePanelNode>
): VisiblePanelNode[] {
  const created = new Set(createdIds);
  return createdIds
    .map((id) => after.get(id))
    .filter(
      (node): node is VisiblePanelNode => node !== undefined && !created.has(node.parentId ?? "")
    );
}

/**
 * Run an ordinary agent goal while enforcing panel ownership outside its prompt.
 * The post-turn snapshot is evidence; harness cleanup happens only after that
 * evidence is fixed, so cleanup cannot turn a leak into a pass.
 */
export async function orchestratePanelGoal(
  context: TestOrchestrationContext,
  prompt: string,
  phase: string,
  tree: TreeReader = context.runner.panelTreeClient
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const cleanupErrors: string[] = [];
  const failures: string[] = [];
  const before = await snapshotVisiblePanelTree(tree);
  const session = await context.runner.spawn();

  try {
    await context.sendAndWait(session, prompt, phase);
  } catch (error) {
    failures.push(errorMessage(error));
  }

  let afterTurn = new Map<string, VisiblePanelNode>();
  let createdIds: string[] = [];
  let removedPreexistingIds: string[] = [];
  const harnessArchivedRootIds: string[] = [];
  let remainingCreatedIds: string[] = [];

  try {
    afterTurn = await snapshotVisiblePanelTree(tree);
    ({ createdIds, removedPreexistingIds } = panelTreeDifference(before, afterTurn));

    if (createdIds.length > 0) {
      failures.push(`Agent left temporary panels in the tree: ${createdIds.join(", ")}`);
    }
    if (removedPreexistingIds.length > 0) {
      failures.push(
        `Agent archived panels that predated the task: ${removedPreexistingIds.join(", ")}`
      );
    }

    for (const node of createdPanelRoots(createdIds, afterTurn)) {
      try {
        await tree.get(node.id, node.kind).archive();
        harnessArchivedRootIds.push(node.id);
      } catch (error) {
        cleanupErrors.push(`archive leaked panel ${node.id}: ${errorMessage(error)}`);
      }
    }

    const afterCleanup = await snapshotVisiblePanelTree(tree);
    remainingCreatedIds = createdIds.filter((id) => afterCleanup.has(id));
    if (remainingCreatedIds.length > 0) {
      cleanupErrors.push(
        `panels remained after harness cleanup: ${remainingCreatedIds.join(", ")}`
      );
    }
  } catch (error) {
    failures.push(
      `Panel-tree invariant could not inspect the post-turn tree: ${errorMessage(error)}`
    );
  }

  let snapshot: SessionSnapshot | undefined;
  try {
    snapshot = session.snapshot();
  } catch (error) {
    failures.push(`Could not snapshot the headless session: ${errorMessage(error)}`);
  }

  const execution: TestExecutionResult = {
    messages: [...session.messages] as ChatMessage[],
    duration: Date.now() - startedAt,
    ...(snapshot ? { snapshot } : {}),
    ...(failures.length > 0 ? { error: failures.join("; ") } : {}),
    diagnostics: {
      panelTreeInvariant: {
        beforeIds: [...before.keys()].sort(),
        afterTurnIds: [...afterTurn.keys()].sort(),
        createdIds,
        removedPreexistingIds,
        harnessArchivedRootIds,
        remainingCreatedIds,
      } satisfies PanelTreeInvariantEvidence,
    },
  };

  try {
    await session.close();
  } catch (error) {
    cleanupErrors.push(`close headless session: ${errorMessage(error)}`);
  }
  if (cleanupErrors.length > 0) {
    execution.cleanupErrors = cleanupErrors;
    execution.error = [execution.error, `Harness cleanup failed: ${cleanupErrors.join("; ")}`]
      .filter(Boolean)
      .join("; ");
  }

  return execution;
}

function appendExecutionError(execution: TestExecutionResult, message: string): void {
  execution.error = [execution.error, message].filter(Boolean).join("; ");
}

function appendCleanupError(execution: TestExecutionResult, message: string): void {
  execution.cleanupErrors = [...(execution.cleanupErrors ?? []), message];
  appendExecutionError(execution, `Harness cleanup failed: ${message}`);
}

/**
 * Seed one real, harness-owned panel before the agent turn, then prove that the
 * same visible tree target reached the requested source. The ordinary tree
 * invariant treats the fixture as pre-existing agent state; this wrapper owns
 * its eventual archival regardless of the agent outcome.
 */
export async function orchestrateSeededPanelGoal(
  context: TestOrchestrationContext,
  prompt: string,
  phase: string,
  initialSource: string,
  expectedFinalUrl: string,
  tree: FixtureTreeReader = context.runner.panelTreeClient
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  let fixture: Awaited<ReturnType<TestOrchestrationContext["runner"]["openPanelClient"]>> | null =
    null;
  let execution: TestExecutionResult | null = null;
  let fixtureStillVisible = false;

  try {
    fixture = await context.runner.openPanelClient(initialSource, {
      parentId: null,
      focus: false,
    });
    const initialObservation = await fixture.observe();
    const initialPath = await tree.path(fixture.id);

    execution = await orchestratePanelGoal(context, prompt, phase, tree);

    let finalObservation: Awaited<ReturnType<typeof fixture.observe>> | null = null;
    let finalPath: Awaited<ReturnType<FixtureTreeReader["path"]>> = null;
    try {
      finalPath = await tree.path(fixture.id);
      fixtureStillVisible = finalPath !== null;
      if (fixtureStillVisible) finalObservation = await fixture.observe();
    } catch (error) {
      appendExecutionError(
        execution,
        `Could not inspect the seeded panel after the agent turn: ${errorMessage(error)}`
      );
    }

    const evidence: SeededPanelGoalEvidence = {
      panelId: fixture.id,
      expectedFinalUrl,
      initialSource: initialObservation.source ?? null,
      initialUrl: initialObservation.host?.view.url ?? null,
      initialPhase: initialObservation.phase ?? null,
      initialPathIds: initialPath?.entries.map((entry) => entry.node.slotId) ?? [],
      finalSource: finalObservation?.source ?? null,
      finalUrl: finalObservation?.host?.view.url ?? null,
      finalPhase: finalObservation?.phase ?? null,
      finalPathIds: finalPath?.entries.map((entry) => entry.node.slotId) ?? [],
      targetPreserved: fixtureStillVisible && finalObservation?.panelId === fixture.id,
      reachedExpectedDestination: finalObservation?.host?.view.url === expectedFinalUrl,
    };
    execution.diagnostics = {
      ...(execution.diagnostics ?? {}),
      seededPanelGoal: evidence,
    };

    if (!evidence.targetPreserved) {
      appendExecutionError(execution, "Agent did not preserve the seeded panel-tree target");
    }
    if (!evidence.reachedExpectedDestination) {
      appendExecutionError(
        execution,
        `Seeded panel rendered ${evidence.finalUrl ?? "an unavailable URL"}, expected ${expectedFinalUrl}`
      );
    }
  } catch (error) {
    execution ??= {
      messages: [],
      duration: Date.now() - startedAt,
      error: `Could not prepare or run the seeded panel goal: ${errorMessage(error)}`,
    };
  } finally {
    if (fixture) {
      try {
        if (!fixtureStillVisible) fixtureStillVisible = (await tree.path(fixture.id)) !== null;
        if (fixtureStillVisible) await fixture.archive();
      } catch (error) {
        execution ??= { messages: [], duration: Date.now() - startedAt };
        appendCleanupError(execution, `archive seeded panel ${fixture.id}: ${errorMessage(error)}`);
      }
    }
  }

  return (
    execution ?? {
      messages: [],
      duration: Date.now() - startedAt,
      error: "Seeded panel goal did not produce an execution result",
    }
  );
}
