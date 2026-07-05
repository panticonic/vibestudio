import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConnectLink } from "@vibestudio/shared/connect";
import { DeviceAuthStore } from "../deviceAuthStore.js";
import {
  createPairingInviteResponse,
  mintPairingInvite,
  type ConnectPairingSeam,
  type PairingRoomArmer,
} from "./model.js";

const FP = "AA".repeat(32);
const SEAM: ConnectPairingSeam = { fp: FP, sig: "wss://signal.example/", ice: "all" };

function makeStore(): DeviceAuthStore {
  return new DeviceAuthStore(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-auth-model-")), "devices.json")
  );
}

function makeArmer(): { armer: PairingRoomArmer; armed: Array<{ room: string; meta: object }> } {
  const armed: Array<{ room: string; meta: object }> = [];
  return { armer: { armRoom: (room, meta) => armed.push({ room, meta }) }, armed };
}

describe("mintPairingInvite (room-per-invite, plan §2.1)", () => {
  it("mints a UNIQUE room per invite, arms it, and embeds it in the v=2 deep link", () => {
    const store = makeStore();
    const { armer, armed } = makeArmer();

    const first = mintPairingInvite({ deviceAuthStore: store, pairing: SEAM, ingress: armer });
    const second = mintPairingInvite({ deviceAuthStore: store, pairing: SEAM, ingress: armer });

    expect(first.room).toBeTruthy();
    expect(second.room).toBeTruthy();
    expect(first.room).not.toBe(second.room);
    expect(first.code).not.toBe(second.code);

    // Each invite armed its own room on the pool, tagged with its code.
    expect(armed).toEqual([
      { room: first.room, meta: { inviteCode: first.code } },
      { room: second.room, meta: { inviteCode: second.code } },
    ]);

    // The deep link is v=2 and carries the invite's room + code.
    for (const invite of [first, second]) {
      const parsed = parseConnectLink(invite.deepLink!);
      expect(parsed).toMatchObject({
        kind: "ok",
        room: invite.room,
        code: invite.code,
        fp: FP,
        v: 2,
      });
    }
  });

  it("redemption of the minted code persists the invite's room onto the device", () => {
    const store = makeStore();
    const { armer } = makeArmer();
    const invite = mintPairingInvite({ deviceAuthStore: store, pairing: SEAM, ingress: armer });
    const credential = store.completePairing({ code: invite.code, label: "Phone" });
    expect(store.listDevices().find((d) => d.deviceId === credential.deviceId)?.room).toBe(
      invite.room
    );
  });

  it("without WebRTC ingress the invite is a bare code (no room, no deep link)", () => {
    const store = makeStore();
    const bare = mintPairingInvite({ deviceAuthStore: store, pairing: null, ingress: null });
    expect(bare.room).toBeNull();
    expect(bare.deepLink).toBeNull();
    expect(store.hasPendingPairingCode(bare.code)).toBe(true);

    // A pairing seam WITHOUT a live pool must not fabricate an un-armed room.
    const { armer, armed } = makeArmer();
    const seamOnly = mintPairingInvite({ deviceAuthStore: store, pairing: SEAM, ingress: null });
    expect(seamOnly.room).toBeNull();
    expect(seamOnly.deepLink).toBeNull();
    const poolOnly = mintPairingInvite({ deviceAuthStore: store, pairing: null, ingress: armer });
    expect(poolOnly.room).toBeNull();
    expect(armed).toEqual([]);
  });
});

describe("createPairingInviteResponse", () => {
  const baseDeps = (store: DeviceAuthStore) => ({
    deviceAuthStore: store,
    getServerBootId: () => "boot_test",
    getWorkspaceId: () => "workspace_test",
  });

  it("carries the per-invite room + deep link when ingress is live", () => {
    const store = makeStore();
    const { armer, armed } = makeArmer();
    const response = createPairingInviteResponse(
      {
        ...baseDeps(store),
        getConnectionInfo: () => ({ serverUrl: "http://127.0.0.1:3030", pairing: SEAM }),
        getWebRtcIngress: () => armer,
      },
      30_000
    );

    expect(response.room).toBeTruthy();
    expect(response.deepLink).toContain(`room=${response.room}`);
    expect(response.deepLink).toContain("v=2");
    expect(response.expiresInMs).toBe(30_000);
    expect(armed).toEqual([{ room: response.room, meta: { inviteCode: response.code } }]);
    expect(store.hasPendingPairingCode(response.code)).toBe(true);
  });

  it("stays a bare-code invite when WebRTC is off (loopback co-located mode)", () => {
    const store = makeStore();
    const response = createPairingInviteResponse({
      ...baseDeps(store),
      getConnectionInfo: () => ({ serverUrl: "http://127.0.0.1:3030" }),
    });
    expect(response.room).toBeNull();
    expect(response.deepLink).toBeNull();
    expect(store.hasPendingPairingCode(response.code)).toBe(true);
  });
});
