# WebRTC ICE-restart — findings and decision

**Status:** Settled (2026-07-10). Run, not assumed.

## Question

The WebRTC remote transport recovers from a dropped pipe by tearing the
`PeerConnection` down and re-establishing over the persistent signaling room.
A *true in-place ICE-restart* — refreshing ICE credentials (new ufrag/pwd, new
candidate gathering) on the **existing** peer while keeping DTLS/SCTP and the
open data channel alive — would make a network-path change (Wi-Fi↔LTE, NAT
rebind, TURN-cred refresh) nearly seamless: no DTLS re-handshake, no logical
sessions to reopen. It was deferred during the July 2026 hardening pending a
check that the native stack can actually do it.

## Answer: not feasible on `node-datachannel` 0.32.3 (the server/desktop answerer)

`node-datachannel@0.32.3` (libdatachannel) exposes **no `restartIce()`** and
fuses `createOffer` into `setLocalDescription`. The only candidate mechanism is
re-offering on the connected peer (`setLocalDescription("offer")` again). A spike
(below) shows that this:

- **does not rotate the ICE ufrag** — the re-offer carries the *same* ICE
  credentials (`ufrag p5w2 → p5w2`), so it is not an ICE restart at all; and
- **tears down the open data channel** (`dcA.isOpen()` flips to `false` right
  after the re-offer), so it is actively destructive.

```
STEP 1 OK: open; B received ["hello-1"] ufragA: p5w2
STEP 2: re-offer on connected A...
  threw: null | new offers: 1 | newUfrag: p5w2 | dcOpen: false
==== VERDICT ====
  re-offer accepted: true | fresh ICE creds: false | DC survived: false | data flows after: false
  => TRUE in-place ICE-restart FEASIBLE: false
```

Because the **answerer** (home server / desktop host) runs `node-datachannel`,
an ICE-restart initiated by any peer (including a `react-native-webrtc` mobile
client, which *does* implement `restartIce()`) has no counterpart to negotiate
against and would break the pipe. So ICE-restart is off the table **end to end**,
not just on one side.

## Decision

Do **not** implement in-place ICE-restart. Recovery stays a **bounded
re-establish over the persistent signaling room**, which already delivers ICE-
restart's practical benefits:

- **No re-pair.** The reconnect re-joins the *same* UUID room and the server
  presents its *persistent* DTLS cert (stable QR `fp`) — the pairing/QR is never
  needed again.
- **Session continuity.** Logical panel/shell sessions auto-reopen after the pipe
  is back (grants re-redeemed), so N principals survive a reconnect.
- **Transient-blip tolerance.** ICE `disconnected` is treated as transient (the
  agent keeps probing); only ICE `failed` or a keepalive-timeout tears down
  (`webrtcClient.ts` `onConnectionState`).
- **Prompt recovery.** First reconnect attempt fires ~1 s after pipe-down
  (`RECONNECT_BASE_DELAY_MS`), a per-attempt 35 s deadline backstops a wedge, and
  `nudge()` (5 s pong deadline) proactively probes on wake / network-change
  (`powerMonitor` + `online` on desktop, NetInfo/AppState on mobile).

The only thing lost versus a true ICE-restart is the sub-second DTLS re-handshake,
which `node-datachannel` cannot avoid.

## Revisit criteria

Reopen this only if `node-datachannel`/libdatachannel ships a real
`restartIce()` (or a re-offer path that rotates the ICE ufrag/pwd **and**
preserves DTLS/SCTP and the data channel). At that point the seam would be:
add `restartIce()` to `RtcPeerConnectionLike`, trigger it on
`disconnected`-grace / keepalive-timeout *before* full teardown, re-signal the
new offer over the persistent room, and gate the answerer's `processDescriptions`
to apply an ICE-restart offer to the existing peer instead of tearing down.
Until then, re-establish is the mechanism.

## Reproducing the spike

Self-contained; run from the repo root so `node-datachannel` resolves:

```js
// ice-restart-spike.mjs
import nd from "node-datachannel";
const ufrag = (sdp) => (sdp.match(/a=ice-ufrag:(\S+)/) || [])[1];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function makePeer(name) {
  const pc = new nd.PeerConnection(name, { iceServers: [], disableAutoNegotiation: true });
  const s = { pc, name, localSdps: [] };
  pc.onLocalDescription((sdp, type) => { s.localSdps.push({ sdp, type }); s.sendDesc?.({ sdp, type }); });
  pc.onLocalCandidate((candidate, mid) => s.sendCand?.({ candidate, mid }));
  return s;
}
const A = makePeer("A"), B = makePeer("B");
A.sendDesc = (d) => { B.pc.setRemoteDescription(d.sdp, d.type); if (d.type === "offer") B.pc.setLocalDescription("answer"); };
B.sendDesc = (d) => A.pc.setRemoteDescription(d.sdp, d.type);
A.sendCand = (c) => B.pc.addRemoteCandidate(c.candidate, c.mid);
B.sendCand = (c) => A.pc.addRemoteCandidate(c.candidate, c.mid);
const received = [];
const dcA = A.pc.createDataChannel("bulk");
const opened = new Promise((res) => dcA.onOpen(() => res()));
B.pc.onDataChannel((dc) => dc.onMessage((m) => received.push(String(m))));
A.pc.setLocalDescription("offer");
await Promise.race([opened, wait(8000)]);
const origUfrag = ufrag(A.localSdps[0].sdp);
dcA.sendMessage("hello-1"); await wait(300);
const before = A.localSdps.length;
A.pc.setLocalDescription("offer"); // <-- the "ICE restart" attempt
await wait(1500);
const fresh = A.localSdps.slice(before);
const newUfrag = fresh.length ? ufrag(fresh.at(-1).sdp) : null;
console.log("ufrag changed:", newUfrag !== origUfrag, "| DC survived:", dcA.isOpen());
process.exit(0);
```
