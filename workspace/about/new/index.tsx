/**
 * New Panel Page - Shell panel for launching panels from workspace.
 * Opens with Cmd/Ctrl+T and provides one launcher for panels, history, URLs, and chat.
 */
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Card, Flex, Heading, Text, Box, Button, TextArea, Spinner } from "@radix-ui/themes";
import {
  PlusIcon,
  ChatBubbleIcon,
  GlobeIcon,
  ClockIcon,
  DashboardIcon,
  EnterIcon,
  MagicWandIcon,
} from "@radix-ui/react-icons";
import { browserData, buildPanelLink, panel, workspace } from "@workspace/runtime";
import {
  canonicalizeUrlForAddress,
  mergeBrowserAddressSuggestions,
  normalizeBrowserAddressSuggestions,
  type BrowserAddressSuggestion,
} from "@vibestudio/shared/panelChrome";
import { useIsMobile } from "@workspace/react/responsive";
import { AboutThemeRoot, AboutPage, Section } from "../../packages/about-shared/ui";
import {
  collectLaunchablePanelGroups,
  LAUNCHABLE_PANEL_CACHE_KEY,
  parseCachedLaunchablePanelGroups,
  serializeLaunchablePanelGroups,
  type LaunchablePanel,
  type LaunchablePanelGroups,
} from "./launchablePanels";
import { browserUrlFromEntry } from "./entryIntent";
import {
  PANEL_USAGE_CACHE_KEY,
  parsePanelUsage,
  rankLaunchablePanels,
  recordPanelUsage,
  serializePanelUsage,
  type PanelUsage,
} from "./launcherSuggestions";

interface NavigationTarget {
  source: string;
  href?: string;
}

type LauncherSuggestion =
  | { id: string; kind: "panel"; panel: LaunchablePanel }
  | { id: string; kind: "history"; browser: BrowserAddressSuggestion }
  | { id: string; kind: "url"; url: string }
  | { id: string; kind: "chat"; prompt: string };

function readCachedPanelGroups(): LaunchablePanelGroups | null {
  try {
    return parseCachedLaunchablePanelGroups(
      window.localStorage.getItem(LAUNCHABLE_PANEL_CACHE_KEY)
    );
  } catch {
    return null;
  }
}

function cachePanelGroups(groups: LaunchablePanelGroups): void {
  try {
    window.localStorage.setItem(LAUNCHABLE_PANEL_CACHE_KEY, serializeLaunchablePanelGroups(groups));
  } catch {
    // Storage is an optimization; the authoritative source-tree read still works without it.
  }
}

function readPanelUsage(): PanelUsage {
  try {
    return parsePanelUsage(window.localStorage.getItem(PANEL_USAGE_CACHE_KEY));
  } catch {
    return {};
  }
}

function suggestionLabel(suggestion: LauncherSuggestion): string {
  if (suggestion.kind === "panel") return suggestion.panel.title;
  if (suggestion.kind === "history") return suggestion.browser.title || suggestion.browser.url;
  if (suggestion.kind === "url") return `Open ${suggestion.url}`;
  return `Chat: ${suggestion.prompt}`;
}

function suggestionMeta(suggestion: LauncherSuggestion): string {
  if (suggestion.kind === "panel") {
    return suggestion.panel.description ?? suggestion.panel.path;
  }
  if (suggestion.kind === "history") return suggestion.browser.url;
  if (suggestion.kind === "url") return "Browser panel";
  return "New chat";
}

function suggestionAction(suggestion: LauncherSuggestion): { title: string; detail: string } {
  if (suggestion.kind === "panel") {
    return {
      title: `Open ${suggestion.panel.title}`,
      detail: suggestion.panel.description ?? suggestion.panel.path,
    };
  }
  if (suggestion.kind === "history") {
    return {
      title: `Revisit ${suggestion.browser.title || suggestion.browser.url}`,
      detail: suggestion.browser.url,
    };
  }
  if (suggestion.kind === "url") {
    return { title: "Open in a browser panel", detail: suggestion.url };
  }
  return { title: "Start Agentic Chat", detail: "Send this message as the opening prompt." };
}

function SuggestionIcon({ kind }: { kind: LauncherSuggestion["kind"] }) {
  if (kind === "panel") return <DashboardIcon />;
  if (kind === "history") return <ClockIcon />;
  if (kind === "url") return <GlobeIcon />;
  return <ChatBubbleIcon />;
}

function NewPanelPage() {
  const isMobile = useIsMobile();
  const [panelGroups, setPanelGroups] = useState<LaunchablePanelGroups | null>(
    readCachedPanelGroups
  );
  const [loading, setLoading] = useState(panelGroups === null);
  const [error, setError] = useState<string | null>(null);
  const [promptInput, setPromptInput] = useState("");
  const [panelUsage, setPanelUsage] = useState<PanelUsage>(readPanelUsage);
  const [browserSuggestions, setBrowserSuggestions] = useState<BrowserAddressSuggestion[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const fetchInFlightRef = useRef<Promise<void> | null>(null);
  const hasPanelGroupsRef = useRef(panelGroups !== null);
  const lastFetchStartedAtRef = useRef(0);
  const navigationStartedRef = useRef(false);
  const lastNavigationRef = useRef<NavigationTarget | null>(null);
  const historyRequestRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizeRafRef = useRef(0);

  const resizeInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(resizeRafRef.current), []);

  const fetchData = useCallback((): Promise<void> => {
    if (fetchInFlightRef.current) return fetchInFlightRef.current;

    lastFetchStartedAtRef.current = Date.now();
    if (!hasPanelGroupsRef.current) setLoading(true);
    const request = (async () => {
      try {
        const groups = collectLaunchablePanelGroups((await workspace.sourceTree()).children);
        hasPanelGroupsRef.current = true;
        setPanelGroups(groups);
        cachePanelGroups(groups);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
    fetchInFlightRef.current = request;
    void request.finally(() => {
      if (fetchInFlightRef.current === request) fetchInFlightRef.current = null;
    });
    return request;
  }, []);

  useEffect(() => {
    void fetchData();
    const offFocus = panel.onFocus(() => {
      // Initial focus commonly arrives while the mount request is still in
      // flight. Revalidate genuinely returning launchers, but do not issue the
      // same source-tree RPC twice during startup.
      if (Date.now() - lastFetchStartedAtRef.current > 2_000) void fetchData();
    });
    const offNavigationError = panel.onChildCreationError(({ url, error }) => {
      const target = lastNavigationRef.current;
      if (!target?.href || !url.includes(`/${target.source}/`)) return;
      navigationStartedRef.current = false;
      setPendingPath(null);
      setNavigationError(error);
    });
    return () => {
      offFocus();
      offNavigationError();
    };
  }, [fetchData]);

  useEffect(() => {
    const requestId = ++historyRequestRef.current;
    const timer = window.setTimeout(
      () => {
        const query = promptInput.trim();
        const request = query
          ? browserData.searchHistoryForAutocomplete(query, 50)
          : browserData.getHistory({ limit: 50 });
        void request
          .then((rows) => {
            if (historyRequestRef.current !== requestId) return;
            setBrowserSuggestions(normalizeBrowserAddressSuggestions(rows));
            setHistoryError(null);
          })
          .catch((cause: unknown) => {
            if (historyRequestRef.current !== requestId) return;
            setBrowserSuggestions([]);
            setHistoryError(cause instanceof Error ? cause.message : String(cause));
          });
      },
      promptInput ? 120 : 0
    );
    return () => window.clearTimeout(timer);
  }, [promptInput]);

  const beginNavigation = useCallback((target: NavigationTarget) => {
    if (navigationStartedRef.current) return;
    navigationStartedRef.current = true;
    lastNavigationRef.current = target;
    setPendingPath(target.source);
    setNavigationError(null);
    if (target.href) {
      // Keep anchor hrefs for normal browser affordances, but let the trusted
      // host translate the managed URL into a panel navigation.
      requestAnimationFrame(() => window.location.assign(target.href!));
      return;
    }

    void panel.reopen({ source: target.source }).catch((error: unknown) => {
      navigationStartedRef.current = false;
      setPendingPath(null);
      setNavigationError(error instanceof Error ? error.message : String(error));
    });
  }, []);

  const browserUrl = useMemo(() => browserUrlFromEntry(promptInput), [promptInput]);

  const suggestions = useMemo<LauncherSuggestion[]>(() => {
    const query = promptInput.trim();
    const panels = panelGroups ? [...panelGroups.panels, ...panelGroups.about] : [];
    const panelMatches = rankLaunchablePanels(panels, query, panelUsage, query ? 4 : 5).map(
      (launchable): LauncherSuggestion => ({
        id: `panel:${launchable.path}`,
        kind: "panel",
        panel: launchable,
      })
    );
    const directCanonical = browserUrl ? canonicalizeUrlForAddress(browserUrl) : null;
    const historyMatches = mergeBrowserAddressSuggestions(
      [browserSuggestions],
      query,
      query ? 4 : 5
    )
      .filter(
        (suggestion) =>
          !directCanonical || canonicalizeUrlForAddress(suggestion.url) !== directCanonical
      )
      .map(
        (browser): LauncherSuggestion => ({
          id: `history:${browser.url}`,
          kind: "history",
          browser,
        })
      );

    return [
      ...(browserUrl
        ? ([{ id: `url:${browserUrl}`, kind: "url", url: browserUrl }] as LauncherSuggestion[])
        : []),
      ...panelMatches,
      ...historyMatches,
      ...(!browserUrl && query
        ? ([{ id: `chat:${query}`, kind: "chat", prompt: query }] as LauncherSuggestion[])
        : []),
    ].slice(0, 10);
  }, [browserSuggestions, browserUrl, panelGroups, panelUsage, promptInput]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [promptInput]);

  useEffect(() => {
    if (selectedIndex >= suggestions.length) {
      setSelectedIndex(Math.max(0, suggestions.length - 1));
    }
  }, [selectedIndex, suggestions.length]);

  const activateSuggestion = useCallback(
    (suggestion: LauncherSuggestion | undefined) => {
      if (!suggestion || pendingPath) return;
      if (suggestion.kind === "url") {
        beginNavigation({ source: suggestion.url });
        return;
      }
      if (suggestion.kind === "history") {
        beginNavigation({ source: suggestion.browser.url });
        return;
      }
      if (suggestion.kind === "chat") {
        beginNavigation({
          source: "panels/chat",
          href: buildPanelLink("panels/chat", {
            stateArgs: { initialPrompt: suggestion.prompt },
          }),
        });
        return;
      }

      const nextUsage = recordPanelUsage(panelUsage, suggestion.panel.path, Date.now());
      setPanelUsage(nextUsage);
      try {
        window.localStorage.setItem(PANEL_USAGE_CACHE_KEY, serializePanelUsage(nextUsage));
      } catch {
        // Usage only improves ordering; navigation does not depend on storage.
      }
      beginNavigation({
        source: suggestion.panel.path,
        href: buildPanelLink(suggestion.panel.path),
      });
    },
    [beginNavigation, panelUsage, pendingPath]
  );

  const selectedSuggestion = suggestions[selectedIndex];
  const selectedAction = selectedSuggestion ? suggestionAction(selectedSuggestion) : null;

  return (
    <AboutPage icon={<PlusIcon width={20} height={20} />} title="New Panel" maxWidth={640}>
      <Section>
        <Flex align="center" gap="2" mb="3">
          <GlobeIcon style={{ color: "var(--accent-9)" }} />
          <Heading size="3">Open anything</Heading>
        </Flex>
        <Text as="p" size="2" color="gray" mb="3">
          Search panels and browser history, enter a web address, or start a chat. Frequently used
          destinations appear first.
        </Text>
        <Flex gap="2" direction={isMobile ? "column" : "row"}>
          <TextArea
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-label="Search panels and history, enter a web address, or start a chat"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls="launcher-suggestions"
            aria-activedescendant={
              selectedSuggestion ? "launcher-suggestion-" + selectedIndex : undefined
            }
            size="3"
            rows={1}
            style={{
              flex: 1,
              minHeight: 42,
              maxHeight: isMobile ? 140 : 180,
              resize: "none",
              overflowY: "auto",
            }}
            placeholder="Search panels or history, enter an address, or ask an agent..."
            value={promptInput}
            onInput={resizeInput}
            onChange={(event) => {
              setPromptInput(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && suggestions.length > 1) {
                event.preventDefault();
                setSelectedIndex((current) => (current + 1) % suggestions.length);
              } else if (event.key === "ArrowUp" && suggestions.length > 1) {
                event.preventDefault();
                setSelectedIndex(
                  (current) => (current - 1 + suggestions.length) % suggestions.length
                );
              } else if (event.key === "Enter" && !event.shiftKey && selectedSuggestion) {
                event.preventDefault();
                activateSuggestion(selectedSuggestion);
              } else if (event.key === "Escape") {
                setSelectedIndex(0);
              }
            }}
          />
          <Button
            size="3"
            onClick={() => activateSuggestion(selectedSuggestion)}
            disabled={!selectedSuggestion || !!pendingPath}
          >
            {pendingPath ? <Spinner /> : <EnterIcon />}
            {selectedSuggestion?.kind === "chat" ? "Start chat" : "Open"}
          </Button>
        </Flex>
        <Flex align="center" justify="between" mt="2" gap="3" wrap="wrap">
          <Text size="1" color="gray">
            ↑ ↓ choose · Enter confirm · Shift+Enter newline
          </Text>
        </Flex>
      </Section>

      {selectedSuggestion && selectedAction ? (
        <Card
          mb="3"
          style={{
            background:
              "linear-gradient(135deg, var(--accent-3), color-mix(in srgb, var(--accent-2) 65%, transparent))",
            boxShadow: "inset 3px 0 0 var(--accent-9)",
          }}
        >
          <Flex align="center" justify="between" gap="3">
            <Flex align="center" gap="3" style={{ minWidth: 0 }}>
              <Box style={{ flexShrink: 0, color: "var(--accent-10)" }}>
                {selectedSuggestion.kind === "chat" ? (
                  <MagicWandIcon width={18} height={18} />
                ) : (
                  <SuggestionIcon kind={selectedSuggestion.kind} />
                )}
              </Box>
              <Flex direction="column" style={{ minWidth: 0 }}>
                <Text size="1" color="gray" weight="medium">
                  ENTER WILL
                </Text>
                <Text size="3" weight="bold" truncate>
                  {selectedAction.title}
                </Text>
                <Text size="1" color="gray" truncate>
                  {selectedAction.detail}
                </Text>
              </Flex>
            </Flex>
            <Text size="1" weight="bold" style={{ flexShrink: 0, color: "var(--accent-11)" }}>
              ↵ Enter
            </Text>
          </Flex>
        </Card>
      ) : null}

      {loading && !panelGroups && suggestions.length === 0 ? (
        <Flex align="center" justify="center" gap="2" py="5">
          <Spinner />
          <Text color="gray">Loading suggestions...</Text>
        </Flex>
      ) : suggestions.length ? (
        <Box>
          <Flex align="center" justify="between" mb="2">
            <Text size="1" color="gray" weight="bold">
              {promptInput.trim() ? "MATCHING DESTINATIONS" : "FREQUENT DESTINATIONS"}
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
          >
            {suggestions.map((suggestion, index) => {
              const selected = index === selectedIndex;
              return (
                <Card asChild key={suggestion.id}>
                  <button
                    id={"launcher-suggestion-" + index}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={pendingPath !== null}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => activateSuggestion(suggestion)}
                    style={{
                      width: "100%",
                      border: 0,
                      textAlign: "left",
                      color: "inherit",
                      cursor: pendingPath ? "default" : "pointer",
                      background: selected ? "var(--accent-3)" : undefined,
                      boxShadow: selected ? "inset 0 0 0 1px var(--accent-7)" : undefined,
                      transition: "background 120ms ease, box-shadow 120ms ease",
                    }}
                  >
                    <Flex align="center" justify="between" gap="3">
                      <Flex align="center" gap="3" style={{ minWidth: 0 }}>
                        <Box style={{ flexShrink: 0, color: "var(--accent-9)" }}>
                          <SuggestionIcon kind={suggestion.kind} />
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
                      <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                        {suggestion.kind === "panel"
                          ? "Panel"
                          : suggestion.kind === "history"
                            ? "History"
                            : suggestion.kind === "url"
                              ? "Website"
                              : "Chat"}
                      </Text>
                    </Flex>
                  </button>
                </Card>
              );
            })}
          </Flex>
        </Box>
      ) : (
        <Text color="gray" size="2">
          No matching panels or browser history.
        </Text>
      )}

      {error ? (
        <Text color={panelGroups ? "orange" : "red"} size="2" mt="3">
          {panelGroups ? "The saved panel list may be out of date." : "Panels are unavailable."}{" "}
          <Button variant="ghost" size="1" onClick={() => void fetchData()}>
            Retry
          </Button>
        </Text>
      ) : null}
      {historyError ? (
        <Text color="orange" size="2" mt="2">
          Browser history suggestions are unavailable.
        </Text>
      ) : null}
      {navigationError ? (
        <Section>
          <Flex direction="column" gap="2" align="start">
            <Text color="red" size="2">
              Couldn&apos;t open the selection: {navigationError}
            </Text>
            <Button
              variant="soft"
              color="red"
              onClick={() => {
                const target = lastNavigationRef.current;
                if (target) beginNavigation(target);
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
