import { useCallback, useEffect, useState } from "react";
import { Button, Dialog, Flex, Text, TextField, Callout, Box } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { AppDialog } from "@workspace/ui";
import {
  createConnectDeepLink,
  parseConnectLink,
  type ConnectPairing,
} from "@vibestudio/shared/connect";
import {
  app,
  incomingPairLink,
  remoteCred,
  type RemoteCredCurrent,
  type TestConnectionResult,
} from "../shell/client";
import { useShellOverlay } from "../shell/useShellOverlay";
import { useShellEvent } from "../shell/useShellEvent";
import { PairedDevicesSection } from "./PairedDevicesSection";
import { AppUpdatesSection } from "./AppUpdatesSection";

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
  const [deviceLabel, setDeviceLabel] = useState("");
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
        setLive({
          status: payload.status,
          isRemote: payload.isRemote,
          reconnect: payload.reconnect,
        });
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

  function describeTestError(result: TestConnectionResult): string {
    switch (result.error) {
      case "invalid-url":
        return `Invalid URL: ${result.message ?? ""}`;
      case "unreachable":
        return `Server unreachable: ${result.message ?? ""}`;
      case "unauthorized":
        return "Authentication failed — check the credential.";
      default:
        return result.message ?? "Unknown error";
    }
  }

  // `window.prompt` throws in Electron renderers ("prompt() is and will not be
  // supported"). Read the clipboard directly into the in-dialog text field
  // instead, validating (shape/version) before accepting it.
  const onPasteLink = async () => {
    setError(null);
    let raw: string;
    try {
      raw = (await navigator.clipboard.readText()).trim();
    } catch {
      setError("Couldn't read the clipboard — paste the link into the field instead.");
      return;
    }
    if (!raw) {
      setError("Clipboard is empty — copy the pairing link first.");
      return;
    }
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
      const res = await remoteCred.exchangePairingCode({
        link,
        label: deviceLabel || undefined,
      });
      if (!res.ok) {
        setError(describeTestError(res));
        setBusy(false);
        return;
      }
      await remoteCred.relaunch();
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
      title="Remote server"
      description="Pair this app with a Vibestudio server running elsewhere."
    >
      <Box mt="3">
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
          // Stored remote, but we're NOT on the remote pipe (fell back to local):
          // the genuine "re-pair" case.
          <Callout.Root size="1" color="red" mb="3">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>
              Your saved server isn&apos;t connected — running locally. Re-pair from the server to
              reconnect.
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
          <Box>
            <Text as="label" size="2" weight="medium">
              Device label{" "}
              <Text color="gray" size="1">
                (optional)
              </Text>
            </Text>
            <TextField.Root
              placeholder="Electron on this laptop"
              value={deviceLabel}
              onChange={(e) => setDeviceLabel(e.target.value)}
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
        {current ? <PairedDevicesSection currentDeviceId={current.deviceId} /> : null}
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
              {busy ? "Saving…" : "Save & relaunch"}
            </Button>
          </Flex>
        </Flex>
      </Box>
    </AppDialog>
  );
}
