/**
 * `@vibestudio/rn-client-api`: what a React Native client may use of its host
 * under ABI rn-host-6. A client imports this and nothing host-owned. The
 * device credential, the physical connection and the push token stay in the
 * host runtime; see `protocol.ts` for the wire and `host` modules in
 * `hosts/react-native` for the other end.
 *
 * `connectNativeClientApi` (in `@vibestudio/rn-client-api/native`) builds the
 * API on the native broker of the running instance.
 */
export * from "./api";
export * from "./channel";
export * from "./protocol";
export * from "./notificationsProtocol";
export * from "./integrationProtocol";
export * from "./remoteConnection";
export * from "./remoteSession";
export { openRemoteStream, type RemoteStreamSurface } from "./remoteStream";
