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

  writeAll(bytes: number[]): Promise<void> {
    return this.native.writeAll(bytes);
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

  read(maximumBytes: number): Promise<number[]> {
    return this.native.read(maximumBytes);
  }

  readExact(length: number): Promise<number[]> {
    return this.native.readExact(length);
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
    return this.native.closed();
  }

  diagnostics() {
    const rtt = this.native.rtt();
    return {
      ...(rtt === null ? {} : { rttMs: Number(rtt) }),
      paths: this.native.paths().map((path) => ({
        selected: path.isSelected,
        kind: path.isRelay ? ("relay" as const) : ("direct" as const),
        remoteAddress: path.remoteAddr,
        rttMs: Number(path.rttMs),
      })),
    };
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
