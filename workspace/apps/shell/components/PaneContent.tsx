import { useCallback, useEffect, useState } from "react";
import { Box, Button, Flex, Spinner, Text } from "@radix-ui/themes";
import { VibestudioLogo } from "@workspace/ui";

import type {
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
} from "@vibestudio/shared/panel/panelLease";
import { useFullPanel } from "../shell/hooks/PanelTreeContext";
import { panel as panelService, view } from "../shell/client";
import { useShellEvent } from "../shell/useShellEvent";
import { leasedElsewhereInfo } from "./PanelStackVisibility";
import { PanelSurface } from "./PanelSurface";
import { nativeSlotIdForPane } from "../layout/types";

interface PaneContentProps {
  paneId: string;
  panelId: string;
  /** False while the pane's column is parked (§5.4): slot cleared, no load. */
  resident: boolean;
  focused: boolean;
  /** Bumped on committed layout/viewport changes; forces surface bounds resync. */
  layoutEpoch: number;
  unresponsive: boolean;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
}

/**
 * One pane's content state machine — loading / unresponsive / leased-elsewhere
 * + Take Over / build-error / building / ready surface. Extracted from the old
 * single-panel `renderPanelContent()`; every piece of state here is per-pane.
 */
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
  const { panel: fullPanel } = useFullPanel(panelId);
  const [runtimeLease, setRuntimeLease] = useState<PanelRuntimeLease | null>(null);
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  const [buildSlow, setBuildSlow] = useState(false);

  useShellEvent(
    "panel:runtimeLeaseChanged",
    useCallback(
      (event: PanelRuntimeLeaseChangedEvent) => {
        if (event.slotId === panelId) setRuntimeLease(event.next);
      },
      [panelId]
    )
  );

  useEffect(() => {
    let cancelled = false;
    setRuntimeLease(null);
    void panelService
      .getRuntimeLease(panelId)
      .then((lease) => {
        if (!cancelled) setRuntimeLease(lease);
      })
      .catch(() => {
        if (!cancelled) setRuntimeLease(null);
      });
    return () => {
      cancelled = true;
    };
  }, [panelId]);

  useEffect(() => {
    setTakeoverError(null);
    setTakeoverBusy(false);
    setBuildSlow(false);
    if (!fullPanel || fullPanel.artifacts?.htmlPath || fullPanel.artifacts?.error) return;
    const timer = window.setTimeout(() => setBuildSlow(true), 60_000);
    return () => window.clearTimeout(timer);
  }, [fullPanel?.id, fullPanel?.artifacts?.htmlPath, fullPanel?.artifacts?.error]);

  // Keyed on (panelId, resident), not panelId alone: un-parking must re-run
  // loading because a parked panel may have been GC-unloaded (§5.4).
  useEffect(() => {
    if (!resident) return;
    void panelService
      .ensureLoaded(panelId)
      .then((result) => {
        if (result.status === "leased_elsewhere" || result.status === "view_creation_failed") {
          console.warn("Panel load did not create a view", result);
        }
      })
      .catch((error) => {
        console.error("Failed to ensure panel is loaded", error);
      });
  }, [panelId, resident]);

  if (!fullPanel) {
    return (
      <Flex direction="column" align="center" justify="center" gap="3" height="100%">
        <VibestudioLogo size={56} variant="symbol" />
        <Spinner size="3" />
        <Text>Loading panel...</Text>
      </Flex>
    );
  }

  const artifacts = fullPanel.artifacts;
  if (unresponsive) {
    return (
      <Flex direction="column" align="center" justify="center" height="100%" gap="3" p="4">
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
      </Flex>
    );
  }

  const leasedElsewhere = leasedElsewhereInfo(panelId, runtimeLease, fullPanel.state?.runtime);
  if (leasedElsewhere) {
    return (
      <Flex direction="column" align="center" justify="center" height="100%" gap="3" p="4">
        <Text size="4" weight="bold">
          Running on {leasedElsewhere.holderLabel}
        </Text>
        <Button
          disabled={takeoverBusy}
          onClick={() => {
            setTakeoverBusy(true);
            setTakeoverError(null);
            void panelService
              .takeOver(leasedElsewhere.slotId)
              .catch((error) => {
                console.error("Failed to take over panel", error);
                setTakeoverError(error instanceof Error ? error.message : String(error));
              })
              .finally(() => setTakeoverBusy(false));
          }}
        >
          {takeoverBusy ? "Taking over…" : "Take Over"}
        </Button>
        {takeoverError ? (
          <Text color="red" size="2" role="alert">
            Couldn&apos;t take over: {takeoverError}
          </Text>
        ) : null}
      </Flex>
    );
  }

  if (artifacts?.error) {
    return (
      <Flex direction="column" align="center" justify="center" height="100%" p="4">
        <Text color="red" size="4" weight="bold" mb="2">
          Panel Error
        </Text>
        <Text color="red" size="2" style={{ fontFamily: "monospace" }}>
          {artifacts.error}
        </Text>
        <Flex gap="2" mt="3">
          <Button variant="soft" onClick={() => void panelService.reload(panelId)}>
            Reload
          </Button>
          <Button onClick={() => void panelService.rebuildPanel(panelId)}>Rebuild</Button>
        </Flex>
      </Flex>
    );
  }

  if (!artifacts?.htmlPath) {
    return (
      <Flex direction="column" align="center" justify="center" height="100%">
        <Spinner size="3" />
        <Text mt="3">{"Preparing panel..."}</Text>
        {artifacts?.buildProgress ? (
          <Text size="2" color="gray" mt="1">
            {artifacts.buildProgress}
          </Text>
        ) : null}
        {buildSlow ? (
          <Flex direction="column" align="center" gap="2" mt="3">
            <Text size="2" color="amber">
              This build is taking longer than expected.
            </Text>
            <Flex gap="2">
              <Button
                size="1"
                variant="soft"
                onClick={() => void panelService.createAboutPanel("server-logs")}
              >
                View server logs
              </Button>
              <Button size="1" onClick={() => void panelService.rebuildPanel(panelId)}>
                Rebuild
              </Button>
            </Flex>
          </Flex>
        ) : null}
      </Flex>
    );
  }

  if (!resident) {
    // Parked: the native slot is cleared; keep lease/timers mounted but render
    // no surface so nothing binds (§5.4).
    return <Box style={{ flex: "1 1 0" }} />;
  }

  return (
    <PanelSurface
      key={panelId}
      nativeSlotId={nativeSlotIdForPane(paneId)}
      panelId={panelId}
      bindingKey={[
        panelId,
        fullPanel.path ?? "",
        fullPanel.contextId,
        artifacts.htmlPath ?? "",
        artifacts.buildRevision ?? "",
        artifacts.buildState ?? "",
      ].join("|")}
      focused={focused}
      layoutEpoch={layoutEpoch}
      onPointerDown={(event) => {
        onFocusPane(paneId);
        void view.forwardMouseClick(panelId, {
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
        });
      }}
    />
  );
}
