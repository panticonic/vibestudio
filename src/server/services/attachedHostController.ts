import type { CapabilityScope } from "@vibestudio/rpc";
import { randomUUID } from "node:crypto";
import type {
  ServiceMethodSchemas,
  TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import type { DevelopmentInstance, DevelopmentRun } from "@vibestudio/service-schemas/development";
import {
  AttachedHostEndpoint,
  type AttachedHostChildAcceptance,
  type AttachedHostInvocationEnvelope,
  type AttachedHostParentHello,
  type AttachedHostSessionFacts,
  type AttachedHostSessionProof,
} from "./attachedHostProtocol.js";
import type { AttachedHostApprovalAuditEvent } from "@vibestudio/service-schemas/attachedHosts";

export interface AttachedHostBootstrapPort {
  /**
   * Exchange over the exact generation's ordinary paired-device route.
   * Credential bytes remain owned by this port and are never returned.
   */
  exchange(hello: AttachedHostParentHello): Promise<AttachedHostChildAcceptance>;
  confirm(proof: AttachedHostSessionProof): Promise<void>;
  /**
   * Revoke the exact bootstrap device at the child authority source and remove
   * its local credential reference. Idempotent.
   */
  revoke(): Promise<void>;
  /** Test/diagnostic proof that the retired credential cannot route again. */
  verifyRevoked(): Promise<boolean>;
}

export interface AttachedHostRoutePort {
  invoke(envelope: AttachedHostInvocationEnvelope, args: unknown[]): Promise<unknown>;
  close(reason: string): Promise<void>;
  /** Reconnect only when the peer proves this exact session generation. */
  recover(input: {
    sessionId: string;
    childGenerationId: string;
  }): Promise<"recovered" | "generation-lost">;
}

export interface AttachedHostPublicationInput {
  run: Pick<
    DevelopmentRun,
    "runId" | "ownerRuntimeId" | "ownerRuntimeKind" | "ownerUserId" | "target" | "instance"
  >;
  parentHostId: string;
  authorityCeiling: readonly CapabilityScope[];
  bootstrap: AttachedHostBootstrapPort;
  route: AttachedHostRoutePort;
  ttlMs?: number;
}

export interface AttachedHostPublication {
  attachedHostSessionId: string;
  childGenerationId: string;
  authorityCeilingDigest: string;
  expiresAt: number;
}

export interface AttachedHostOwner {
  runtimeId: string;
  runtimeKind: DevelopmentRun["ownerRuntimeKind"];
  userId: string | null;
}

/**
 * Narrow RFS-4B → RFS-4C seam. Development orchestration supplies only a
 * secret-free ready instance and a one-use credential-owning port.
 */
export interface AttachedHostPublisher {
  attach(input: AttachedHostPublicationInput): Promise<AttachedHostPublication>;
  close(sessionId: string, reason: string): Promise<void>;
  recover(sessionId: string, generationId: string): Promise<"recovered" | "generation-lost">;
}

interface PublishedRoute {
  route: AttachedHostRoutePort;
  generationId: string;
}

export class AttachedHostController implements AttachedHostPublisher {
  private readonly routes = new Map<string, PublishedRoute>();

  constructor(
    private readonly parent: AttachedHostEndpoint,
    private readonly onRouteLost?: (input: {
      sessionId: string;
      developmentRunId: string;
      childGenerationId: string;
    }) => void
  ) {}

  async attach(input: AttachedHostPublicationInput): Promise<AttachedHostPublication> {
    const instance = requireAttachableInstance(input.run);
    const facts: AttachedHostSessionFacts = {
      parentHostId: input.parentHostId,
      childHostId: required(instance.serverId, "ready child server id"),
      childGenerationId: instance.generationId,
      developmentRunId: input.run.runId,
      initiatingRuntimeId: input.run.ownerRuntimeId,
      initiatingRuntimeKind: input.run.ownerRuntimeKind,
      initiatingUserId: input.run.ownerUserId,
    };
    const hello = this.parent.beginParent({
      facts,
      requestedAuthorityCeiling: input.authorityCeiling,
      ttlMs: input.ttlMs ?? 15 * 60_000,
    });
    let routeEstablished = false;
    try {
      const accepted = await input.bootstrap.exchange(hello);
      const proof = this.parent.confirmParent(accepted);
      await input.bootstrap.confirm(proof);
      routeEstablished = true;
    } catch (error) {
      this.parent.close(hello.sessionId, "bootstrap-failed");
      throw error;
    } finally {
      // Once the child accepted a route proof, revocation failure is fatal:
      // keeping both paths would be a downgrade surface, not a repairable
      // convenience.
      if (routeEstablished) await input.bootstrap.revoke();
    }
    if (!(await input.bootstrap.verifyRevoked())) {
      this.parent.close(hello.sessionId, "bootstrap-not-revoked");
      await input.route.close("bootstrap-not-revoked");
      throw attachedError(
        "EATTACHED_BOOTSTRAP",
        "Attached-host bootstrap credential remained usable after route establishment"
      );
    }
    this.routes.set(hello.sessionId, {
      route: input.route,
      generationId: instance.generationId,
    });
    const record = this.parent.sessionRecord(hello.sessionId);
    if (!record) throw attachedError("EATTACHED_SESSION", "Attached-host session was not recorded");
    return {
      attachedHostSessionId: hello.sessionId,
      childGenerationId: instance.generationId,
      authorityCeilingDigest: record.transcript.authorityCeilingDigest,
      expiresAt: record.transcript.expiresAt,
    };
  }

  client<M extends ServiceMethodSchemas>(
    sessionId: string,
    service: string,
    methods: M
  ): TypedServiceClient<M> {
    const published = this.requireRoute(sessionId);
    return this.parent.createServiceClient(sessionId, service, methods, async (envelope, args) => {
      return await this.invokeRoute(sessionId, published, envelope, args);
    });
  }

  attachClient(
    sessionId: string,
    owner: AttachedHostOwner
  ): {
    sessionId: string;
    developmentRunId: string;
    childHostId: string;
    childGenerationId: string;
    authorityCeilingDigest: string;
    expiresAt: number;
  } {
    this.requireRoute(sessionId);
    const record = this.parent.sessionRecord(sessionId);
    if (!record || record.state !== "active") {
      throw attachedError("EATTACHED_SESSION", "Attached-host session is not active");
    }
    assertOwner(record.transcript, owner);
    return {
      sessionId,
      developmentRunId: record.transcript.developmentRunId,
      childHostId: record.transcript.childHostId,
      childGenerationId: record.transcript.childGenerationId,
      authorityCeilingDigest: record.transcript.authorityCeilingDigest,
      expiresAt: record.transcript.expiresAt,
    };
  }

  async invokeAttached(
    sessionId: string,
    owner: AttachedHostOwner,
    service: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const published = this.requireRoute(sessionId);
    this.attachClient(sessionId, owner);
    const envelope = this.parent.createInvocation({
      sessionId,
      service,
      method,
      args,
      requestId: randomUUID(),
      ttlMs: 30_000,
    });
    return await this.invokeRoute(sessionId, published, envelope, args);
  }

  listApprovalAudit(
    sessionId: string,
    owner: AttachedHostOwner,
    input: { after?: string; limit?: number }
  ): { events: AttachedHostApprovalAuditEvent[]; nextCursor: string | null } {
    this.attachClient(sessionId, owner);
    const limit = input.limit ?? 50;
    const rows = this.parent.listApprovalAudit({
      sessionId,
      after: input.after ?? null,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const transcript = this.requireTranscript(sessionId);
    const events = rows.slice(0, limit).map((row) => ({
      cursor: row.cursor,
      sessionId: row.challenge.sessionId,
      developmentRunId: transcript.developmentRunId,
      childGenerationId: row.challenge.childGenerationId,
      requestId: row.challenge.requestId,
      service: row.challenge.invocationSnapshot.service,
      method: row.challenge.invocationSnapshot.method,
      invocationSnapshotDigest: row.challenge.invocationSnapshotDigest,
      preparedOperationDigest: row.challenge.preparedOperationDigest,
      shownPresentationDigest: row.shownPresentationDigest,
      decision: row.decision,
      challengedAt: row.challengedAt,
      decidedAt: row.decidedAt,
    }));
    return {
      events,
      nextCursor: hasMore ? (events.at(-1)?.cursor ?? null) : null,
    };
  }

  async close(sessionId: string, reason: string): Promise<void> {
    const published = this.routes.get(sessionId);
    const record = this.parent.sessionRecord(sessionId);
    this.parent.close(sessionId, reason);
    this.routes.delete(sessionId);
    if (published) await published.route.close(reason);
    if (record && reason === "route-lost") {
      this.onRouteLost?.({
        sessionId,
        developmentRunId: record.transcript.developmentRunId,
        childGenerationId: record.transcript.childGenerationId,
      });
    }
  }

  async recover(sessionId: string, generationId: string): Promise<"recovered" | "generation-lost"> {
    const route = this.routes.get(sessionId);
    const record = this.parent.sessionRecord(sessionId);
    if (
      !route ||
      !record ||
      record.state !== "active" ||
      route.generationId !== generationId ||
      record.transcript.childGenerationId !== generationId
    ) {
      await this.close(sessionId, "generation-lost");
      return "generation-lost";
    }
    const result = await route.route.recover({
      sessionId,
      childGenerationId: generationId,
    });
    if (result === "generation-lost") await this.close(sessionId, "generation-lost");
    return result;
  }

  private requireRoute(sessionId: string): PublishedRoute {
    const route = this.routes.get(sessionId);
    if (!route) throw attachedError("EATTACHED_ROUTE", "Attached-host route is not live");
    return route;
  }

  private requireTranscript(sessionId: string) {
    const record = this.parent.sessionRecord(sessionId);
    if (!record) throw attachedError("EATTACHED_SESSION", "Attached-host session was not recorded");
    return record.transcript;
  }

  private async invokeRoute(
    sessionId: string,
    published: PublishedRoute,
    envelope: AttachedHostInvocationEnvelope,
    args: unknown[]
  ): Promise<unknown> {
    try {
      return await published.route.invoke(envelope, args);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "EAPPROVALROUTELOST"
      ) {
        await this.close(sessionId, "route-lost");
      }
      throw error;
    }
  }
}

function assertOwner(
  transcript: import("@vibestudio/service-schemas/attachedHosts").AttachedHostTranscript,
  owner: AttachedHostOwner
): void {
  if (
    transcript.initiatingRuntimeId !== owner.runtimeId ||
    transcript.initiatingRuntimeKind !== owner.runtimeKind ||
    transcript.initiatingUserId !== owner.userId
  ) {
    throw attachedError("EATTACHED_OWNER", "Attached-host session belongs to another owner");
  }
}

function requireAttachableInstance(
  run: AttachedHostPublicationInput["run"]
): DevelopmentInstance {
  if (run.target.kind !== "isolated-host") {
    throw attachedError("EATTACHED_TARGET", "Only an isolated development host can be attached");
  }
  if (!run.instance || run.instance.state !== "ready") {
    throw attachedError(
      "EATTACHED_GENERATION",
      "Attachment requires the run's exact ready child generation"
    );
  }
  return run.instance;
}

function required(value: string | null, label: string): string {
  if (!value) throw attachedError("EATTACHED_READINESS", `Attachment is missing ${label}`);
  return value;
}

function attachedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
