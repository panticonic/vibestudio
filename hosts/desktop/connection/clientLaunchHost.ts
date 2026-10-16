import {
  ClientArtifactCache,
  ClientLaunchError,
  ClientLauncher,
  principalGrantsOverCall,
  sha256Integrity,
  type Call,
  type ClientArtifactFetch,
  type ClientArtifactStore,
  type LaunchState,
  type PrincipalGrants,
} from "@vibestudio/client-host-core";
import type { ClientPrincipalSessions, ScopedServerCaller } from "../main/serverClient.js";
import type { ControlChannel } from "./controlChannel.js";
import type { LaunchStateWire, RetainedClientBuild } from "./connectionProtocol.js";

export interface ClientLaunchHostDeps {
  channel: ControlChannel;
  /** The device's session to the System workspace. */
  call: Call;
  /** Fetch one artifact route through the device session (`gateway.fetch`). */
  fetchArtifact: ClientArtifactFetch;
  store: ClientArtifactStore;
}

/** The exact verified build a client principal's sessions are admitted for. */
interface LaunchedBuild {
  source: string;
  buildKey: string;
  executionDigest: string;
}

/**
 * Client launch, artifact verification and principal grants, inside the
 * connection process (docs/client-hosts-and-clients-plan.md §5.1.1).
 *
 * Main asks for a launch and receives the launcher's states with handles of
 * artifacts this process verified; it never holds the one-use connection grant,
 * which is redeemed only by the session that needs it. Bytes are read back
 * through `artifacts.read`, which is the single place a cached artifact is
 * checked against its declared integrity before anyone is served it.
 */
export class ClientLaunchHost {
  private readonly cache: ClientArtifactCache;
  private readonly grants: PrincipalGrants;
  private readonly launchers = new Map<number, ClientLauncher>();
  /** The latest build launched for each client principal. */
  private readonly builds = new Map<string, LaunchedBuild>();

  constructor(private readonly deps: ClientLaunchHostDeps) {
    this.cache = new ClientArtifactCache(deps.store, deps.fetchArtifact);
    this.grants = principalGrantsOverCall(deps.call);
    const { channel } = deps;
    channel.handle("launch.start", ({ launchId, descriptor, select }) => {
      let launcher = this.launchers.get(launchId);
      if (!launcher) {
        launcher = new ClientLauncher({
          call: deps.call,
          descriptor,
          cache: this.cache,
          grants: this.grants,
        });
        this.launchers.set(launchId, launcher);
        launcher.subscribe((state) => this.publish(launchId, state));
      }
      return launcher.launch(select).then((state) => this.wire(state));
    });
    channel.handle("launch.clients-changed", async ({ launchId }) => {
      const state = await this.launcher(launchId).onClientsChanged();
      return state && this.wire(state);
    });
    channel.handle("launch.resolve-approvals", async ({ launchId, decision }) => {
      const launcher = this.launcher(launchId);
      const state = launcher.state;
      if (state?.state !== "approval-required") {
        throw new Error("There is no review waiting on this launch");
      }
      const next = await launcher.resolveApprovals(state.approvals, decision);
      return next && this.wire(next);
    });
    channel.handle("launch.end", ({ launchId }) => {
      this.launchers.delete(launchId);
    });
    channel.handle("launch.retain", async ({ retained }) => {
      await this.cache.retain(
        new Map(
          (retained as RetainedClientBuild[]).map(({ clientId, integrities }) => [
            clientId,
            integrities,
          ])
        )
      );
    });
    channel.handle("artifacts.read", ({ integrity }) =>
      readVerifiedArtifact(this.deps.store, integrity)
    );
  }

  /**
   * Admits client principal sessions: a connection grant is one-use and bound
   * to the exact build launched, so every (re)connection acquires a fresh one.
   */
  principalSessions(): ClientPrincipalSessions {
    return {
      connectionGrant: async (principalId) => {
        const build = this.builds.get(principalId);
        if (!build) throw new Error(`No client launched for principal ${principalId}`);
        const grant = await this.grants.acquire(build);
        if (grant.principalId !== principalId) {
          throw new Error(`The server granted ${grant.principalId}, not ${principalId}`);
        }
        return grant.connectionGrant;
      },
      sessionEnded: (caller: ScopedServerCaller, reason: string) =>
        this.deps.channel.emit("clients.session-ended", { caller, reason }),
    };
  }

  private launcher(launchId: number): ClientLauncher {
    const launcher = this.launchers.get(launchId);
    if (!launcher) throw new Error("This launch has ended");
    return launcher;
  }

  private wire(state: LaunchState): LaunchStateWire {
    if (state.state !== "ready") return state;
    const { grant, ...launched } = state.launched;
    this.builds.set(grant.principalId, {
      source: launched.client.source,
      buildKey: launched.client.buildKey,
      executionDigest: launched.client.executionDigest,
    });
    return { state: "ready", launched: { ...launched, principalId: grant.principalId } };
  }

  private publish(launchId: number, state: LaunchState): void {
    this.deps.channel.emit("launch.state", { launchId, state: this.wire(state) });
  }
}

/**
 * The bytes of a cached artifact, only if they still match their declared
 * integrity. This is the one place cached bytes are checked before they are
 * served.
 */
export async function readVerifiedArtifact(
  store: Pick<ClientArtifactStore, "has" | "read">,
  integrity: string
): Promise<Uint8Array> {
  if (!(await store.has(integrity))) {
    throw new ClientLaunchError(
      "artifact-not-cached",
      "Client artifact is not in the verified cache"
    );
  }
  const bytes = await store.read(integrity);
  if ((await sha256Integrity(bytes)) !== integrity) {
    throw new ClientLaunchError(
      "integrity-mismatch",
      `The cached bytes no longer match their declared integrity ${integrity}`
    );
  }
  return bytes;
}
