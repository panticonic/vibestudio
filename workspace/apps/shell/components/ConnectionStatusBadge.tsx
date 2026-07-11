/**
 * ConnectionStatusBadge — chrome indicator for server connection state.
 *
 * Hidden when running a local server in the happy path (avoids visual noise).
 * Shows a colored dot + tooltip for remote mode and any degraded state.
 * Clicking opens the ConnectionSettingsDialog.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge, IconButton, Tooltip } from "@radix-ui/themes";
import { CrossCircledIcon, GlobeIcon, UpdateIcon } from "@radix-ui/react-icons";
import { app } from "../shell/client";
import { useShellEvent } from "../shell/useShellEvent";

type ConnectionStatus = "connected" | "connecting" | "disconnected";
type ConnectionMode = "local" | "remote";
/** Selected ICE path: host/srflx/prflx = direct P2P, relay = TURN, null = unknown. */
type CandidateType = "host" | "srflx" | "prflx" | "relay" | null;

interface ConnectionSnapshot {
  mode: ConnectionMode;
  status: ConnectionStatus;
  remoteHost?: string;
  candidateType?: CandidateType;
}

export function ConnectionStatusBadge({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [snap, setSnap] = useState<ConnectionSnapshot | null>(null);
  const [hasConnected, setHasConnected] = useState(false);

  useEffect(() => {
    app
      .getInfo()
      .then((info) => {
        setSnap({
          mode: info.connectionMode ?? "local",
          status: info.connectionStatus ?? "connected",
          remoteHost: info.remoteHost,
          candidateType: info.connectionCandidateType ?? null,
        });
        if ((info.connectionStatus ?? "connected") === "connected") setHasConnected(true);
      })
      .catch(() => {});
  }, []);

  useShellEvent(
    "server-connection-changed",
    useCallback(
      (payload: {
        status: ConnectionStatus;
        isRemote: boolean;
        remoteHost?: string;
        candidateType?: CandidateType;
      }) => {
        setSnap({
          mode: payload.isRemote ? "remote" : "local",
          status: payload.status,
          remoteHost: payload.remoteHost,
          candidateType: payload.candidateType ?? null,
        });
        if (payload.status === "connected") setHasConnected(true);
      },
      []
    )
  );

  if (!snap) return null;

  let tooltip =
    snap.status === "disconnected"
      ? `Disconnected from ${snap.mode === "remote" ? `remote server ${snap.remoteHost ?? ""}` : "local server"}`
      : snap.status === "connecting"
        ? hasConnected
          ? "Reconnecting to server…"
          : "Connecting to server…"
        : snap.mode === "remote"
          ? `Connected to ${snap.remoteHost ?? "remote server"}`
          : "Connected (local)";

  // Surface the selected network path on a live remote pipe: a TURN relay works
  // but is slower, so telling the user why is a kindness (not an alarm). Direct
  // (P2P) is noted quietly in the tooltip only — no visible chrome for the happy path.
  const isRelayed =
    snap.status === "connected" && snap.mode === "remote" && snap.candidateType === "relay";
  if (snap.status === "connected" && snap.mode === "remote" && snap.candidateType) {
    tooltip += isRelayed
      ? "\nRelayed via TURN — direct peer-to-peer wasn't available, so traffic is slower."
      : "\nDirect peer-to-peer connection.";
  }

  const badgeColor =
    snap.status === "disconnected"
      ? "red"
      : snap.status === "connecting"
        ? "amber"
        : snap.mode === "remote"
          ? "green"
          : "gray";

  const icon =
    snap.status === "disconnected" ? (
      <CrossCircledIcon />
    ) : snap.status === "connecting" ? (
      <UpdateIcon />
    ) : (
      <GlobeIcon />
    );

  return (
    <Tooltip content={tooltip}>
      <IconButton
        variant="ghost"
        size="1"
        aria-label={tooltip}
        onClick={onOpenSettings}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <Badge color={badgeColor} variant="soft" radius="full" style={{ padding: "2px 6px" }}>
          {icon}
          {snap.mode === "remote" && snap.remoteHost ? (
            <span style={{ marginLeft: 4 }}>{snap.remoteHost}</span>
          ) : null}
          {isRelayed ? (
            <span
              style={{
                marginLeft: 5,
                paddingLeft: 5,
                borderLeft: "1px solid currentColor",
                opacity: 0.7,
                fontSize: "0.85em",
                letterSpacing: "0.02em",
              }}
            >
              Relayed
            </span>
          ) : null}
        </Badge>
      </IconButton>
    </Tooltip>
  );
}
