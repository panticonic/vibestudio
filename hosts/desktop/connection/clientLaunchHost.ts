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
import type {
  ClientBuildIdentity,
  ClientLaunchNotice,
  LaunchStateWire,
  RetainedClientBuild,
} from "./connectionProtocol.js";

export interface ClientLaunchHostDeps {
  channel: ControlChannel;
  /** The device's session to the System workspace. */
  call: Call;
  /** Fetch one artifact route through the device session (`gateway.fetch`). */
  fetchArtifact: ClientArtifactFetch;
  store: ClientArtifactStore;
  companions?: readonly Call[];
  prepare?: () => Promise<{ notices: readonly ClientLaunchNotice[] }>;
}

/** The exact verified build a client principal is admitted for, and its credential. */
interface LaunchedBuild {
  build: ClientBuildIdentity;
  credential: string;
}

/**
 * Client launch, artifact verification and principal credentials, inside the
 * connection process (docs/client-hosts-and-clients-plan.md §5.1.1).
 *
 * Main asks for a launch and receives the launcher's states with handles of
 * artifacts this process verified; it never holds a client principal's
 * credential, a reusable bearer that only the sessions needing it read. The
 * launch pipeline acquires it once per launched build; main re-registers a
 * running build with a replacement process through `launch.adopt`. Bytes are read back
 * through `artifacts.read`, which is the single place a cached artifact is
 * checked against its declared integrity before anyone is served it.
 */
export class ClientLaunchHost {
  private readonly cache: ClientArtifactCache;
  private readonly grants: PrincipalGrants;
  private readonly launchers = new Map<number, ClientLauncher>();
  private readonly notices = new Map<number, readonly ClientLaunchNotice[]>();
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
          companions: deps.companions,
          ...(deps.prepare
            ? {
                prepare: async () => {
                  const result = await deps.prepare!();
                  this.notices.set(launchId, result.notices);
                },
              }
            : {}),
        });
        this.launchers.set(launchId, launcher);
        launcher.subscribe((state) => this.publish(launchId, state));
      }
      return launcher.launch(select).then((state) => this.wire(state, launchId));
    });
    channel.handle("launch.clients-changed", async ({ launchId }) => {
      const state = await this.launcher(launchId).onClientsChanged();
      return state && this.wire(state, launchId);
    });
    channel.handle("launch.resolve-approvals", async ({ launchId, decision }) => {
      const launcher = this.launcher(launchId);
      const state = launcher.state;
      if (state?.state !== "approval-required") {
        throw new Error("There is no review waiting on this launch");
      }
      const next = await launcher.resolveApprovals(state.approvals, decision);
      return next && this.wire(next, launchId);
    });
    channel.handle("launch.end", ({ launchId }) => {
      this.launchers.delete(launchId);
      this.notices.delete(launchId);
    });
    channel.handle("launch.adopt", async ({ build }) => {
      const grant = await this.grants.acquire(build);
      this.builds.set(grant.principalId, { build, credential: grant.credential });
      return grant.principalId;
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
   * Admits client principal sessions. The credential is reusable at every
   * workspace server the device reaches and is bound to the exact build
   * launched, so every session open and reconnect, in any workspace, presents
   * the one the launch acquired. `workspaceId` is the connection whose
   * sessions these are, so a reported end names where it happened.
   */
  principalSessions(workspaceId: string): ClientPrincipalSessions {
    return {
      credential: async (principalId) => {
        const launched = this.builds.get(principalId);
        if (!launched) throw new Error(`No client launched for principal ${principalId}`);
        return launched.credential;
      },
      sessionEnded: (caller: ScopedServerCaller, reason: string) =>
        this.deps.channel.emit("clients.session-ended", { caller, workspaceId, reason }),
    };
  }

  private launcher(launchId: number): ClientLauncher {
    const launcher = this.launchers.get(launchId);
    if (!launcher) throw new Error("This launch has ended");
    return launcher;
  }

  private wire(state: LaunchState, launchId: number): LaunchStateWire {
    if (state.state !== "ready") return state;
    const { grant, ...launched } = state.launched;
    this.builds.set(grant.principalId, {
      build: {
        source: launched.client.source,
        buildKey: launched.client.buildKey,
        executionDigest: launched.client.executionDigest,
      },
      credential: grant.credential,
    });
    const notices = this.notices.get(launchId);
    return {
      state: "ready",
      launched: {
        ...launched,
        principalId: grant.principalId,
        ...(notices?.length ? { notices } : {}),
      },
    };
  }

  private publish(launchId: number, state: LaunchState): void {
    this.deps.channel.emit("launch.state", { launchId, state: this.wire(state, launchId) });
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
