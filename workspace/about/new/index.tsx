/**
 * New Panel Page - Shell panel for launching panels from workspace.
 * Opens with Cmd/Ctrl+T and displays available panels with a chat prompt input.
 */
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Card, Flex, Heading, Text, Box, Button, TextField, Spinner } from "@radix-ui/themes";
import {
  PlusIcon,
  MagnifyingGlassIcon,
  ChatBubbleIcon,
  PaperPlaneIcon,
  ChevronRightIcon,
} from "@radix-ui/react-icons";
import { buildPanelLink, panel, workspace } from "@workspace/runtime";
import { useIsMobile } from "@workspace/react/responsive";
import { AboutThemeRoot, AboutPage, Section } from "@workspace/about-shared/ui";
import type { WorkspaceTree, WorkspaceNode } from "@workspace/runtime";
import { collectLaunchablePanels } from "./launchablePanels";

function PanelCard({
  node,
  pending,
  disabled,
  onActivate,
}: {
  node: WorkspaceNode;
  pending: boolean;
  disabled: boolean;
  onActivate: (path: string, href: string) => void;
}) {
  const isMobile = useIsMobile();
  const href = buildPanelLink(node.path);
  return (
    <Card asChild>
      <a
        href={href}
        aria-busy={pending || undefined}
        aria-disabled={disabled || undefined}
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          if (!disabled) onActivate(node.path, href);
        }}
        style={{
          textDecoration: "none",
          color: "inherit",
          pointerEvents: disabled ? "none" : undefined,
          opacity: disabled && !pending ? 0.55 : 1,
        }}
      >
        <Flex align="center" justify="between" gap="3">
          <Flex
            align={isMobile ? "start" : "center"}
            direction={isMobile ? "column" : "row"}
            gap={isMobile ? "0" : "3"}
            style={{ minWidth: 0 }}
          >
            <Text weight="medium" size="2">
              {node.launchable?.title ?? node.name}
            </Text>
            <Text size="1" color="gray">
              {node.launchable?.description ?? `Open ${node.launchable?.title ?? node.name}`}
            </Text>
          </Flex>
          {pending ? (
            <Spinner style={{ flexShrink: 0 }} />
          ) : (
            <ChevronRightIcon style={{ flexShrink: 0, color: "var(--gray-8)" }} />
          )}
        </Flex>
      </a>
    </Card>
  );
}

function NewPanelPage() {
  const isMobile = useIsMobile();
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promptInput, setPromptInput] = useState("");
  const [filter, setFilter] = useState("");
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const fetchInFlightRef = useRef<Promise<void> | null>(null);
  const lastFetchStartedAtRef = useRef(0);
  const navigationStartedRef = useRef(false);

  const fetchData = useCallback((force = false): Promise<void> => {
    if (!force && fetchInFlightRef.current) return fetchInFlightRef.current;

    lastFetchStartedAtRef.current = Date.now();
    setLoading(true);
    const request = (async () => {
      try {
        setTree(await workspace.sourceTree());
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
    return panel.onFocus(() => {
      // Initial focus commonly arrives while the mount request is still in
      // flight. Revalidate genuinely returning launchers, but do not issue the
      // same source-tree RPC twice during startup.
      if (Date.now() - lastFetchStartedAtRef.current > 2_000) void fetchData();
    });
  }, [fetchData]);

  const beginNavigation = useCallback((path: string, href: string) => {
    if (navigationStartedRef.current) return;
    navigationStartedRef.current = true;
    setPendingPath(path);
    // Give both compact/mobile and desktop renderers one paint to expose the
    // pending state before the host starts its managed navigation.
    requestAnimationFrame(() => window.location.assign(href));
  }, []);

  const handleNewChat = useCallback(() => {
    const prompt = promptInput.trim();
    if (!prompt || pendingPath) return;
    beginNavigation(
      "panels/chat",
      buildPanelLink("panels/chat", { stateArgs: { initialPrompt: prompt } })
    );
  }, [beginNavigation, pendingPath, promptInput]);

  const panels = useMemo(() => (tree ? collectLaunchablePanels(tree.children) : []), [tree]);

  const filteredPanels = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return panels;
    return panels.filter(
      (node) =>
        node.path.toLowerCase().includes(query) ||
        (node.launchable?.title ?? node.name).toLowerCase().includes(query)
    );
  }, [panels, filter]);

  return (
    <AboutPage icon={<PlusIcon width={20} height={20} />} title="New Panel" maxWidth={640}>
      {/* New chat hero */}
      <Section>
        <Flex align="center" gap="2" mb="3">
          <ChatBubbleIcon style={{ color: "var(--accent-9)" }} />
          <Heading size="3">Start a chat</Heading>
        </Flex>
        <Flex gap="2" direction={isMobile ? "column" : "row"}>
          <TextField.Root
            autoFocus
            size="3"
            style={{ flex: 1 }}
            placeholder="Ask anything to open a new chat..."
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleNewChat()}
          />
          <Button size="3" onClick={handleNewChat} disabled={!promptInput.trim() || !!pendingPath}>
            {pendingPath === "panels/chat" ? <Spinner /> : <PaperPlaneIcon />} Chat
          </Button>
        </Flex>
      </Section>

      {/* Panel list */}
      {loading ? (
        <Flex align="center" justify="center" gap="2" py="6">
          <Spinner />
          <Text color="gray">Loading panels...</Text>
        </Flex>
      ) : error ? (
        <Section>
          <Flex direction="column" gap="3" align="start">
            <Text color="red" size="2">
              Failed to load workspace panels: {error}
            </Text>
            <Button variant="soft" onClick={() => void fetchData(true)}>
              Retry
            </Button>
          </Flex>
        </Section>
      ) : (
        <Box>
          <Flex align="center" justify="between" gap="3" mb="3">
            <Heading size="3">Panels</Heading>
            <TextField.Root
              size="2"
              style={{ width: isMobile ? "50%" : 220 }}
              placeholder="Filter..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filteredPanels[0]) {
                  e.preventDefault();
                  const first = filteredPanels[0];
                  beginNavigation(first.path, buildPanelLink(first.path));
                }
              }}
              aria-label="Filter panels; press Enter to open the first result"
            >
              <TextField.Slot>
                <MagnifyingGlassIcon />
              </TextField.Slot>
            </TextField.Root>
          </Flex>

          {filteredPanels.length > 0 ? (
            <Flex direction="column" gap="2">
              {filteredPanels.map((node) => (
                <PanelCard
                  key={node.path}
                  node={node}
                  pending={pendingPath === node.path}
                  disabled={pendingPath !== null}
                  onActivate={beginNavigation}
                />
              ))}
            </Flex>
          ) : (
            <Text color="gray" size="2">
              {panels.length === 0 ? "No panels found in workspace" : `No panels match "${filter}"`}
            </Text>
          )}
        </Box>
      )}
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
