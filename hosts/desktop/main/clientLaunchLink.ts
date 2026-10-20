import type { HostDescriptor, ClientSelection } from "@vibestudio/workspace-contracts/clients";
import type { ControlChannel } from "../connection/controlChannel.js";
import type {
  ClientBuildIdentity,
  ConnectionEvents,
  LaunchStateWire,
  RetainedClientBuild,
} from "../connection/connectionProtocol.js";

/**
 * Main's end of client launch. The launcher, the artifact cache and the grant
 * acquisition run in the connection process; main asks it to launch and receives
 * the launcher's states with handles of artifacts it verified. A launch is one
 * remote launcher, ended by whoever started it.
 */
export interface RemoteLauncher {
  /** Every state the launcher reaches, including those of re-attempts. */
  subscribe(listener: (state: LaunchStateWire) => void): () => void;
  launch(select: ClientSelection): Promise<LaunchStateWire>;
  /** Re-attempt a launch that waits on the server; null when nothing is waiting. */
  onClientsChanged(): Promise<LaunchStateWire | null>;
  /** Answer the review the launch waits on, then launch again when allowed. */
  resolveApprovals(decision: "once" | "deny"): Promise<LaunchStateWire | null>;
  /** The launch is over; the connection process drops its launcher. */
  end(): void;
}

export interface ClientLaunches {
  create(descriptor: HostDescriptor): RemoteLauncher;
  /**
   * Register a build that already runs with the connection process, which
   * acquires its principal's credential. Resolves to the principal id.
   */
  adopt(build: ClientBuildIdentity): Promise<string>;
  /** Keep the verified artifacts of the builds windows run; drop every other cached one. */
  retain(retained: readonly RetainedClientBuild[]): Promise<void>;
  /** The bytes of a cached artifact, verified against their integrity by the connection process. */
  readVerified(integrity: string): Promise<Uint8Array>;
}

/** {@link ClientLaunches} over the control channel; follows the channel through a restart. */
export class ClientLaunchLink implements ClientLaunches {
  private readonly launchers = new Map<number, (state: LaunchStateWire) => void>();
  private nextLaunch = 1;
  private attached: ControlChannel;

  constructor(channel: ControlChannel) {
    this.attached = channel;
    this.listen(channel);
  }

  /** The connection process was replaced. Launches of the old one ended with it. */
  attach(channel: ControlChannel): void {
    this.launchers.clear();
    this.attached = channel;
    this.listen(channel);
  }

  private listen(channel: ControlChannel): void {
    channel.on("launch.state", (event: ConnectionEvents["launch.state"]) =>
      this.launchers.get(event.launchId)?.(event.state)
    );
  }

  create(descriptor: HostDescriptor): RemoteLauncher {
    const launchId = this.nextLaunch++;
    const listeners = new Set<(state: LaunchStateWire) => void>();
    this.launchers.set(launchId, (state) => {
      for (const listener of [...listeners]) listener(state);
    });
    const channel = () => this.attached;
    return {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      launch: (select) =>
        channel().request<LaunchStateWire>("launch.start", { launchId, descriptor, select }),
      onClientsChanged: () =>
        channel().request<LaunchStateWire | null>("launch.clients-changed", { launchId }),
      resolveApprovals: (decision) =>
        channel().request<LaunchStateWire | null>("launch.resolve-approvals", {
          launchId,
          decision,
        }),
      end: () => {
        this.launchers.delete(launchId);
        listeners.clear();
        channel()
          .request("launch.end", { launchId })
          .catch(() => {
            // The connection process that held the launcher is gone; so is the launcher.
          });
      },
    };
  }

  adopt(build: ClientBuildIdentity): Promise<string> {
    return this.attached.request<string>("launch.adopt", { build });
  }

  retain(retained: readonly RetainedClientBuild[]): Promise<void> {
    return this.attached.request("launch.retain", { retained: [...retained] });
  }

  readVerified(integrity: string): Promise<Uint8Array> {
    return this.attached.request<Uint8Array>("artifacts.read", { integrity });
  }
}
