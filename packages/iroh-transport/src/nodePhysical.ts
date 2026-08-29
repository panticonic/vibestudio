import type {
  BiStream,
  Connection,
  Endpoint,
  RecvStream,
  SecretKey,
  SendStream,
} from "@number0/iroh";
import type {
  IrohEndpointBinding,
  IrohPhysicalBiStream,
  IrohPhysicalConnection,
  IrohPhysicalEndpoint,
  IrohPhysicalReceiveStream,
  IrohPhysicalSendStream,
} from "./physical.js";
import type { IrohReach } from "./reach.js";
import {
  bindNodeEndpoint,
  configureNodeConnection,
  connectNodeEndpoint,
  endpointAddrForRelay,
} from "./nodeEndpoint.js";

class NodeSendStream implements IrohPhysicalSendStream {
  constructor(readonly native: SendStream) {}

  writeAll(bytes: Uint8Array): Promise<void> {
    // The pinned upstream N-API surface requires a real Array<number> and
    // rejects Uint8Array at runtime. Keep that unavoidable conversion at this
    // single physical edge; the shared protocol and mobile bridge remain typed
    // byte surfaces and can adopt a future official zero-copy binding directly.
    return this.native.writeAll(Array.from(bytes));
  }

  finish(): Promise<void> {
    return this.native.finish();
  }

  reset(errorCode: bigint): Promise<void> {
    return this.native.reset(errorCode);
  }

  stopped(): Promise<number | null> {
    return this.native.stopped();
  }
}

class NodeReceiveStream implements IrohPhysicalReceiveStream {
  constructor(readonly native: RecvStream) {}

  async read(maximumBytes: number): Promise<Uint8Array> {
    return Uint8Array.from(await this.native.read(maximumBytes));
  }

  async readExact(length: number): Promise<Uint8Array> {
    return Uint8Array.from(await this.native.readExact(length));
  }

  stop(errorCode: bigint): Promise<void> {
    return this.native.stop(errorCode);
  }

  receivedReset(): Promise<number | null> {
    return this.native.receivedReset();
  }
}

function wrapBiStream(stream: BiStream): IrohPhysicalBiStream {
  return {
    send: new NodeSendStream(stream.send),
    recv: new NodeReceiveStream(stream.recv),
  };
}

export class NodePhysicalConnection implements IrohPhysicalConnection {
  readonly peerEndpointId: string;
  private readonly diagnosticsListeners = new Set<
    (diagnostics: ReturnType<NodePhysicalConnection["diagnostics"]>) => void
  >();
  private diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
  private diagnosticsFingerprint = "";

  constructor(readonly native: Connection) {
    this.peerEndpointId = native.remoteId().toString();
  }

  async openBi(): Promise<IrohPhysicalBiStream> {
    return wrapBiStream(await this.native.openBi());
  }

  async acceptBi(): Promise<IrohPhysicalBiStream> {
    return wrapBiStream(await this.native.acceptBi());
  }

  close(code: bigint, reason: Uint8Array): void {
    this.native.close(code, [...reason]);
  }

  closed(): Promise<string> {
    return this.native.closed().finally(() => this.stopDiagnostics());
  }

  diagnostics() {
    const rtt = this.native.rtt();
    const stats = this.native.stats();
    return {
      ...(rtt === null ? {} : { rttMs: Number(rtt) }),
      transmittedBytes: stats.udpTxBytes,
      receivedBytes: stats.udpRxBytes,
      lostBytes: stats.lostBytes,
      paths: this.native.paths().map((path) => ({
        selected: path.isSelected,
        kind: path.isRelay ? ("relay" as const) : ("direct" as const),
        remoteAddress: path.remoteAddr,
        rttMs: Number(path.rttMs),
      })),
    };
  }

  onDiagnosticsChange(
    handler: (diagnostics: ReturnType<NodePhysicalConnection["diagnostics"]>) => void
  ): () => void {
    this.diagnosticsListeners.add(handler);
    const diagnostics = this.diagnostics();
    this.diagnosticsFingerprint = JSON.stringify(diagnostics);
    handler(diagnostics);
    if (!this.diagnosticsTimer) {
      this.diagnosticsTimer = setInterval(() => this.sampleDiagnostics(), 1_000);
      this.diagnosticsTimer.unref?.();
    }
    return () => {
      this.diagnosticsListeners.delete(handler);
      if (this.diagnosticsListeners.size === 0) this.stopDiagnostics();
    };
  }

  private sampleDiagnostics(): void {
    if (this.diagnosticsListeners.size === 0) {
      this.stopDiagnostics();
      return;
    }
    const diagnostics = this.diagnostics();
    const fingerprint = JSON.stringify(diagnostics);
    if (fingerprint === this.diagnosticsFingerprint) return;
    this.diagnosticsFingerprint = fingerprint;
    for (const listener of [...this.diagnosticsListeners]) listener(diagnostics);
  }

  private stopDiagnostics(): void {
    if (this.diagnosticsTimer) clearInterval(this.diagnosticsTimer);
    this.diagnosticsTimer = null;
    this.diagnosticsFingerprint = "";
    this.diagnosticsListeners.clear();
  }
}

export class NodePhysicalEndpoint implements IrohPhysicalEndpoint<NodePhysicalConnection> {
  readonly endpointId: string;

  constructor(readonly native: Endpoint) {
    this.endpointId = native.id().toString();
  }

  async connect(reach: IrohReach, relayUrl: string): Promise<NodePhysicalConnection> {
    const address = endpointAddrForRelay(reach.endpointId, relayUrl);
    return new NodePhysicalConnection(await connectNodeEndpoint(this.native, address));
  }

  async accept(): Promise<NodePhysicalConnection | null> {
    const incoming = await this.native.acceptNext();
    if (!incoming) return null;
    const accepting = await incoming.accept();
    const connection = await accepting.connect();
    configureNodeConnection(connection);
    return new NodePhysicalConnection(connection);
  }

  close(): Promise<void> {
    return this.native.close();
  }
}

export interface NodeEndpointBindingOptions {
  secretKey: SecretKey;
  relayUrls?: readonly string[];
  bindAddr?: string;
}

export function createNodeEndpointBinding(
  options: NodeEndpointBindingOptions
): IrohEndpointBinding<NodePhysicalConnection, NodePhysicalEndpoint> {
  return {
    async bind() {
      return new NodePhysicalEndpoint(await bindNodeEndpoint(options));
    },
  };
}
