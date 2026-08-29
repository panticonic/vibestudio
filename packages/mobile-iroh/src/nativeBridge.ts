import { NativeModules } from "react-native";
import {
  VIBESTUDIO_IROH_ALPN,
  type IrohEndpointBinding,
  type IrohPhysicalBiStream,
  type IrohPhysicalConnection,
  type IrohPhysicalEndpoint,
  type IrohPhysicalReceiveStream,
  type IrohPhysicalSendStream,
  type IrohReach,
} from "@vibestudio/iroh-transport";

interface NativeHandlePair {
  sendHandle: string;
  receiveHandle: string;
}

interface NativeConnectionResult {
  connectionHandle: string;
  peerEndpointId: string;
}

interface NativeEndpointResult {
  endpointHandle: string;
  endpointId: string;
}

interface NativeIdentityResult {
  identityId: string;
  endpointId: string;
}

interface IrohNativeModule {
  createIdentity(): Promise<NativeIdentityResult>;
  deleteIdentity(identityId: string): Promise<void>;
  bind(
    identityId: string,
    relays: readonly string[],
    alpnBase64: string
  ): Promise<NativeEndpointResult>;
  shutdownEndpoint(endpointHandle: string): Promise<void>;
  dial(
    endpointHandle: string,
    endpointId: string,
    relayUrl: string,
    alpnBase64: string
  ): Promise<NativeConnectionResult>;
  accept(endpointHandle: string): Promise<NativeConnectionResult | null>;
  openBi(connectionHandle: string): Promise<NativeHandlePair>;
  acceptBi(connectionHandle: string): Promise<NativeHandlePair>;
  write(sendHandle: string, bytesBase64: string): Promise<void>;
  finish(sendHandle: string): Promise<void>;
  reset(sendHandle: string, errorCode: string): Promise<void>;
  stopped(sendHandle: string): Promise<string | null>;
  read(receiveHandle: string, maximumBytes: number): Promise<string>;
  readExact(receiveHandle: string, length: number): Promise<string>;
  stop(receiveHandle: string, errorCode: string): Promise<void>;
  receivedReset(receiveHandle: string): Promise<string | null>;
  closeConnection(connectionHandle: string, errorCode: string, reasonBase64: string): void;
  connectionClosed(connectionHandle: string): Promise<string>;
}

function module(): IrohNativeModule {
  const native = NativeModules["VibestudioIroh"] as IrohNativeModule | undefined;
  if (!native) throw new Error("The Vibestudio Iroh native module is not installed");
  return native;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x4000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

class MobileSendStream implements IrohPhysicalSendStream {
  constructor(private readonly handle: string) {}
  writeAll(bytes: Uint8Array): Promise<void> {
    return module().write(this.handle, encodeBase64(bytes));
  }
  finish(): Promise<void> {
    return module().finish(this.handle);
  }
  reset(errorCode: bigint): Promise<void> {
    return module().reset(this.handle, errorCode.toString());
  }
  async stopped(): Promise<number | null> {
    const code = await module().stopped(this.handle);
    return code === null ? null : Number(code);
  }
}

class MobileReceiveStream implements IrohPhysicalReceiveStream {
  constructor(private readonly handle: string) {}
  async read(maximumBytes: number): Promise<Uint8Array> {
    return decodeBase64(await module().read(this.handle, maximumBytes));
  }
  async readExact(length: number): Promise<Uint8Array> {
    return decodeBase64(await module().readExact(this.handle, length));
  }
  stop(errorCode: bigint): Promise<void> {
    return module().stop(this.handle, errorCode.toString());
  }
  async receivedReset(): Promise<number | null> {
    const code = await module().receivedReset(this.handle);
    return code === null ? null : Number(code);
  }
}

function stream(pair: NativeHandlePair): IrohPhysicalBiStream {
  return {
    send: new MobileSendStream(pair.sendHandle),
    recv: new MobileReceiveStream(pair.receiveHandle),
  };
}

export class MobileConnection implements IrohPhysicalConnection {
  readonly peerEndpointId: string;
  constructor(
    private readonly handle: string,
    peerEndpointId: string
  ) {
    this.peerEndpointId = peerEndpointId;
  }
  async openBi(): Promise<IrohPhysicalBiStream> {
    return stream(await module().openBi(this.handle));
  }
  async acceptBi(): Promise<IrohPhysicalBiStream> {
    return stream(await module().acceptBi(this.handle));
  }
  close(code: bigint, reason: Uint8Array): void {
    module().closeConnection(this.handle, code.toString(), encodeBase64(reason));
  }
  closed(): Promise<string> {
    return module().connectionClosed(this.handle);
  }
}

export class MobileEndpoint implements IrohPhysicalEndpoint<MobileConnection> {
  readonly endpointId: string;
  constructor(
    private readonly handle: string,
    endpointId: string
  ) {
    this.endpointId = endpointId;
  }
  async connect(reach: IrohReach, relayUrl: string): Promise<MobileConnection> {
    const result = await module().dial(
      this.handle,
      reach.endpointId,
      relayUrl,
      encodeBase64(Uint8Array.from(VIBESTUDIO_IROH_ALPN))
    );
    if (result.peerEndpointId !== reach.endpointId) {
      module().closeConnection(result.connectionHandle, "512", "");
      throw new Error("Iroh handshake returned a different peer Endpoint ID");
    }
    return new MobileConnection(result.connectionHandle, result.peerEndpointId);
  }
  async accept(): Promise<MobileConnection | null> {
    const result = await module().accept(this.handle);
    return result ? new MobileConnection(result.connectionHandle, result.peerEndpointId) : null;
  }
  close(): Promise<void> {
    return module().shutdownEndpoint(this.handle);
  }
}

export function createMobileEndpointBinding(
  identityId: string,
  relayUrls: readonly string[]
): IrohEndpointBinding<MobileConnection, MobileEndpoint> {
  return {
    async bind() {
      const result = await module().bind(
        identityId,
        relayUrls,
        encodeBase64(Uint8Array.from(VIBESTUDIO_IROH_ALPN))
      );
      return new MobileEndpoint(result.endpointHandle, result.endpointId);
    },
  };
}

export const mobileIrohIdentity = {
  create: (): Promise<NativeIdentityResult> => module().createIdentity(),
  delete: (identityId: string): Promise<void> => module().deleteIdentity(identityId),
};
