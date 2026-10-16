import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import {
  ClientPrincipalGrantResponseSchema,
  clientsMethods,
  type ClientPrincipalGrantResponse,
} from "@vibestudio/service-schemas/clients";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import type {
  ClientArtifactDescriptor,
  ClientLaunchProgressPhase,
  ClientSelection,
  HostDescriptor,
  ReadyClient,
} from "@vibestudio/workspace-contracts/clients";
import type { ClientArtifactCache } from "./artifactCache.js";
import { ClientLaunchError } from "./errors.js";

/** One RPC call on the host's device shell session. */
export type Call = (service: string, method: string, args: unknown[]) => Promise<unknown>;

export interface PrincipalGrants {
  /** Obtain the connection grant for exactly this verified build. */
  acquire(build: {
    source: string;
    buildKey: string;
    executionDigest: string;
  }): Promise<ClientPrincipalGrantResponse>;
}

/** `auth.grantClientPrincipal` over the device session. */
export function principalGrantsOverCall(call: Call): PrincipalGrants {
  return {
    async acquire(build) {
      return ClientPrincipalGrantResponseSchema.parse(
        await call("auth", "grantClientPrincipal", [build])
      );
    },
  };
}

export interface VerifiedArtifact extends ClientArtifactDescriptor {
  /** Host handle of the verified bytes (a filesystem path, an asset URI). */
  handle: string;
}

export interface LaunchedClient {
  client: ReadyClient;
  artifacts: VerifiedArtifact[];
  grant: ClientPrincipalGrantResponse;
}

export type LaunchState =
  | { state: "approval-required"; approvals: PendingUnitInstallReviewApproval[] }
  | { state: "preparing"; phase: ClientLaunchProgressPhase; reason: string }
  | { state: "ready"; launched: LaunchedClient }
  | {
      state: "unavailable";
      reason: string;
      missing?: { capabilities?: string[]; hostAbi?: string };
    };

export interface LaunchOptions {
  /** Launch this retained build instead of the current one. */
  rollbackTo?: string;
}

export interface ClientLauncherOptions {
  /** The host's device shell session. */
  call: Call;
  descriptor: HostDescriptor;
  cache: ClientArtifactCache;
  grants: PrincipalGrants;
  /**
   * Sessions of workspaces started together with this one (an instance's first
   * start creates the account's System and Personal workspaces at once). Their
   * creation reviews join the launch gate so a person is asked once.
   */
  companions?: readonly Call[];
}

type ShellApprovalClient = ReturnType<typeof createTypedServiceClient<typeof shellApprovalMethods>>;

function isUnitInstallReview(value: unknown): value is PendingUnitInstallReviewApproval {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "unit-install-review" &&
    typeof (value as { approvalId?: unknown }).approvalId === "string"
  );
}

/**
 * The launch state machine of §4.5. `launch` resolves to the state the server
 * reported (after delivery, for `ready`). A `preparing` or `approval-required`
 * state is left as it is: the launcher tries again only when the host reports
 * an event (`onClientsChanged`) or the person answers the gate
 * (`resolveApprovals`), never on a timer.
 */
export class ClientLauncher {
  private readonly clients;
  private readonly shellApproval: ShellApprovalClient;
  private readonly companions: ShellApprovalClient[];
  private readonly companionOwners = new Map<
    PendingUnitInstallReviewApproval,
    ShellApprovalClient
  >();
  private readonly listeners = new Set<(state: LaunchState) => void>();
  private last: { select: ClientSelection; options: LaunchOptions } | null = null;
  private lastState: LaunchState | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ClientLauncherOptions) {
    this.clients = createTypedServiceClient("clients", clientsMethods, options.call);
    this.shellApproval = createTypedServiceClient("shellApproval", shellApprovalMethods, options.call);
    this.companions = (options.companions ?? []).map((companion) =>
      createTypedServiceClient("shellApproval", shellApprovalMethods, companion)
    );
  }

  /** Every state the launcher reaches, including those of re-attempts. */
  subscribe(listener: (state: LaunchState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state(): LaunchState | null {
    return this.lastState;
  }

  launch(select: ClientSelection, options: LaunchOptions = {}): Promise<LaunchState> {
    this.last = { select, options };
    return this.attempt();
  }

  /**
   * The host observed a clients/supervision change. Re-attempts only a launch
   * that is waiting on the server (`preparing`); resolves null otherwise.
   */
  onClientsChanged(): Promise<LaunchState | null> {
    if (!this.last || this.lastState?.state !== "preparing") return Promise.resolve(null);
    return this.attempt();
  }

  /**
   * Relay the person's answer to the launch gate, then (when allowed) launch
   * again so the server proceeds. Companion reviews are answered in their own
   * workspaces.
   */
  async resolveApprovals(
    approvals: readonly PendingUnitInstallReviewApproval[],
    decision: "once" | "deny"
  ): Promise<LaunchState | null> {
    const byOwner = new Map<ShellApprovalClient, string[]>();
    for (const approval of approvals) {
      const owner = this.companionOwners.get(approval) ?? this.shellApproval;
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), approval.approvalId]);
    }
    await Promise.all(
      [...byOwner].map(([owner, ids]) => owner.resolveBootstrap(ids, decision))
    );
    return decision === "once" && this.last ? this.attempt() : null;
  }

  private attempt(): Promise<LaunchState> {
    const run = this.tail.then(() => this.run());
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async run(): Promise<LaunchState> {
    const { select, options } = this.last!;
    const result = await this.clients.launch({
      host: this.options.descriptor,
      select,
      ...(options.rollbackTo ? { rollbackTo: options.rollbackTo } : {}),
    });
    let state: LaunchState;
    switch (result.state) {
      case "ready":
        state = { state: "ready", launched: await this.deliver(result.client) };
        break;
      case "approval-required":
        state = await this.gate(result.approvals);
        break;
      case "preparing":
        state = { state: "preparing", phase: result.phase, reason: result.reason };
        break;
      case "unavailable":
        state = {
          state: "unavailable",
          reason: result.reason,
          ...(result.missing ? { missing: result.missing } : {}),
        };
        break;
    }
    this.lastState = state;
    for (const listener of [...this.listeners]) listener(state);
    return state;
  }

  private async deliver(client: ReadyClient): Promise<LaunchedClient> {
    const expected = this.options.descriptor.runtimes[client.runtime];
    if (client.hostAbi !== expected) {
      throw new ClientLaunchError(
        "host-abi-mismatch",
        `${client.id} needs host ABI ${client.hostAbi}; this host implements ${expected ?? `no ${client.runtime} runtime`}.`
      );
    }
    const artifacts = await Promise.all(
      client.artifacts.map(async (artifact): Promise<VerifiedArtifact> => ({
        ...artifact,
        handle: await this.options.cache.ensure(artifact),
      }))
    );
    const grant = await this.options.grants.acquire({
      source: client.source,
      buildKey: client.buildKey,
      executionDigest: client.executionDigest,
    });
    return { client, artifacts, grant };
  }

  /** The server's approvals, plus companion workspaces' creation reviews; waits while one is preparing. */
  private async gate(raw: readonly unknown[]): Promise<LaunchState> {
    const approvals: PendingUnitInstallReviewApproval[] = [];
    for (const approval of raw) {
      if (!isUnitInstallReview(approval)) {
        throw new Error("clients.launch returned an approval this host cannot relay");
      }
      approvals.push(approval);
    }
    this.companionOwners.clear();
    for (const owner of this.companions) {
      const review = await owner.getWorkspaceCreationReviewState();
      if (review.status === "preparing") {
        return { state: "preparing", phase: "resolve", reason: "Getting your workspaces ready" };
      }
      if (review.status !== "pending") continue;
      const listed = await owner.listPending();
      const found = (listed as readonly unknown[]).find(
        (a): a is PendingUnitInstallReviewApproval =>
          isUnitInstallReview(a) && a.approvalId === review.approvalId
      );
      if (!found || approvals.some((a) => a.approvalId === found.approvalId)) continue;
      approvals.push(found);
      this.companionOwners.set(found, owner);
    }
    return { state: "approval-required", approvals };
  }
}
