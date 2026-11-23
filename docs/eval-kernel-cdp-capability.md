# Confined Eval CDP socket capability

The common handshake is `packages/rpc/src/protocol/cdpSocket.ts`. It requires an explicit native platform and never discovers network authority in its SDK realm. Base callers normally pass their own realm. Private Eval factories cannot do that: `EvalDO.ensureRuntimeSupport` loads them through the confined library loader.

`EvalDO.createActiveRuntimeRpc` records successful `workerdInspector.getEndpoint` and `panelCdp.getCdpEndpoint` replies per execution. Its injected binder accepts only that execution's exact URL/token, opens once, checks ownership on sends/events, and closes registered sockets in existing resident-session cleanup. Both workers and panel runtime factories receive this same binder. Raw fetch is no longer endowed when loading the CDP module.

The socket facade is frozen and has no prototype. Events are plain records; target/currentTarget point at that facade, not the native socket. Cancellation suppresses message delivery but permits terminal notifications while the execution is active, settling pending commands. Completion revokes every callback. Closing removes listeners and abort cleanup registrations.

The kernel regression bundles actual Base runtime factories, createCdpAutomation, BrowserImpl and CdpConnection into a private VM without fetch/WebSocket, then connects through the real kernel binder to a local CDP protocol server. It reproduces the old assembly failure, checks substitution/duplicate denial and actual panel acquisition, cancellation and completion. This proves assembly under the test environment; actual managed workerd CPU-profile smoke remains necessary and its earlier failed probes provide no timing measurements.
