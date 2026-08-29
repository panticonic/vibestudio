import type { IrohReach } from "./reach.js";

export interface IrohPhysicalSendStream {
  writeAll(bytes: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  reset(errorCode: bigint): Promise<void>;
  stopped(): Promise<number | null>;
}

export interface IrohPhysicalReceiveStream {
  read(maximumBytes: number): Promise<Uint8Array>;
  readExact(length: number): Promise<Uint8Array>;
  stop(errorCode: bigint): Promise<void>;
  receivedReset(): Promise<number | null>;
}

export interface IrohPhysicalBiStream {
  readonly send: IrohPhysicalSendStream;
  readonly recv: IrohPhysicalReceiveStream;
}

/**
 * Smallest physical surface owned by the shared connection lifecycle. Native
 * adapters keep binding-specific objects behind these handles.
 */
export interface IrohPhysicalConnection {
  readonly peerEndpointId: string;
  openBi(): Promise<IrohPhysicalBiStream>;
  acceptBi(): Promise<IrohPhysicalBiStream>;
  close(code: bigint, reason: Uint8Array): void;
  closed(): Promise<string>;
  diagnostics?(): IrohConnectionDiagnostics;
  onDiagnosticsChange?(handler: (diagnostics: IrohConnectionDiagnostics) => void): () => void;
}

export interface IrohConnectionPath {
  selected: boolean;
  kind: "direct" | "relay";
  remoteAddress: string;
  rttMs?: number;
}

export interface IrohConnectionDiagnostics {
  rttMs?: number;
  dialRelayUrl?: string;
  dialAttempts?: number;
  endpointGeneration?: number;
  transmittedBytes?: number;
  receivedBytes?: number;
  lostBytes?: number;
  logicalSessions?: number;
  activeRequests?: number;
  paths: readonly IrohConnectionPath[];
}

export interface IrohPhysicalEndpoint<Connection extends IrohPhysicalConnection> {
  readonly endpointId: string;
  connect(reach: IrohReach, relayUrl: string): Promise<Connection>;
  accept(): Promise<Connection | null>;
  close(): Promise<void>;
}

/** Rebinding must use the same durable secret and therefore return the same Endpoint ID. */
export interface IrohEndpointBinding<
  Connection extends IrohPhysicalConnection,
  Endpoint extends IrohPhysicalEndpoint<Connection>,
> {
  bind(): Promise<Endpoint>;
}
