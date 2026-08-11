import { useCallback, useEffect, useState } from "react";
import { Box, Button, Flex, Spinner, Text } from "@radix-ui/themes";
import { VibestudioLogo } from "@workspace/ui";
import type { PanelPresentationSnapshot } from "@vibestudio/shared/panel/presentation";

import { panel as panelService, view } from "../shell/client";
import { useDirectShellEvent } from "../shell/useDirectShellEvent";
import { PanelSurface } from "./PanelSurface";
import { nativeSlotIdForPane } from "../layout/types";

interface PaneContentProps {
  paneId: string;
  panelId: string;
  resident: boolean;
  focused: boolean;
  layoutEpoch: number;
  unresponsive: boolean;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
}

function CenteredState({
  state,
  panelId,
  children,
}: {
  state: string;
  panelId: string;
  children: React.ReactNode;
}) {
  return (
    <Flex
      data-panel-content-state={state}
      data-panel-id={panelId}
      direction="column"
      align="center"
      justify="center"
      gap="3"
      height="100%"
      p="4"
    >
      {children}
    </Flex>
  );
}

export function PaneContent({
  paneId,
  panelId,
  resident,
  focused,
  layoutEpoch,
  unresponsive,
  onDismissUnresponsive,
  onFocusPane,
}: PaneContentProps) {
  const [snapshot, setSnapshot] = useState<PanelPresentationSnapshot | null>(null);
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  useDirectShellEvent(
    "panel-local-presentation-changed",
    useCallback(
      (next) => {
        if (next.presentation.slotId !== panelId) return;
        setSnapshot((current) => (!current || next.revision > current.revision ? next : current));
      },
      [panelId]
    )
  );

  useEffect(() => {
    let live = true;
    setSnapshot(null);
    // The event listener above is installed first. Revisions close the
    // subscribe/query race without polling or a second readiness predicate.
    void panelService
      .getLocalPresentation(panelId)
      .then((next) => {
        if (!live) return;
        setSnapshot((current) => (!current || next.revision > current.revision ? next : current));
      })
      .catch((error: unknown) => {
        if (live) setActionError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [panelId]);

  const presentation = snapshot?.presentation ?? { state: "idle" as const, slotId: panelId };

  useEffect(() => {
    setActionError(null);
    setSlow(false);
    if (presentation.state !== "loading") return;
    const elapsed = Math.max(0, Date.now() - presentation.enteredAt);
    const timer = window.setTimeout(() => setSlow(true), Math.max(0, 60_000 - elapsed));
    return () => window.clearTimeout(timer);
  }, [presentation.state, presentation.state === "loading" ? presentation.attemptId : ""]);

  if (!resident) {
    return (
      <Box data-panel-content-state="parked" data-panel-id={panelId} style={{ flex: "1 1 0" }} />
    );
  }

  let content: React.ReactNode = null;
  if (unresponsive) {
    content = (
      <CenteredState state="unresponsive" panelId={panelId}>
        <Text size="4" weight="bold">
          This panel is not responding
        </Text>
        <Text size="2" color="gray" align="center">
          Its renderer may be busy or stuck. You can wait, or force a clean reload.
        </Text>
        <Flex gap="2">
          <Button variant="soft" onClick={() => onDismissUnresponsive(panelId)}>
            Wait
          </Button>
          <Button
            color="red"
            onClick={() => {
              onDismissUnresponsive(panelId);
              void panelService.forceReloadView(panelId);
            }}
          >
            Force reload
          </Button>
        </Flex>
      </CenteredState>
    );
  } else if (presentation.state === "unavailable") {
    content = (
      <CenteredState state="leased-elsewhere" panelId={panelId}>
        <Text size="4" weight="bold">
          Running on {presentation.lease.holderLabel}
        </Text>
        <Button
          disabled={takeoverBusy}
          onClick={() => {
            setTakeoverBusy(true);
            setActionError(null);
            void panelService
              .takeOver(panelId)
              .catch((error: unknown) =>
                setActionError(error instanceof Error ? error.message : String(error))
              )
              .finally(() => setTakeoverBusy(false));
          }}
        >
          {takeoverBusy ? "Taking over…" : "Take Over"}
        </Button>
        {actionError ? (
          <Text color="red" size="2" role="alert">
            Couldn&apos;t take over: {actionError}
          </Text>
        ) : null}
      </CenteredState>
    );
  } else if (presentation.state === "failed") {
    content = (
      <CenteredState state="failed" panelId={panelId}>
        <Text color="red" size="4" weight="bold">
          Panel failed to load
        </Text>
        <Text color="red" size="2" style={{ fontFamily: "monospace" }}>
          {presentation.message}
        </Text>
        <Flex gap="2">
          <Button variant="soft" onClick={() => void panelService.reload(panelId)}>
            Retry
          </Button>
          <Button onClick={() => void panelService.rebuildPanel(panelId)}>Rebuild</Button>
        </Flex>
      </CenteredState>
    );
  } else if (presentation.state !== "ready") {
    content = (
      <CenteredState
        state={presentation.state === "loading" ? "preparing" : "loading"}
        panelId={panelId}
      >
        {presentation.state === "idle" ? <VibestudioLogo size={56} variant="symbol" /> : null}
        <Spinner size="3" />
        <Text>{presentation.state === "loading" ? "Preparing panel..." : "Loading panel..."}</Text>
        {presentation.state === "loading" ? (
          <Text size="2" color="gray">
            {presentation.stage}
          </Text>
        ) : null}
        {slow ? (
          <Flex direction="column" align="center" gap="2">
            <Text size="2" color="amber">
              This presentation is taking longer than expected.
            </Text>
            <Flex gap="2">
              <Button
                size="1"
                variant="soft"
                onClick={() => void panelService.createAboutPanel("server-logs")}
              >
                View server logs
              </Button>
              <Button size="1" onClick={() => void panelService.reload(panelId)}>
                Retry
              </Button>
            </Flex>
          </Flex>
        ) : null}
        {actionError ? (
          <Text color="red" size="2">
            {actionError}
          </Text>
        ) : null}
      </CenteredState>
    );
  }

  return (
    <PanelSurface
      key={panelId}
      nativeSlotId={nativeSlotIdForPane(paneId)}
      panelId={panelId}
      focused={focused}
      layoutEpoch={layoutEpoch}
      onPointerDown={(event) => {
        onFocusPane(paneId);
        void view.forwardMouseClick(panelId, {
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
        });
      }}
    >
      {content}
    </PanelSurface>
  );
}
