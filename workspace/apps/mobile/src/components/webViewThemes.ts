import type { PanelWebViewHandle } from "./PanelWebView";
import type { WebViewEntry } from "./webViewStack";

type ThemeMode = "light" | "dark";

/**
 * Synchronize theme only when a managed WebView's document or theme changed.
 * Activity timestamps intentionally do not participate in the signature.
 */
export function syncManagedWebViewThemes(
  entries: readonly WebViewEntry[],
  handles: ReadonlyMap<string, PanelWebViewHandle | null>,
  syncedSignatures: Map<string, string>,
  mode: ThemeMode
): void {
  for (const entry of entries) {
    if (!entry.managed) continue;
    const handle = handles.get(entry.panelId);
    if (!handle) continue;
    const signature = `${mode}\u0000${entry.url}`;
    if (syncedSignatures.get(entry.panelId) === signature) continue;
    handle.injectTheme(mode);
    syncedSignatures.set(entry.panelId, signature);
  }
}
