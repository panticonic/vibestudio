# Backhaul socket lifetime and native RPC404

The original r6 batch `examples-0045-1795538069596307611` lost its workspace
server, not its managed-run identity. Retained supervisor log
`native-v21-examples-bcb07d7c3f-5af4f0cb-64.log:3247–3264` records the backhaul
handshake timer calling teardown, `ws.terminate()` on a CONNECTING socket,
and an asynchronously emitted error with no listener. Node exited code1;
the hub reported workspace child2795479 unexpectedly exited. Subsequent
POST `http://127.0.0.1:33683/_workspace/examples-0be31572b3f26aa9de4934d3/rpc`
returned404 because that workspace runtime was no longer running. No model
calls are needed to exercise this failure.

Mechanism inventory before editing:

- CLI `systemTestCommands.ts` start, status, trajectory/export and cancel all
  share the authenticated `scope.client.callTarget` path. `rpcClient.ts`
  posts the canonical envelope to `serverRpcHttpUrl`, preserving the selected
  workspace prefix (`packages/shared/src/connect.ts:42–57`). The stored run
  identity precedes start, so the failed run's actual owner is retained.
- Hub `hubServer.ts` parses that prefix, proxies to a live workspace child,
  and returns404 `Workspace is not running` when none exists. Only an
  authenticated refresh-shell request may start an absent child. Polling RPC
  is deliberately not an implicit instance restart. No retries added here.
- `services/relayBackhaulClient.ts` is the sole production WebSocket owner
  found to removeAllListeners before termination. Both handshake failure and
  stop's exceptional close fallback use that teardown. Existing open/close
  handlers fence current socket identity; the message handler also needs that
  fence when retained listeners observe a replaced/retiring socket.
- Server `index.ts` starts/stops this shared client for webhooks and OAuth;
  `startRelayBackhaul` provides the same implementation to every source and
  installed server, including Node/headless/Electron workspace children.
  Tests inject a constructor only; product construction still uses actual ws.
- `egressProxy.ts:2392,2505,2584` and shared `chromiumNetworkProxy.ts:55,71`
  already preserve lifetime error sinks via `socketBridge.ts:21` for raw Duplex
  sockets. That helper's transport is different; the backhaul keeps its existing
  WebSocket error/close handlers instead of adding another socket abstraction.
- Other removeAllListeners uses are Electron IPC, process warnings, a private
  process-session event emitter, or message-only CDP test setup. They do not
  strip a connecting WebSocket's terminal error handler.
- Model engines consume requests after Host transport admission and do not own
  this callback relay WebSocket. No model or native evaluator changes apply.

V23 frozen Host981 contains the same faulty teardown as V21 Host53e9. This fix
is a new successor; frozen Source trees and original run packets remain intact.
The first three native cases progressed before the crash, but no exported
complete packets survived. This change does not manufacture case outcomes or
claim the original Workerd OOM is explained.
