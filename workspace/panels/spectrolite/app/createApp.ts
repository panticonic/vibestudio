/**
 * Composition root — builds the store + the GAD-native pieces and wires them.
 *
 * Created once per panel mount. The vault runs under its own durable semantic
 * context with an exact committed event and working state, so:
 *   - `viewState` (per-viewer component state) is panel-local, per vault,
 *   - `publish` commits local applications, integrates main, and publishes,
 *   - `vault` owns selection + the `vcs.listFiles` path index,
 *   - `session` owns the channel + resident scribe (NO edit-driven dispatch),
 *   - per-document DocControllers (owned by `DocumentEditor`) commit + reconcile.
 *
 * The React tree is a pure view of the store; controllers + DocControllers are
 * the only writers.
 */

import { panel, contextId as runtimeContextId, rpc } from "@workspace/runtime";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import { createStore, type Store } from "./store";
import { initialState, type PendingSuggestion, type SpectroliteState } from "./state";
import { SessionController } from "./sessionController";
import { VaultController } from "./vaultController";
import { normalizeVaultPath } from "./vaultContext";
import { PublishController } from "./publishController";
import { createViewStateStore, type ViewStateStore } from "../coedit/viewState";
import { parseFrontmatter, diffDependencies } from "../mdx/frontmatter";
import { prefetchDependencies } from "../mdx/depPrefetch";
import type { Collision } from "../coedit/blockReconcile";
import { resolveContextId, type InstalledAgentRecord } from "../bootstrap";
import { spectroliteE2EHooksEnabled } from "./e2eHooks";
import { VaultSemanticVcs } from "./semanticVcs";

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
  vault: VaultController;
  publish: PublishController;
  semanticVcs: VaultSemanticVcs | null;
  viewState: ViewStateStore;
  /** Open a document (vault-relative path) in the editor. */
  openFile(path: string): void;
  /** Recompute the active doc's frontmatter dependency map (feeds inline JSX). */
  setActiveDocSource(path: string, markdown: string): void;
  /** Mark/unmark a vault-relative path as having uncommitted edits. */
  setDirty(path: string, dirty: boolean): void;
  /** Surface live same-block collisions (DocController.onCollisions). */
  pushCollisions(collisions: Collision[], vcsPath: string): void;
  /**
   * Resolve a suggestion card. The active editor (registered by DocumentEditor)
   * applies the chosen text to the live blocks as a normal user edit (which the
   * DocController then commits); the card is dismissed regardless.
   */
  resolveSuggestion(id: string, resolved: SuggestionResolution | null): void;
  /** DocumentEditor registers how to apply a block resolution to the live doc. */
  registerSuggestionApplier(applier: SuggestionApplier | null): void;
  /** DocumentEditor registers the active doc's deliberate commit (Publish /
   *  Send-to-scribe flush). Carries a commit message. */
  registerCommitActiveDoc(commit: CommitActiveDoc | null): void;
  /** DocumentEditor registers a reload-now after Sync advances the working state. */
  registerReloadActiveDoc(reload: ReloadActiveDoc | null): void;
  /** Commit the active doc's working copy now with a message (Send-to-scribe
   *  flush-first). NOT called on typing — only on deliberate user gestures. */
  commitActiveDoc(message: string): Promise<{ eventId: string; changed: boolean } | null>;
  start(): void;
  dispose(): void;
}

export type CommitActiveDoc = (
  message: string
) => Promise<{ eventId: string; changed: boolean } | null>;
/** Re-read the active document at the current exact working state. */
export type ReloadActiveDoc = () => Promise<void>;

/** The text the user chose for a colliding run, with the run's live block ids. */
export interface SuggestionResolution {
  oldIds: string[];
  beforeId: string | null;
  text: string;
}

export type SuggestionApplier = (resolution: SuggestionResolution) => void;

type SpectroliteE2EGlobal = typeof globalThis & {
  __spectroliteE2E__?: {
    addAgent(agentId: string): Promise<void>;
    openFile(path: string): void;
    removeAgent(handle: string): Promise<void>;
    switchVault(): Promise<void>;
    snapshot(): {
      availableAgents: Array<{ id: string; className: string }>;
      channelName: string | null;
      contextId: string | null;
      installedAgents: Array<{ handle: string; className: string; key: string }>;
      lastAdd: {
        agentId: string | null;
        error: string | null;
        status: "idle" | "pending" | "resolved" | "rejected";
      };
      repoRoot: string | null;
      roster: Array<{ handle: string; status: string }>;
    };
  };
};

export function createSpectroliteApp(): SpectroliteApp {
  const args = panel.stateArgs.get<PersistedStateArgs>();
  const contextId = resolveContextId(args.contextId, runtimeContextId) ?? null;
  const repoRoot = typeof args.repoRoot === "string" ? normalizeVaultPath(args.repoRoot) : null;
  const store = createStore(
    initialState({
      contextId,
      channelName: args.channelName ?? null,
      repoRoot,
      openPath: args.openPath ?? null,
      installedAgents: args.installedAgents ?? [],
    })
  );

  const semanticVcs = contextId && repoRoot ? new VaultSemanticVcs(contextId, repoRoot) : null;

  const viewState = createViewStateStore();
  // The active document reloads after semantic integration remaps the context
  // onto a new exact working state.
  let reloadActiveDocFn: ReloadActiveDoc | null = null;
  // The active document's deliberate semantic commit (selected working unit →
  // new context event with a message), registered by DocumentEditor.
  // Declared before `publish` so the
  // controller's commit-then-push step can close over it. Publish ties the
  // commit and the push into one user gesture.
  let commitActiveDocFn: CommitActiveDoc | null = null;
  const publish = new PublishController(
    semanticVcs,
    () => (reloadActiveDocFn ? reloadActiveDocFn() : Promise.resolve()),
    (message) => (commitActiveDocFn ? commitActiveDocFn(message) : Promise.resolve(null))
  );

  // A panel sandbox used solely to prefetch frontmatter-declared dependencies
  // into the panel's module map so inline JSX (LiveJsxEditor) + Preview-mode
  // compilation can resolve them. Mirrors the local sandbox LiveJsxEditor and
  // runtimeNamespace each build for live compile.
  const depSandbox = createPanelSandboxConfig(rpc);

  // The active doc's last-seen frontmatter deps (so inline JSX tracks edits
  // without re-parsing on every keystroke at the app layer).
  let lastDeps: Record<string, string> = {};
  // How the active document applies a user-chosen collision resolution.
  let suggestionApplier: SuggestionApplier | null = null;

  const setActiveDocSource = (path: string, markdown: string): void => {
    if (store.getState().activePath !== path) return;
    const next = parseFrontmatter(markdown).dependencies;
    const { added, changed, removed } = diffDependencies(lastDeps, next);
    if (
      Object.keys(added).length === 0 &&
      Object.keys(changed).length === 0 &&
      removed.length === 0
    )
      return;
    lastDeps = next;
    store.setState({ activeDeps: next });
    void prefetchDependencies(depSandbox, { ...added, ...changed }, (line) => {
      console.info(line);
    }).catch((err) => console.warn("[Spectrolite] dependency prefetch failed:", err));
  };

  const session = new SessionController(store);

  const vault = new VaultController(
    store,
    {
      onVaultSelected: (repoRoot) => {
        session.onVaultSelected(repoRoot);
        void publish.refresh();
      },
    },
    semanticVcs
  );

  const openFileInternal = (path: string, extraStateArgs?: Record<string, unknown>): void => {
    if (store.getState().activePath === path) {
      if (extraStateArgs) void panel.stateArgs.set({ openPath: path, ...extraStateArgs });
      return;
    }
    store.setState((prev) => ({
      activePath: path,
      recentPaths: [path, ...prev.recentPaths.filter((p) => p !== path)].slice(0, 12),
      // A doc switch clears stale deps; setActiveDocSource re-derives them.
      activeDeps: {},
      // Suggestions are per-doc; drop any not for the new doc on open.
      pendingSuggestions: prev.pendingSuggestions.filter(
        (s) => s.vcsPath === vault.mapping().toVcsPath(path)
      ),
    }));
    lastDeps = {};
    void panel.stateArgs.set({ openPath: path, ...(extraStateArgs ?? {}) });
  };

  let started = false;
  let startupRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const semanticEvents = semanticVcs ? new EventsClient(rpc) : null;
  const unsubscribePublication = semanticEvents?.on("vcs:publication", () => {
    refreshVaultSidebars();
  });
  const refreshVaultSidebars = (): void => {
    void vault.refreshPaths();
    void publish.refresh();
  };
  const spectroliteApp: SpectroliteApp = {
    store,
    session,
    vault,
    publish,
    semanticVcs,
    viewState,
    openFile(path) {
      openFileInternal(path);
    },
    setActiveDocSource,
    setDirty(path, dirty) {
      store.setState((prev) => {
        const has = prev.dirtyPaths.includes(path);
        if (dirty === has) return {};
        return {
          dirtyPaths: dirty
            ? [...prev.dirtyPaths, path]
            : prev.dirtyPaths.filter((p) => p !== path),
        };
      });
    },
    pushCollisions(collisions, vcsPath) {
      if (collisions.length === 0) return;
      const additions: PendingSuggestion[] = collisions.map((collision) => ({
        id: `${vcsPath}:${collision.fromIndex}:${collision.toIndex}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
        vcsPath,
        collision,
      }));
      store.setState((prev) => ({
        pendingSuggestions: [...prev.pendingSuggestions, ...additions],
      }));
    },
    resolveSuggestion(id, resolved) {
      const suggestion = store.getState().pendingSuggestions.find((s) => s.id === id);
      if (
        resolved &&
        suggestion &&
        suggestion.vcsPath === vault.mapping().toVcsPath(store.getState().activePath ?? "")
      ) {
        try {
          suggestionApplier?.(resolved);
        } catch (err) {
          console.warn("[Spectrolite] applying suggestion failed:", err);
        }
      }
      store.setState((prev) => {
        const next = prev.pendingSuggestions.filter((s) => s.id !== id);
        return next.length === prev.pendingSuggestions.length ? {} : { pendingSuggestions: next };
      });
    },
    registerSuggestionApplier(applier) {
      suggestionApplier = applier;
    },
    registerCommitActiveDoc(commit) {
      commitActiveDocFn = commit;
    },
    registerReloadActiveDoc(reload) {
      reloadActiveDocFn = reload;
    },
    commitActiveDoc(message) {
      return commitActiveDocFn ? commitActiveDocFn(message) : Promise.resolve(null);
    },
    start() {
      if (started) return;
      started = true;
      void session.start();
      if (store.getState().repoRoot !== null) {
        if (store.getState().activePath) {
          startupRefreshTimer = setTimeout(() => {
            startupRefreshTimer = null;
            refreshVaultSidebars();
          }, 1000);
        } else {
          refreshVaultSidebars();
        }
      }
      if (semanticVcs) {
        void semanticEvents?.subscribe("vcs:publication").catch((error) => {
          console.warn("[Spectrolite] failed to subscribe to VCS publications:", error);
        });
      }
    },
    dispose() {
      unsubscribePublication?.();
      void semanticEvents?.unsubscribeAll();
      session.dispose();
      if (startupRefreshTimer) {
        clearTimeout(startupRefreshTimer);
        startupRefreshTimer = null;
      }
      const g = globalThis as SpectroliteE2EGlobal;
      if (g.__spectroliteE2E__ === e2e) {
        delete g.__spectroliteE2E__;
      }
    },
  };
  let lastE2EAdd: ReturnType<
    NonNullable<SpectroliteE2EGlobal["__spectroliteE2E__"]>["snapshot"]
  >["lastAdd"] = { agentId: null, error: null, status: "idle" };
  const e2e = {
    async addAgent(agentId: string) {
      lastE2EAdd = { agentId, error: null, status: "pending" };
      try {
        await spectroliteApp.session.addAgent(agentId);
        lastE2EAdd = { agentId, error: null, status: "resolved" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastE2EAdd = { agentId, error: message, status: "rejected" };
        throw err;
      }
    },
    openFile: (path: string) => spectroliteApp.openFile(path),
    removeAgent: (handle: string) => spectroliteApp.session.removeAgent(handle),
    switchVault: () => spectroliteApp.vault.switchVault(),
    snapshot() {
      const state = spectroliteApp.store.getState();
      return {
        availableAgents: state.availableAgents.map((agent) => ({
          id: agent.id,
          className: agent.className,
        })),
        channelName: state.channelName,
        contextId: state.contextId,
        installedAgents: state.installedAgents.map((agent) => ({
          handle: agent.handle,
          className: agent.className,
          key: agent.key,
        })),
        lastAdd: lastE2EAdd,
        repoRoot: state.repoRoot,
        roster: state.roster.map((agent) => ({
          handle: agent.handle,
          status: agent.status,
        })),
      };
    },
  };
  if (spectroliteE2EHooksEnabled()) {
    (globalThis as SpectroliteE2EGlobal).__spectroliteE2E__ = e2e;
  }
  return spectroliteApp;
}
