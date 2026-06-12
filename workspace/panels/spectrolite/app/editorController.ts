/**
 * Editor controller — owns the open-file buffers and the flush pipeline.
 *
 * Flush: write buffer to disk (always — disk is the source of truth),
 * then if the channel is connected compute the diff vs the last flushed
 * snapshot, publish `kb.user_edit`, and on @-mention send a parallel chat
 * message with the diff inlined so the agent reacts without re-reading.
 *
 * Also tracks the active doc's frontmatter `dependencies:` map and
 * prefetches new entries into the sandbox module map (debounced — the
 * old implementation re-parsed frontmatter on every keystroke).
 */

import { setStateArgs, contextId as runtimeContextId } from "@workspace/runtime";
import type { Store } from "./store";
import type { SpectroliteState, MentionDeliveryNotice } from "./state";
import { createFlushController, type FlushController } from "../flush/flush-controller";
import { buildFlushPayload } from "../flush/diff";
import { createBufferEntry, hasUnflushedChanges, type FileBufferEntry } from "../state/fileBuffer";
import { KB_USER_EDIT_TYPE } from "../messages/register";
import { buildMentionDeliveryMessage } from "../messages/mention-delivery";
import { wikilinksFromJsx } from "../mdx/wikilink";
import { parseFrontmatter, diffDependencies, isStateOnlyChange } from "../mdx/frontmatter";
import { writeBufferToDisk } from "../components/DocumentEditor";

const DEPS_CHECK_DEBOUNCE_MS = 700;

export const PANEL_HANDLE = "spectrolite";

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export interface EditorControllerHooks {
  /** Files on disk changed — refresh path index + git status. */
  onDiskChanged(): void;
}

export class EditorController {
  private readonly flushController: FlushController;
  private depsTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDeps: Record<string, string> = {};
  private prefetchDeps: ((deps: Record<string, string>) => Promise<void>) | null = null;

  constructor(
    private readonly store: Store<SpectroliteState>,
    private readonly hooks: EditorControllerHooks,
  ) {
    this.flushController = createFlushController({ onFlush: (path) => this.flush(path) });
  }

  /** Wired by the session once the sandbox exists. */
  setDepsPrefetcher(prefetch: (deps: Record<string, string>) => Promise<void>): void {
    this.prefetchDeps = prefetch;
  }

  openFile(path: string): void {
    const state = this.store.getState();
    if (state.activePath === path) return;
    this.store.setState((prev) => ({
      activePath: path,
      recentPaths: [path, ...prev.recentPaths.filter((p) => p !== path)].slice(0, 12),
    }));
    void setStateArgs({ openPath: path });
    const buffer = state.buffers[path];
    this.syncActiveDeps(buffer?.currentMdx ?? null);
  }

  /** The user typed in the editor. */
  editorChanged(path: string, next: string): void {
    this.store.setState((prev) => {
      const cur = prev.buffers[path];
      if (!cur || cur.currentMdx === next) return {};
      return { buffers: { ...prev.buffers, [path]: { ...cur, currentMdx: next } } };
    });
    this.flushController.noteChange(path);
    this.scheduleDepsCheck(path);
  }

  /** The editor (re)loaded content from disk — buffer snapshots reset. */
  editorReloaded(path: string, content: string): void {
    this.store.setState((prev) => {
      const cur = prev.buffers[path];
      const entry: FileBufferEntry = cur
        ? { ...cur, savedMdx: content, currentMdx: content, lastFlushedMdx: content }
        : createBufferEntry(path, content);
      return {
        buffers: { ...prev.buffers, [path]: entry },
        saveErrors: withoutKey(prev.saveErrors, path),
      };
    });
    if (this.store.getState().activePath === path) this.syncActiveDeps(content);
    // A reload can mean an agent wrote the file — keep git status honest.
    this.hooks.onDiskChanged();
  }

  flushNow(path: string): void {
    this.flushController.flushNow(path);
  }

  async flushAllDirty(): Promise<void> {
    const dirty = Object.values(this.store.getState().buffers).filter(hasUnflushedChanges);
    for (const entry of dirty) {
      await this.flush(entry.path);
    }
  }

  /** Best-effort disk write of every dirty buffer (teardown path — no channel work). */
  async writeDirtyToDisk(root: string | null): Promise<void> {
    if (!root) return;
    const dirty = Object.values(this.store.getState().buffers).filter(hasUnflushedChanges);
    await Promise.all(dirty.map(async (entry) => {
      try {
        await writeBufferToDisk(root, entry.path, entry.currentMdx);
      } catch (err) {
        console.warn(`[Spectrolite] teardown write failed for ${entry.path}:`, err);
      }
    }));
  }

  /** Drop all buffers (vault switched). Pending flush timers are discarded —
   *  firing them here would write old-vault buffers against the new root. */
  reset(): void {
    this.flushController.cancelPending();
    this.store.setState({ buffers: {}, lastFlushedAt: {}, activeDeps: {}, saveErrors: {} });
    this.lastDeps = {};
    if (this.depsTimer) {
      clearTimeout(this.depsTimer);
      this.depsTimer = null;
    }
  }

  dispose(): void {
    this.flushController.flushPending();
    this.flushController.dispose();
    if (this.depsTimer) clearTimeout(this.depsTimer);
    void this.writeDirtyToDisk(this.store.getState().repoRoot);
  }

  private async flush(relPath: string): Promise<void> {
    const state = this.store.getState();
    const entry = state.buffers[relPath];
    const root = state.repoRoot;
    if (!entry || !root || !hasUnflushedChanges(entry)) return;

    const before = entry.lastFlushedMdx;
    const after = entry.currentMdx;
    // Disk write is unconditional — losing it because the channel isn't
    // connected would be data loss.
    try {
      await writeBufferToDisk(root, relPath, after);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Spectrolite] write failed for ${relPath}:`, err);
      this.store.setState((prev) => ({
        saveErrors: {
          ...prev.saveErrors,
          [relPath]: { path: relPath, message, at: Date.now() },
        },
      }));
      return;
    }

    const client = this.store.getState().client;
    const knownHandles = client
      ? Object.values(client.roster)
        .map((p) => (p.metadata as { handle?: string }).handle)
        .filter((h): h is string => Boolean(h) && h !== PANEL_HANDLE)
      : [];
    const beforeOnDisk = wikilinksFromJsx(before);
    const afterOnDisk = wikilinksFromJsx(after);
    const payload = buildFlushPayload({ path: relPath, before: beforeOnDisk, after: afterOnDisk, knownHandles });
    const flushedAt = payload?.at ?? Date.now();

    // Mark the buffer flushed even when the on-disk forms compare equal
    // (payload === null) — otherwise hasUnflushedChanges stays true and we
    // re-flush the same null-diff on every quiescence.
    this.store.setState((prev) => {
      const cur = prev.buffers[relPath];
      if (!cur) return {};
      return {
        buffers: { ...prev.buffers, [relPath]: { ...cur, savedMdx: after, lastFlushedMdx: after } },
        lastFlushedAt: { ...prev.lastFlushedAt, [relPath]: flushedAt },
        saveErrors: withoutKey(prev.saveErrors, relPath),
      };
    });
    this.hooks.onDiskChanged();

    if (!payload || !client) return;

    // Suppress the channel notification when this flush is just component
    // state churn (sliders, toggles). Disk already has current state; we
    // just don't spam the channel with kb.user_edit + @-mention per click.
    if (isStateOnlyChange(beforeOnDisk, afterOnDisk)) return;

    try {
      await client.publishCustomMessage({
        typeId: KB_USER_EDIT_TYPE,
        initialState: {
          path: relPath,
          unifiedDiff: payload.unifiedDiff,
          addedLines: payload.addedLines,
          removedLines: payload.removedLines,
          mentions: payload.mentions,
          at: payload.at,
          editorContextId: runtimeContextId,
        },
        displayMode: "row",
      });
    } catch (err) {
      console.warn("[Spectrolite] kb.user_edit publish failed:", err);
    }

    // Mentioned-agent fast path: a normal chat message with the diff
    // inlined so the agent's mention-respond policy fires with context.
    const mentionMessage = buildMentionDeliveryMessage({
      path: relPath,
      mentions: payload.mentions,
      unifiedDiff: payload.unifiedDiff,
    });
    if (!mentionMessage) return;
    let notice: MentionDeliveryNotice;
    try {
      await client.send(mentionMessage.content, { mentions: mentionMessage.mentions });
      notice = { state: "sent", path: relPath, handles: mentionMessage.mentions, at: Date.now() };
    } catch (err) {
      console.warn("[Spectrolite] mention send failed:", err);
      notice = {
        state: "failed",
        path: relPath,
        handles: mentionMessage.mentions,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.store.setState({ mentionDeliveryNotice: notice });
  }

  // ---- frontmatter dependency tracking ----

  private scheduleDepsCheck(path: string): void {
    if (this.store.getState().activePath !== path) return;
    if (this.depsTimer) clearTimeout(this.depsTimer);
    this.depsTimer = setTimeout(() => {
      this.depsTimer = null;
      const state = this.store.getState();
      const buffer = state.activePath ? state.buffers[state.activePath] : undefined;
      this.syncActiveDeps(buffer?.currentMdx ?? null);
    }, DEPS_CHECK_DEBOUNCE_MS);
  }

  private syncActiveDeps(mdx: string | null): void {
    if (mdx === null) {
      this.lastDeps = {};
      this.store.setState({ activeDeps: {} });
      return;
    }
    const next = parseFrontmatter(mdx).dependencies;
    const { added, changed, removed } = diffDependencies(this.lastDeps, next);
    if (Object.keys(added).length === 0 && Object.keys(changed).length === 0 && removed.length === 0) return;
    this.lastDeps = next;
    this.store.setState({ activeDeps: next });
    const toFetch = { ...added, ...changed };
    if (Object.keys(toFetch).length > 0 && this.prefetchDeps) {
      void this.prefetchDeps(toFetch).catch((err) => {
        console.warn("[Spectrolite] dependency prefetch failed:", err);
      });
    }
  }
}
