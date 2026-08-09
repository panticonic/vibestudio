/** One keyboard-first launcher for panels, browser destinations, and Agentic Chat. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Card, Flex, Heading, Spinner, Text, TextArea } from "@radix-ui/themes";
import {
  ChatBubbleIcon,
  ClockIcon,
  EnterIcon,
  GlobeIcon,
  MagicWandIcon,
  PlusIcon,
} from "@radix-ui/react-icons";
import { browserData, buildPanelLink, panel, panelTree, workspace } from "@workspace/runtime";
import type { PanelHandle } from "@workspace/runtime";
import {
  canonicalizeUrlForAddress,
  normalizeBrowserAddressSuggestions,
  type BrowserAddressSuggestion,
} from "@vibestudio/shared/panelChrome";
import type { PanelSourceUsage } from "@vibestudio/shared/panelSearchTypes";
import { useIsMobile, useViewportHeight } from "@workspace/react/responsive";
import { AboutPage, AboutThemeRoot, Section } from "../../packages/about-shared/ui";
import { browserUrlFromEntry } from "./entryIntent";
import {
  collectLaunchablePanelGroups,
  LAUNCHABLE_PANEL_CACHE_KEY,
  parseCachedLaunchablePanelGroups,
  serializeLaunchablePanelGroups,
  type LaunchablePanelGroups,
} from "./launchablePanels";
import {
  autocompleteForSuggestion,
  buildLauncherSuggestions,
  parseLauncherInput,
  type LauncherSuggestion,
  type PanelUsage,
} from "./launcherSuggestions";
import "./launcher.css";

interface NavigationTarget {
  source: string;
  href?: string;
}

interface OpenPanel {
  id: string;
  source: string;
  canonicalSource: string;
  handle: PanelHandle;
}

type DisplaySuggestion = LauncherSuggestion & { openPanel?: OpenPanel };

const PANEL_USAGE_CACHE_KEY = "vibestudio:new-panel-durable-usage";
const CATALOG_REVALIDATE_INTERVAL_MS = 30_000;

function readCachedPanelGroups(): LaunchablePanelGroups | null {
  try {
    return parseCachedLaunchablePanelGroups(localStorage.getItem(LAUNCHABLE_PANEL_CACHE_KEY));
  } catch {
    return null;
  }
}

function cachePanelGroups(groups: LaunchablePanelGroups): void {
  try {
    localStorage.setItem(LAUNCHABLE_PANEL_CACHE_KEY, serializeLaunchablePanelGroups(groups));
  } catch {
    // Catalog caching is optional; sourceTree remains authoritative.
  }
}

function readCachedPanelUsage(): PanelUsage {
  try {
    const cached = JSON.parse(localStorage.getItem(PANEL_USAGE_CACHE_KEY) ?? "null") as {
      version?: unknown;
      usage?: unknown;
    } | null;
    if (cached?.version !== 1 || !cached.usage || typeof cached.usage !== "object") return {};
    return Object.fromEntries(
      Object.entries(cached.usage).filter((entry): entry is [string, PanelUsage[string]] => {
        const value = entry[1] as Partial<PanelUsage[string]> | null;
        return (
          !!value &&
          typeof value.count === "number" &&
          Number.isFinite(value.count) &&
          typeof value.lastUsed === "number" &&
          Number.isFinite(value.lastUsed)
        );
      })
    );
  } catch {
    return {};
  }
}

function cachePanelUsage(usage: PanelUsage): void {
  try {
    localStorage.setItem(PANEL_USAGE_CACHE_KEY, JSON.stringify({ version: 1, usage }));
  } catch {
    // This is only a warm-start projection of durable workspace state.
  }
}

function usageRecord(rows: PanelSourceUsage[]): PanelUsage {
  return Object.fromEntries(
    rows.map((row) => [row.source, { count: row.accessCount, lastUsed: row.lastAccessedAt }])
  );
}

async function readOpenPanels(
  onBatch?: (panels: OpenPanel[]) => void,
  knownRevision?: number | null
): Promise<{ panels: OpenPanel[]; revision: number; unchanged: boolean }> {
  const found: OpenPanel[] = [];
  const pendingParents: string[] = [];
  let revision = 0;
  let unchanged = false;
  const readGroup = async (parentId?: string) => {
    let cursor: string | undefined;
    do {
      const page = parentId
        ? await panelTree.children(parentId, { cursor, limit: 200 })
        : await panelTree.roots({ cursor, limit: 200 });
      if (!parentId && cursor === undefined) {
        revision = page.revision;
        if (knownRevision === revision) {
          unchanged = true;
          return;
        }
      }
      const batch: OpenPanel[] = [];
      for (const entry of page.entries) {
        const source = entry.handle.source;
        const openPanel: OpenPanel = {
          id: entry.node.slotId,
          source,
          canonicalSource:
            entry.handle.kind === "browser"
              ? (canonicalizeUrlForAddress(source) ?? source)
              : source,
          handle: entry.handle,
        };
        found.push(openPanel);
        batch.push(openPanel);
        if (entry.node.childCount > 0) pendingParents.push(entry.node.slotId);
      }
      if (batch.length) onBatch?.(batch);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && found.length < 2_000);
  };
  await readGroup();
  if (unchanged) return { panels: [], revision, unchanged: true };
  while (pendingParents.length && found.length < 2_000) await readGroup(pendingParents.shift()!);
  return { panels: found, revision, unchanged: false };
}

function destinationSource(suggestion: LauncherSuggestion): string | null {
  if (suggestion.kind === "panel") return suggestion.panel.path;
  if (suggestion.kind === "history") return canonicalizeUrlForAddress(suggestion.browser.url);
  if (suggestion.kind === "url") return canonicalizeUrlForAddress(suggestion.url);
  return null;
}

function suggestionLabel(suggestion: LauncherSuggestion): string {
  if (suggestion.kind === "panel") return suggestion.panel.title;
  if (suggestion.kind === "history") return suggestion.browser.title || suggestion.browser.url;
  if (suggestion.kind === "url") return `Open ${suggestion.url}`;
  return `Chat: ${suggestion.prompt}`;
}

function suggestionMeta(suggestion: LauncherSuggestion): string {
  if (suggestion.kind === "panel") return suggestion.panel.description ?? suggestion.panel.path;
  if (suggestion.kind === "history") return suggestion.browser.url;
  if (suggestion.kind === "url") return "New browser panel";
  return "New Agentic Chat";
}

function actionFor(suggestion: DisplaySuggestion): { title: string; detail: string } {
  if (suggestion.openPanel) {
    return { title: `Focus ${suggestionLabel(suggestion)}`, detail: "This panel is already open." };
  }
  if (suggestion.kind === "panel") {
    return {
      title: `Open ${suggestion.panel.title}`,
      detail: suggestion.panel.description ?? suggestion.panel.path,
    };
  }
  if (suggestion.kind === "history") {
    return { title: `Revisit ${suggestionLabel(suggestion)}`, detail: suggestion.browser.url };
  }
  if (suggestion.kind === "url")
    return { title: "Open in a browser panel", detail: suggestion.url };
  return { title: "Start Agentic Chat", detail: "Send this as the opening message." };
}

function panelMonogram(path: string, title: string) {
  const hue = [...path].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 0);
  return (
    <Flex
      align="center"
      justify="center"
      aria-hidden="true"
      style={{
        width: 26,
        height: 26,
        borderRadius: 8,
        flexShrink: 0,
        fontSize: 12,
        fontWeight: 700,
        color: `hsl(${hue} 65% 35%)`,
        background: `hsl(${hue} 75% 88%)`,
      }}
    >
      {title.trim().charAt(0).toUpperCase() || "P"}
    </Flex>
  );
}

function SuggestionIcon({
  suggestion,
  favicon,
}: {
  suggestion: LauncherSuggestion;
  favicon?: string;
}) {
  if (favicon && (suggestion.kind === "history" || suggestion.kind === "url")) {
    return <img src={favicon} alt="" width={22} height={22} style={{ borderRadius: 5 }} />;
  }
  if (suggestion.kind === "panel")
    return panelMonogram(suggestion.panel.path, suggestion.panel.title);
  if (suggestion.kind === "history") return <ClockIcon width={20} height={20} />;
  if (suggestion.kind === "url") return <GlobeIcon width={20} height={20} />;
  return <ChatBubbleIcon width={20} height={20} />;
}

function NewPanelPage() {
  const isMobile = useIsMobile();
  const viewportHeight = useViewportHeight();
  const [panelGroups, setPanelGroups] = useState<LaunchablePanelGroups | null>(
    readCachedPanelGroups
  );
  const [loading, setLoading] = useState(panelGroups === null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [panelUsage, setPanelUsage] = useState<PanelUsage>(readCachedPanelUsage);
  const [openPanels, setOpenPanels] = useState<OpenPanel[]>([]);
  const [browserSuggestions, setBrowserSuggestions] = useState<BrowserAddressSuggestion[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [favicons, setFavicons] = useState<Record<string, string | null>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizeRafRef = useRef(0);
  const historyRequestRef = useRef(0);
  const faviconRequestRef = useRef(0);
  const selectionTouchedRef = useRef(false);
  const navigationStartedRef = useRef(false);
  const lastNavigationRef = useRef<NavigationTarget | null>(null);
  const catalogFetchRef = useRef<Promise<void> | null>(null);
  const lastCatalogFetchRef = useRef(0);
  const liveRefreshRef = useRef(0);
  const liveRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const openTreeRevisionRef = useRef<number | null>(null);

  const parsedInput = useMemo(() => parseLauncherInput(value), [value]);
  const browserUrl = useMemo(
    () => (parsedInput.mode === "all" ? browserUrlFromEntry(parsedInput.query) : null),
    [parsedInput]
  );

  const refreshCatalog = useCallback((force = false): Promise<void> => {
    if (catalogFetchRef.current) return catalogFetchRef.current;
    if (!force && Date.now() - lastCatalogFetchRef.current < CATALOG_REVALIDATE_INTERVAL_MS) {
      return Promise.resolve();
    }
    lastCatalogFetchRef.current = Date.now();
    const request = workspace
      .sourceTree()
      .then((tree) => {
        const groups = collectLaunchablePanelGroups(tree.children);
        setPanelGroups(groups);
        cachePanelGroups(groups);
        setCatalogError(null);
      })
      .catch((cause: unknown) => {
        setCatalogError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setLoading(false);
        if (catalogFetchRef.current === request) catalogFetchRef.current = null;
      });
    catalogFetchRef.current = request;
    return request;
  }, []);

  const refreshLiveData = useCallback(() => {
    if (liveRefreshInFlightRef.current) return;
    const refreshId = ++liveRefreshRef.current;
    // These are independent enhancements. Each publishes as soon as it
    // arrives, so neither can hold the catalog or input interaction back.
    const usageRequest = panelTree
      .sourceUsage(200)
      .then((rows) => {
        if (liveRefreshRef.current !== refreshId) return;
        const usage = usageRecord(rows);
        setPanelUsage(usage);
        cachePanelUsage(usage);
      })
      .catch(() => {
        // Keep the warm cache while the durable service recovers.
      });

    const topologyRequest = readOpenPanels((batch) => {
      if (liveRefreshRef.current !== refreshId) return;
      setOpenPanels((current) => {
        const merged = new Map(current.map((entry) => [entry.id, entry]));
        for (const entry of batch) merged.set(entry.id, entry);
        return [...merged.values()];
      });
    }, openTreeRevisionRef.current)
      .then((result) => {
        if (liveRefreshRef.current !== refreshId || result.unchanged) return;
        openTreeRevisionRef.current = result.revision;
        setOpenPanels(result.panels);
      })
      .catch(() => {
        // Awareness is progressive enhancement; launching remains available.
      });
    const refresh = Promise.allSettled([usageRequest, topologyRequest]).then(() => undefined);
    liveRefreshInFlightRef.current = refresh;
    void refresh.finally(() => {
      if (liveRefreshInFlightRef.current === refresh) liveRefreshInFlightRef.current = null;
    });
  }, []);

  useEffect(() => {
    void refreshCatalog(true);
    let liveDataFrame = requestAnimationFrame(refreshLiveData);
    const offFocus = panel.onFocus(() => {
      void refreshCatalog();
      cancelAnimationFrame(liveDataFrame);
      liveDataFrame = requestAnimationFrame(refreshLiveData);
    });
    const offNavigationError = panel.onChildCreationError(({ error }) => {
      navigationStartedRef.current = false;
      setPendingId(null);
      setNavigationError(error);
    });
    return () => {
      cancelAnimationFrame(liveDataFrame);
      offFocus();
      offNavigationError();
    };
  }, [refreshCatalog, refreshLiveData]);

  useEffect(() => {
    const requestId = ++historyRequestRef.current;
    if (parsedInput.mode === "panels" || parsedInput.mode === "chat") {
      setBrowserSuggestions([]);
      return;
    }
    const timer = window.setTimeout(
      () => {
        const query = parsedInput.query.trim();
        const request = query
          ? browserData.searchHistoryForAutocomplete(query, 60)
          : browserData.getHistory({ limit: 60 });
        void request
          .then((rows) => {
            if (requestId !== historyRequestRef.current) return;
            setBrowserSuggestions(normalizeBrowserAddressSuggestions(rows));
            setHistoryError(false);
          })
          .catch(() => {
            if (requestId !== historyRequestRef.current) return;
            setBrowserSuggestions([]);
            setHistoryError(true);
          });
      },
      parsedInput.query ? 100 : 0
    );
    return () => clearTimeout(timer);
  }, [parsedInput]);

  const baseSuggestions = useMemo(
    () =>
      buildLauncherSuggestions({
        value,
        panels: panelGroups ? [...panelGroups.panels, ...panelGroups.about] : [],
        panelUsage,
        browserSuggestions,
        browserUrl,
      }),
    [browserSuggestions, browserUrl, panelGroups, panelUsage, value]
  );

  const suggestions = useMemo<DisplaySuggestion[]>(() => {
    return baseSuggestions.map((suggestion) => {
      const source = destinationSource(suggestion);
      const openPanel = source
        ? openPanels.find((entry) => entry.source === source || entry.canonicalSource === source)
        : undefined;
      return openPanel ? { ...suggestion, openPanel } : suggestion;
    });
  }, [baseSuggestions, openPanels]);

  useEffect(() => {
    setSelectedId((current) => {
      if (selectionTouchedRef.current && suggestions.some((item) => item.id === current))
        return current;
      return suggestions[0]?.id ?? null;
    });
  }, [suggestions]);

  const selectedIndex = Math.max(
    0,
    suggestions.findIndex((item) => item.id === selectedId)
  );
  const selected = suggestions.find((item) => item.id === selectedId) ?? suggestions[0];
  const completion = autocompleteForSuggestion(value, selected);

  useEffect(() => {
    if (!selected?.id) return;
    const option = document.getElementById(`launcher-${selected.id}`);
    if (typeof option?.scrollIntoView === "function") option.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  useEffect(() => {
    const urls = suggestions.flatMap((item) =>
      item.kind === "history" ? [item.browser.url] : item.kind === "url" ? [item.url] : []
    );
    const missing = [...new Set(urls)].filter((url) => !(url in favicons)).slice(0, 12);
    if (!missing.length) return;
    const requestId = ++faviconRequestRef.current;
    const timer = window.setTimeout(() => {
      void Promise.all(
        missing.map(async (url) => {
          try {
            const icon = await browserData.getPageFavicon(url);
            return [url, icon ? `data:${icon.mime_type};base64,${icon.image_data}` : null] as const;
          } catch {
            return [url, null] as const;
          }
        })
      ).then((entries) => {
        if (requestId === faviconRequestRef.current)
          setFavicons((current) => ({ ...current, ...Object.fromEntries(entries) }));
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [favicons, suggestions]);

  const resizeInput = useCallback(() => {
    cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, isMobile ? 144 : 190)}px`;
    });
  }, [isMobile]);
  useEffect(() => () => cancelAnimationFrame(resizeRafRef.current), []);

  const beginNavigation = useCallback((target: NavigationTarget, id: string) => {
    if (navigationStartedRef.current) return;
    navigationStartedRef.current = true;
    lastNavigationRef.current = target;
    setPendingId(id);
    setNavigationError(null);
    if (target.href) {
      requestAnimationFrame(() => location.assign(target.href!));
      return;
    }
    void panel.reopen({ source: target.source }).catch((cause: unknown) => {
      navigationStartedRef.current = false;
      setPendingId(null);
      setNavigationError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  const activate = useCallback(
    (suggestion: DisplaySuggestion | undefined) => {
      if (!suggestion || pendingId) return;
      if (suggestion.openPanel) {
        setPendingId(suggestion.id);
        void suggestion.openPanel.handle.focus().catch((cause: unknown) => {
          setPendingId(null);
          setNavigationError(cause instanceof Error ? cause.message : String(cause));
        });
        return;
      }
      if (suggestion.kind === "panel") {
        beginNavigation(
          { source: suggestion.panel.path, href: buildPanelLink(suggestion.panel.path) },
          suggestion.id
        );
      } else if (suggestion.kind === "history") {
        beginNavigation({ source: suggestion.browser.url }, suggestion.id);
      } else if (suggestion.kind === "url") {
        beginNavigation({ source: suggestion.url }, suggestion.id);
      } else {
        beginNavigation(
          {
            source: "panels/chat",
            href: buildPanelLink("panels/chat", {
              stateArgs: { initialPrompt: suggestion.prompt },
            }),
          },
          suggestion.id
        );
      }
    },
    [beginNavigation, pendingId]
  );

  const chooseOffset = (offset: number) => {
    if (!suggestions.length) return;
    selectionTouchedRef.current = true;
    const next = (selectedIndex + offset + suggestions.length) % suggestions.length;
    setSelectedId(suggestions[next]!.id);
  };

  const action = selected ? actionFor(selected) : null;
  const actionLabel = selected?.openPanel ? "Focus" : selected?.kind === "chat" ? "Send" : "Open";
  const listMaxHeight = Math.max(150, Math.min(440, viewportHeight - (isMobile ? 335 : 390)));

  return (
    <AboutPage icon={<PlusIcon width={20} height={20} />} title="New Panel" maxWidth={680}>
      <Section>
        <Flex align="center" gap="2" mb="2">
          <GlobeIcon style={{ color: "var(--accent-9)" }} />
          <Heading size="3">Open anything</Heading>
        </Flex>
        <Text as="p" size="2" color="gray" mb="3">
          Search panels and history, enter a web address, or write a request for Agentic Chat.
        </Text>
        <Flex gap="2" mb="2" wrap="wrap" aria-label="Launcher shortcuts">
          <Text size="1" color={parsedInput.mode === "panels" ? undefined : "gray"}>
            <kbd className="launcher-shortcut">&gt;</kbd> panels
          </Text>
          <Text size="1" color={parsedInput.mode === "history" ? undefined : "gray"}>
            <kbd className="launcher-shortcut">@</kbd> history
          </Text>
          <Text size="1" color={parsedInput.mode === "chat" ? undefined : "gray"}>
            <kbd className="launcher-shortcut">/</kbd> chat
          </Text>
        </Flex>
        <Flex gap="2" direction={isMobile ? "column" : "row"}>
          <Box position="relative" style={{ flex: 1, minWidth: 0 }}>
            {completion && !value.includes("\n") ? (
              <Box
                aria-hidden="true"
                position="absolute"
                style={{
                  inset: "11px 12px auto",
                  zIndex: 0,
                  whiteSpace: "pre",
                  pointerEvents: "none",
                  font: "inherit",
                }}
              >
                <span style={{ visibility: "hidden" }}>{value}</span>
                <span style={{ color: "var(--gray-8)" }}>{completion.suffix}</span>
              </Box>
            ) : null}
            <TextArea
              ref={inputRef}
              autoFocus
              role="combobox"
              aria-label="Search panels and history, enter a web address, or start a chat"
              aria-autocomplete="both"
              aria-expanded={suggestions.length > 0}
              aria-controls="launcher-suggestions"
              aria-activedescendant={selected ? `launcher-${selected.id}` : undefined}
              enterKeyHint={selected?.kind === "chat" ? "send" : "go"}
              size="3"
              rows={1}
              style={{
                minHeight: 44,
                maxHeight: isMobile ? 144 : 190,
                resize: "none",
                overflowY: "auto",
                background: "transparent",
                position: "relative",
              }}
              placeholder="Panel, history, address, or ask an agent…"
              value={value}
              onInput={resizeInput}
              onChange={(event) => {
                selectionTouchedRef.current = false;
                setSelectedId(null);
                setValue(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  chooseOffset(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  chooseOffset(-1);
                } else if ((event.key === "Tab" || event.key === "ArrowRight") && completion) {
                  if (event.key === "Tab" || inputRef.current?.selectionStart === value.length) {
                    event.preventDefault();
                    setValue(completion.value);
                    requestAnimationFrame(() =>
                      inputRef.current?.setSelectionRange(
                        completion.value.length,
                        completion.value.length
                      )
                    );
                  }
                } else if (event.key === "Enter" && !event.shiftKey && selected) {
                  event.preventDefault();
                  activate(selected);
                } else if (event.key === "Escape") {
                  selectionTouchedRef.current = false;
                  setSelectedId(suggestions[0]?.id ?? null);
                }
              }}
            />
          </Box>
          <Button size="3" onClick={() => activate(selected)} disabled={!selected || !!pendingId}>
            {pendingId ? <Spinner /> : <EnterIcon />}
            {actionLabel}
          </Button>
        </Flex>
        <Text as="p" size="1" color="gray" mt="2">
          ↑ ↓ choose · Tab or → complete · Enter {actionLabel.toLowerCase()} · Shift+Enter newline
        </Text>
      </Section>

      {selected && action ? (
        <Card
          className="launcher-preview"
          mb="3"
          style={{
            position: isMobile ? "sticky" : "static",
            top: isMobile ? 8 : undefined,
            zIndex: 4,
            background:
              "linear-gradient(135deg, var(--accent-3), color-mix(in srgb, var(--accent-2) 62%, transparent))",
            boxShadow:
              "inset 3px 0 0 var(--accent-9), 0 8px 28px color-mix(in srgb, var(--accent-9) 10%, transparent)",
          }}
        >
          <Flex align="center" justify="between" gap="3">
            <Flex align="center" gap="3" style={{ minWidth: 0 }}>
              <Box style={{ flexShrink: 0, color: "var(--accent-10)" }}>
                {selected.kind === "chat" ? (
                  <MagicWandIcon width={19} height={19} />
                ) : (
                  <SuggestionIcon
                    suggestion={selected}
                    favicon={
                      selected.kind === "history"
                        ? (favicons[selected.browser.url] ?? undefined)
                        : selected.kind === "url"
                          ? (favicons[selected.url] ?? undefined)
                          : undefined
                    }
                  />
                )}
              </Box>
              <Flex direction="column" style={{ minWidth: 0 }}>
                <Text size="1" color="gray" weight="medium">
                  ENTER WILL
                </Text>
                <Text size="3" weight="bold" truncate>
                  {action.title}
                </Text>
                <Text size="1" color="gray" truncate>
                  {action.detail}
                </Text>
              </Flex>
            </Flex>
            <Text size="1" weight="bold" style={{ flexShrink: 0, color: "var(--accent-11)" }}>
              ↵ {actionLabel}
            </Text>
          </Flex>
        </Card>
      ) : null}

      {loading && !panelGroups && !suggestions.length ? (
        <Flex align="center" justify="center" gap="2" py="5">
          <Spinner />
          <Text color="gray">Loading destinations…</Text>
        </Flex>
      ) : suggestions.length ? (
        <Box>
          <Flex align="center" justify="between" mb="2">
            <Text size="1" color="gray" weight="bold">
              {parsedInput.mode === "all"
                ? parsedInput.query.trim()
                  ? "BEST MATCHES"
                  : "FREQUENT DESTINATIONS"
                : `${parsedInput.mode.toUpperCase()} MODE`}
            </Text>
            <Text size="1" color="gray">
              {suggestions.length} {suggestions.length === 1 ? "option" : "options"}
            </Text>
          </Flex>
          <Flex
            id="launcher-suggestions"
            role="listbox"
            aria-label="Open suggestions"
            direction="column"
            gap="2"
            style={{ overflowY: "auto", maxHeight: listMaxHeight, scrollPadding: 8 }}
          >
            {suggestions.map((suggestion) => {
              const isSelected = suggestion.id === selected?.id;
              const favicon =
                suggestion.kind === "history"
                  ? favicons[suggestion.browser.url]
                  : suggestion.kind === "url"
                    ? favicons[suggestion.url]
                    : undefined;
              return (
                <Card asChild key={suggestion.id}>
                  <button
                    className="launcher-suggestion"
                    id={`launcher-${suggestion.id}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={!!pendingId}
                    onMouseEnter={() => {
                      selectionTouchedRef.current = true;
                      setSelectedId(suggestion.id);
                    }}
                    onClick={() => activate(suggestion)}
                    style={{
                      width: "100%",
                      border: 0,
                      textAlign: "left",
                      color: "inherit",
                      cursor: pendingId ? "default" : "pointer",
                      background: isSelected ? "var(--accent-3)" : undefined,
                      boxShadow: isSelected ? "inset 0 0 0 1px var(--accent-7)" : undefined,
                      transform: isSelected ? "translateX(2px)" : "translateX(0)",
                    }}
                  >
                    <Flex align="center" justify="between" gap="3">
                      <Flex align="center" gap="3" style={{ minWidth: 0 }}>
                        <Box style={{ flexShrink: 0, color: "var(--accent-9)" }}>
                          <SuggestionIcon suggestion={suggestion} favicon={favicon ?? undefined} />
                        </Box>
                        <Flex direction="column" style={{ minWidth: 0 }}>
                          <Text weight="medium" size="2" truncate>
                            {suggestionLabel(suggestion)}
                          </Text>
                          <Text size="1" color="gray" truncate>
                            {suggestionMeta(suggestion)}
                          </Text>
                        </Flex>
                      </Flex>
                      <Flex gap="2" align="center" style={{ flexShrink: 0 }}>
                        {suggestion.openPanel ? (
                          <Text size="1" color="green" weight="bold">
                            Already open
                          </Text>
                        ) : null}
                        <Text size="1" color="gray">
                          {suggestion.kind === "panel"
                            ? "Panel"
                            : suggestion.kind === "history"
                              ? "History"
                              : suggestion.kind === "url"
                                ? "Website"
                                : "Chat"}
                        </Text>
                      </Flex>
                    </Flex>
                  </button>
                </Card>
              );
            })}
          </Flex>
        </Box>
      ) : (
        <Card>
          <Text color="gray" size="2">
            No matches here. Try another term or remove <kbd>{parsedInput.prefix}</kbd> to search
            everything.
          </Text>
        </Card>
      )}

      {catalogError ? (
        <Text color={panelGroups ? "orange" : "red"} size="2" mt="3">
          Panel suggestions may be out of date.{" "}
          <Button variant="ghost" size="1" onClick={() => void refreshCatalog(true)}>
            Retry
          </Button>
        </Text>
      ) : null}
      {historyError ? (
        <Text color="orange" size="2" mt="2">
          Browser history is temporarily unavailable.
        </Text>
      ) : null}
      {navigationError ? (
        <Section>
          <Flex direction="column" gap="2" align="start">
            <Text color="red" size="2">
              Couldn&apos;t open that destination: {navigationError}
            </Text>
            <Button
              variant="soft"
              color="red"
              onClick={() => {
                const target = lastNavigationRef.current;
                if (target && selected) beginNavigation(target, selected.id);
              }}
            >
              Try again
            </Button>
          </Flex>
        </Section>
      ) : null}
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <NewPanelPage />
    </AboutThemeRoot>
  );
}
