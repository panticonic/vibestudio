import { useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Callout, Code, Flex, Table, Text } from "@radix-ui/themes";
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

  const revoke = async (deviceId: string) => {
    setBusyId(deviceId);
    try {
      await remoteCred.revokeDevice(deviceId);
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
    try {
      setError(null);
      setInvite(await remoteCred.createPairingInvite());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInviteBusy(false);
    }
  };

  const copyInvite = async () => {
    if (!invite?.deepLink) return;
    await navigator.clipboard.writeText(invite.deepLink);
    setCopyLabel("Copied");
  };

  return (
    <Flex direction="column" gap="2" mt="4">
      <Flex justify="between" align="center">
        <Text size="2" weight="medium">
          Paired devices
        </Text>
        <Flex gap="2">
          <Button size="1" variant="soft" disabled={inviteBusy} onClick={() => void createInvite()}>
            {inviteBusy ? "Creating..." : "Pair another device"}
          </Button>
          <Button size="1" variant="soft" onClick={() => void load()}>
            Refresh
          </Button>
        </Flex>
      </Flex>
      {invite ? (
        <Callout.Root size="1" color="green">
          <Callout.Text>
            <Flex direction="column" gap="2">
              <Text>
                Pairing code <Code>{invite.code}</Code> expires at {formatTime(invite.expiresAt)}.
              </Text>
              {invite.deepLink ? (
                <Flex gap="3" align="start" wrap="wrap">
                  <PairingQrCode value={invite.deepLink} />
                  <Flex direction="column" gap="2" style={{ minWidth: 0, flex: "1 1 260px" }}>
                    <Box style={{ maxWidth: "100%", overflowWrap: "anywhere" }}>
                      <Code>{invite.deepLink}</Code>
                    </Box>
                    <Box>
                      <Button size="1" variant="soft" onClick={() => void copyInvite()}>
                        {copyLabel}
                      </Button>
                    </Box>
                  </Flex>
                </Flex>
              ) : null}
            </Flex>
          </Callout.Text>
        </Callout.Root>
      ) : null}
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

function PairingQrCode({ value }: { value: string }) {
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
        height="176"
        role="img"
        shapeRendering="crispEdges"
        viewBox={`0 0 ${viewSize} ${viewSize}`}
        width="176"
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
