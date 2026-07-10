import { useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Callout, Code, Dialog, Flex, Table, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import QRCode from "qrcode-terminal/vendor/QRCode/index.js";
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";
import { remoteCred, type DeviceRecord, type PairingInvite } from "../shell/client";

export function PairedDevicesSection({ currentDeviceId }: { currentDeviceId?: string }) {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<PairingInvite | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy link");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [knownDeviceIds, setKnownDeviceIds] = useState<Set<string>>(new Set());
  const [pairedDevice, setPairedDevice] = useState<DeviceRecord | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = async () => {
    try {
      setError(null);
      setDevices(await remoteCred.listDevices());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!connectOpen || !invite) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [connectOpen, invite]);

  useEffect(() => {
    if (!connectOpen || !invite || pairedDevice) return;
    let cancelled = false;
    const poll = async () => {
      // Stop polling once the invite has expired — the QR is no longer scannable,
      // so continuing to hammer listDevices is pointless (the UI shows "Expired").
      if (!invite || Date.now() >= invite.expiresAt) return;
      try {
        const next = await remoteCred.listDevices();
        if (cancelled) return;
        setDevices(next);
        const joined = next.find((device) => !knownDeviceIds.has(device.deviceId));
        if (joined) setPairedDevice(joined);
      } catch {
        // The main error callout already covers explicit user-triggered failures.
      }
    };
    const timer = window.setInterval(() => void poll(), 2000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connectOpen, invite, knownDeviceIds, pairedDevice]);

  const revoke = async (deviceId: string) => {
    setBusyId(deviceId);
    try {
      await remoteCred.revokeDevice(deviceId);
      if (deviceId === currentDeviceId) {
        // Revoking THIS device: the pipe it authenticates is now dying. Match the
        // warning copy — clear the local credential and relaunch into local mode
        // rather than leaving the app on a dead pipe. (relaunch never returns.)
        await remoteCred.clear();
        await remoteCred.relaunch();
        return;
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  };

  const createInvite = async () => {
    setInviteBusy(true);
    setCopyLabel("Copy link");
    setPairedDevice(null);
    try {
      setError(null);
      setKnownDeviceIds(new Set(devices.map((device) => device.deviceId)));
      setInvite(await remoteCred.createPairingInvite());
      setConnectOpen(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInviteBusy(false);
    }
  };

  const copyInvite = async () => {
    if (!invite) return;
    await navigator.clipboard.writeText(invite.pairUrl);
    setCopyLabel("Copied");
  };

  const remainingMs = invite ? Math.max(0, invite.expiresAt - now) : 0;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const remaining = `${Math.floor(remainingSeconds / 60)}:${String(
    remainingSeconds % 60
  ).padStart(2, "0")}`;
  // Expired = the countdown reached 0 with nobody paired yet. The QR is stale, so
  // present a clear "Expired — regenerate" instead of a dead-but-scannable code.
  const expired = !!invite && remainingMs <= 0 && !pairedDevice;

  return (
    <Flex direction="column" gap="2" mt="4">
      <Flex justify="between" align="center">
        <Text size="2" weight="medium">
          Paired devices
        </Text>
        <Flex gap="2">
          <Button size="1" variant="soft" disabled={inviteBusy} onClick={() => void createInvite()}>
            {inviteBusy ? "Creating..." : "Connect a device"}
          </Button>
          <Button size="1" variant="soft" onClick={() => void load()}>
            Refresh
          </Button>
        </Flex>
      </Flex>
      <Dialog.Root open={connectOpen} onOpenChange={setConnectOpen}>
        <Dialog.Content maxWidth="560px">
          <Dialog.Title>Connect a device</Dialog.Title>
          {invite ? (
            <Flex direction="column" gap="4">
              <Flex gap="4" align="start" wrap="wrap">
                <Box style={{ opacity: expired ? 0.35 : 1, transition: "opacity 150ms" }}>
                  <PairingQrCode value={invite.pairUrl} size={248} />
                </Box>
                <Flex direction="column" gap="3" style={{ minWidth: 0, flex: "1 1 220px" }}>
                  <Text size="2">
                    Scan this QR with a phone camera, or open the link on another desktop. No app
                    yet? The link walks you through install.
                  </Text>
                  <Text size="2">
                    Server <Code>{invite.srv ?? invite.serverId}</Code>
                  </Text>
                  {expired ? (
                    <Flex direction="column" gap="2" style={{ width: "fit-content" }}>
                      <Badge color="amber">Expired</Badge>
                      <Button
                        size="1"
                        disabled={inviteBusy}
                        onClick={() => void createInvite()}
                      >
                        {inviteBusy ? "Regenerating..." : "Regenerate"}
                      </Button>
                    </Flex>
                  ) : (
                    <>
                      <Text size="2">
                        Expires in <Code>{remaining}</Code>
                      </Text>
                      <Badge
                        color={pairedDevice ? "green" : "gray"}
                        style={{ width: "fit-content" }}
                      >
                        {pairedDevice
                          ? `Paired ${pairedDevice.label || pairedDevice.platform || "device"}`
                          : "Waiting for device..."}
                      </Badge>
                    </>
                  )}
                </Flex>
              </Flex>
              <Box style={{ maxWidth: "100%", overflowWrap: "anywhere" }}>
                <Code>{invite.pairUrl}</Code>
              </Box>
              <Flex justify="between" align="center">
                <Text size="1" color="gray">
                  Pairing code {invite.code}
                </Text>
                <Flex gap="2">
                  <Button size="2" variant="soft" onClick={() => void copyInvite()}>
                    {copyLabel}
                  </Button>
                  <Dialog.Close>
                    <Button size="2">Done</Button>
                  </Dialog.Close>
                </Flex>
              </Flex>
            </Flex>
          ) : null}
        </Dialog.Content>
      </Dialog.Root>
      {error ? (
        <Callout.Root size="1" color="amber">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      {confirmId === currentDeviceId ? (
        <Callout.Root size="1" color="red">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            Revoking this device will sign you out and relaunch Vibestudio in local mode.
          </Callout.Text>
        </Callout.Root>
      ) : null}
      <Table.Root size="1" variant="surface">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Label</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Platform</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Created</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Last used</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {devices.map((device) => {
            const isCurrent = device.deviceId === currentDeviceId;
            const revoked = !!device.revokedAt;
            return (
              <Table.Row key={device.deviceId}>
                <Table.Cell>{device.label}</Table.Cell>
                <Table.Cell>{device.platform ?? "unknown"}</Table.Cell>
                <Table.Cell>{formatTime(device.createdAt)}</Table.Cell>
                <Table.Cell>{formatTime(device.lastUsedAt)}</Table.Cell>
                <Table.Cell>
                  <Badge color={revoked ? "red" : isCurrent ? "green" : "gray"}>
                    {revoked ? "revoked" : isCurrent ? "this device" : "active"}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  {revoked ? null : confirmId === device.deviceId ? (
                    <Flex gap="1">
                      <Button
                        size="1"
                        color="red"
                        disabled={busyId === device.deviceId}
                        onClick={() => void revoke(device.deviceId)}
                      >
                        Confirm
                      </Button>
                      <Button size="1" variant="soft" onClick={() => setConfirmId(null)}>
                        Cancel
                      </Button>
                    </Flex>
                  ) : (
                    <Button
                      size="1"
                      color="red"
                      variant="soft"
                      disabled={!!busyId}
                      onClick={() => setConfirmId(device.deviceId)}
                    >
                      Revoke
                    </Button>
                  )}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}

function formatTime(value: number | undefined): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

function PairingQrCode({ value, size = 176 }: { value: string; size?: number }) {
  const matrix = useMemo(() => createQrMatrix(value), [value]);
  const quietZone = 4;
  const viewSize = matrix.length + quietZone * 2;
  const path = matrix
    .flatMap((row, rowIndex) =>
      row.map((dark, colIndex) =>
        dark ? `M${colIndex + quietZone} ${rowIndex + quietZone}h1v1h-1z` : ""
      )
    )
    .join("");

  return (
    <Box
      style={{
        background: "white",
        border: "1px solid var(--gray-a5)",
        borderRadius: 6,
        flex: "0 0 auto",
        lineHeight: 0,
        padding: 8,
      }}
    >
      <svg
        aria-label="Pairing QR code"
        height={size}
        role="img"
        shapeRendering="crispEdges"
        viewBox={`0 0 ${viewSize} ${viewSize}`}
        width={size}
      >
        <title>Pairing QR code</title>
        <rect fill="white" height={viewSize} width={viewSize} />
        <path d={path} fill="#11181c" />
      </svg>
    </Box>
  );
}

function createQrMatrix(value: string): boolean[][] {
  const qrcode = new QRCode(-1, QRErrorCorrectLevel.L);
  qrcode.addData(value);
  qrcode.make();

  const moduleCount = qrcode.getModuleCount();
  return Array.from({ length: moduleCount }, (_unused, row) =>
    Array.from({ length: moduleCount }, (_unusedColumn, col) => qrcode.isDark(row, col))
  );
}
