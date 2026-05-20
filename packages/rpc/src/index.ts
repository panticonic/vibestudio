/**
 * `@natstack/rpc` — stateless point-to-point RPC with fetch-shaped
 * streaming. Stateful userland services can layer their own protocols
 * on top of the same runtime service-resolution path.
 */

export type {
  RpcRequest,
  RpcResponse,
  RpcEvent,
  RpcStreamRequest,
  RpcStreamFrameMessage,
  RpcStreamCancel,
  RpcMessage,
  RpcTransport,
  RpcBridge,
  RpcBridgeConfig,
  RpcBridgeInternal,
  RpcCallOptions,
  ExposedMethods,
  RpcEventListener,
  RpcCaller,
  CallerKind,
  StreamingMethodHandler,
  StreamingMethodFrame,
  ParentPortEnvelope,
  ElectronLocalServiceName,
} from "./types.js";

export { isParentPortEnvelope, ELECTRON_LOCAL_SERVICE_NAMES } from "./types.js";
export { createRpcBridge } from "./bridge.js";
export { createHandlerRegistry } from "./transport-helpers.js";
