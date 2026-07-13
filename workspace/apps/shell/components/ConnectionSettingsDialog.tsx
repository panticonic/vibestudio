import { useCallback, useEffect, useState } from "react";
import { Button, Dialog, Flex, Text, TextField, Callout, Box, Separator } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { AppDialog } from "@workspace/ui";
import {
  createConnectDeepLink,
  parseConnectLink,
  type ConnectPairing,
} from "@vibestudio/shared/connect";
import { app, incomingPairLink, remoteCred, type RemoteCredCurrent } from "../shell/client";
import { useShellOverlay } from "../shell/useShellOverlay";
import { useShellEvent } from "../shell/useShellEvent";
import { PairedDevicesSection } from "./PairedDevicesSection";
import { AppUpdatesSection } from "./AppUpdatesSection";
import { AccountProfileSection } from "./AccountProfileSection";

type LiveConnection = {
  status: "connected" | "connecting" | "disconnected";
  isRemote: boolean;
  reconnect?: { phase: string; attempt: number; reason: string };
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectionSettingsDialog({ open, onOpenChange }: Props) {
  useShellOverlay(open);
  const [current, setCurrent] = useState<RemoteCredCurrent | null>(null);
  const [pairLink, setPairLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [live, setLive] = useState<LiveConnection | null>(null);

  useEffect(() => {
    if (!open) return;
    app
      .getInfo()
      .then((info) =>
        setLive({
          status: info.connectionStatus ?? "connected",
          isRemote: (info.connectionMode ?? "local") === "remote",
        })
      )
      .catch(() => {});
  }, [open]);

  useShellEvent(
    "server-connection-changed",
    useCallback(
      (payload: {
        status: LiveConnection["status"];
        isRemote: boolean;
        reconnect?: LiveConnection["reconnect"];
      }) => {
        setLive((current) => ({
          status: payload.status,
          isRemote: payload.isRemote,
          reconnect:
            payload.reconnect ?? (payload.status === "connecting" ? current?.reconnect : undefined),
        }));
      },
      []
    )
  );

  useEffect(() => {
    // A `vibestudio://connect` link carries the full WebRTC pairing material
    // (room/fp/code/sig). The bridge hands us the parsed pairing; re-serialize it
    // into the link the exchange consumes.
    const apply = (pairing: ConnectPairing) => {
      setPairLink(createConnectDeepLink(pairing));
      onOpenChange(true);
    };
    void incomingPairLink.getPending().then((pairing) => {
      if (pairing) apply(pairing);
    });
    return incomingPairLink.onLink(apply);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirmingDisconnect(false);
    remoteCred
      .getCurrent()
      .then((c) => {
        setCurrent(c);
      })
      .catch((err) => setError(String(err)));
  }, [open]);

  const onPasteLink = () => {
    const raw = window.prompt("Paste Vibestudio pairing link");
    if (!raw) return;
    const parsed = parseConnectLink(raw);
    if (parsed.kind === "error") {
      setError(parsed.reason);
      return;
    }
    setPairLink(raw);
  };

  const savePairing = async () => {
    setError(null);
    const link = pairLink.trim();
    const parsed = parseConnectLink(link);
    if (parsed.kind === "error") {
      setError(parsed.reason);
      return;
    }
    setBusy(true);
    try {
      const res = await remoteCred.pair(link);
      if (!res.ok) {
        setError(res.message ?? "The pairing link is invalid or expired.");
        setBusy(false);
        return;
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const clearAndRelaunch = async () => {
    setBusy(true);
    try {
      await remoteCred.clear();
      await remoteCred.relaunch();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidth="680px"
      title="Connections & paired devices"
      description="Connect this desktop to a server, or pair phones and other devices with the current workspace."
    >
      <Box mt="3">
        <AccountProfileSection active={open} />
        <Separator size="4" my="4" />
        <Text as="div" size="3" weight="medium" mb="2">
          Server connection
        </Text>
        {current?.isActive ? (
          <Callout.Root size="1" color="green" mb="3">
            <Callout.Text>
              Currently connected to{" "}
              {current.workspaceName ?? `your server (device ${current.deviceId})`}
            </Callout.Text>
          </Callout.Root>
        ) : current?.configured && live?.isRemote && live.status === "connecting" ? (
          // A transient blip — calm, reassuring, NOT the scary re-pair banner.
          <Callout.Root size="1" color="blue" mb="3">
            <Callout.Text>
              Reconnecting to your server
              {live.reconnect?.attempt ? ` — attempt ${live.reconnect.attempt}` : ""}…
            </Callout.Text>
          </Callout.Root>
        ) : current?.configured && live?.isRemote && live.status === "disconnected" ? (
          <Callout.Root size="1" color="amber" mb="3">
            <Callout.Text>
              Disconnected — Vibestudio will reconnect automatically when your server is reachable.
            </Callout.Text>
          </Callout.Root>
        ) : current?.configured ? (
          <Callout.Root size="1" color="red" mb="3">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>
              The stored device credential is inactive or rejected. Create a fresh pairing link on
              the server and pair again.
            </Callout.Text>
          </Callout.Root>
        ) : null}

        <Flex direction="column" gap="3">
          <Box>
            <Flex justify="between" align="end">
              <Text as="label" size="2" weight="medium">
                Pairing link
              </Text>
              <Button size="1" variant="soft" disabled={busy} onClick={() => void onPasteLink()}>
                Paste link
              </Button>
            </Flex>
            <TextField.Root
              placeholder="vibestudio://connect?room=…"
              value={pairLink}
              onChange={(e) => setPairLink(e.target.value)}
            />
          </Box>
        </Flex>

        {error ? (
          <Callout.Root size="1" color="red" mt="3">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : null}

        {/* Local server sessions can mint companion-device invites too. Keeping
            this visible is the desktop entry point the mobile pairing flow promises. */}
        {current ? (
          <PairedDevicesSection
            currentDeviceId={current.deviceId}
            workspaceName={current.workspaceName}
            onStartPhoneSetup={() => onOpenChange(false)}
          />
        ) : null}
        <AppUpdatesSection />

        <Flex justify="between" mt="4" gap="3">
          <Flex gap="2">
            {live?.isRemote && live.status !== "connected" ? (
              <Button
                variant="soft"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  void remoteCred
                    .reconnectNow()
                    .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                }}
              >
                Reconnect now
              </Button>
            ) : null}
            {confirmingDisconnect ? (
              <>
                <Button color="red" disabled={busy} onClick={clearAndRelaunch}>
                  Confirm disconnect
                </Button>
                <Button
                  variant="soft"
                  color="gray"
                  disabled={busy}
                  onClick={() => setConfirmingDisconnect(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  color="red"
                  variant="soft"
                  disabled={busy || !current?.configured}
                  onClick={() => setConfirmingDisconnect(true)}
                >
                  Disconnect…
                </Button>
              </>
            )}
          </Flex>
          <Flex gap="3">
            <Dialog.Close>
              <Button variant="soft" color="gray" disabled={busy}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button onClick={savePairing} disabled={busy}>
              {busy ? "Pairing…" : "Pair & relaunch"}
            </Button>
          </Flex>
        </Flex>
      </Box>
    </AppDialog>
  );
}
