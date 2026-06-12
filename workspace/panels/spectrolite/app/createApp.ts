/**
 * Composition root — builds the store and wires the controllers together.
 * Created once per panel mount; controllers own all imperative lifecycle
 * (channel, agents, flush, git) and the React tree is a pure view of the
 * store.
 */

import { getStateArgs, contextId as runtimeContextId } from "@workspace/runtime";
import { createStore, type Store } from "./store";
import { initialState, type SpectroliteState } from "./state";
import { SessionController } from "./sessionController";
import { EditorController } from "./editorController";
import { VaultController } from "./vaultController";
import { GitController } from "./gitController";
import { resolveContextId, type InstalledAgentRecord } from "../bootstrap";

interface PersistedStateArgs {
  channelName?: string;
  contextId?: string;
  installedAgents?: InstalledAgentRecord[];
  openPath?: string;
  repoRoot?: string;
}

export interface SpectroliteApp {
  store: Store<SpectroliteState>;
  session: SessionController;
  editor: EditorController;
  vault: VaultController;
  git: GitController;
  start(): void;
  dispose(): void;
}

export function createSpectroliteApp(): SpectroliteApp {
  const args = getStateArgs<PersistedStateArgs>();
  const store = createStore(initialState({
    contextId: resolveContextId(args.contextId, runtimeContextId) ?? null,
    channelName: args.channelName ?? null,
    repoRoot: args.repoRoot ?? null,
    openPath: args.openPath ?? null,
    installedAgents: args.installedAgents ?? [],
  }));

  let editor!: EditorController;
  const git = new GitController(store, {
    flushAllDirty: async () => {
      await editor.flushAllDirty();
    },
  });

  editor = new EditorController(store, {
    onDiskChanged: () => {
      void git.refreshStatus();
      void vault.refreshPaths();
    },
  });

  const session = new SessionController(store, {
    getDepsForEval: () => store.getState().activeDeps,
  });

  const vault: VaultController = new VaultController(store, {
    flushAllDirty: () => editor.flushAllDirty(),
    onVaultChanged: () => {
      editor.reset();
      git.reset();
    },
    onVaultSelected: (repoRoot) => {
      session.onVaultSelected(repoRoot);
      void git.refreshStatus();
      void git.refreshBranches();
    },
  });

  let started = false;
  return {
    store,
    session,
    editor,
    vault,
    git,
    start() {
      if (started) return;
      started = true;
      // Lazy lookup: the eval runtime is created synchronously inside
      // session.start(), but start() itself resolves much later (agent
      // bootstrap) — an early doc load should still be able to prefetch.
      editor.setDepsPrefetcher(async (deps) => {
        await session.getEvalRuntime()?.prefetch(deps);
      });
      void session.start();
      if (store.getState().repoRoot) {
        void vault.refreshPaths();
        void git.refreshStatus();
        void git.refreshBranches();
      }
    },
    dispose() {
      editor.dispose();
      session.dispose();
    },
  };
}
