import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { selectedWorkspacePath } from "@vibestudio/shared/connect";
import {
  attachedHostChildAcceptanceSchema,
  attachedHostApprovalChallengeSchema,
  attachedHostApprovalDecisionSchema,
  attachedHostInvocationEnvelopeSchema,
  attachedHostSessionProofSchema,
  type AttachedHostChildAcceptance,
  type AttachedHostApprovalChallenge,
  type AttachedHostApprovalDecision,
  type AttachedHostInvocationEnvelope,
  type AttachedHostParentHello,
  type AttachedHostSessionProof,
} from "@vibestudio/service-schemas/attachedHosts";
import { loadCliCredentials, type CliCredentials } from "../../cli/credentialStore.js";
import { RpcClient } from "../../cli/rpcClient.js";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { AttachedHostBootstrapPort, AttachedHostRoutePort } from "./attachedHostController.js";
import { AttachedHostEndpoint } from "./attachedHostProtocol.js";
import type { AttachedHostApprovalPresenter } from "./attachedHostApprovalPresenter.js";

const MAX_ROUTE_BODY_BYTES = 2 * 1024 * 1024;

/**
 * One-use ordinary paired-device bootstrap. Credential bytes remain private to
 * this object, are never returned to development orchestration, and are
 * dropped immediately after server-confirmed device revocation.
 */
export class CliAttachedHostBootstrapPort implements AttachedHostBootstrapPort {
  private credentials: CliCredentials | null = null;
  private client: Pick<RpcClient, "call" | "close"> | null = null;
  private revoked = false;
  private revocationConfirmed = false;

  constructor(
    private readonly credentialFile: string,
    private readonly childGatewayUrl: string,
    private readonly operations: {
      load: typeof loadCliCredentials;
      createClient: (
        credentials: CliCredentials,
        childGatewayUrl: string
      ) => Pick<RpcClient, "call" | "close">;
      revoke: (
        credentials: CliCredentials,
        deviceId: string,
        childGatewayUrl: string
      ) => Promise<{ revoked: boolean }>;
      exists: typeof fs.existsSync;
      unlink: typeof fs.unlinkSync;
    } = {
      load: loadCliCredentials,
      createClient: (credentials, childGatewayUrl) =>
        new RpcClient({
          url: workspaceGatewayEndpoint(childGatewayUrl, credentials.workspaceName),
          deviceId: credentials.deviceId,
          refreshToken: credentials.refreshToken,
        }),
      revoke: async (credentials, deviceId, childGatewayUrl) => {
        const rpc = new RpcClient({
          url: childGatewayUrl,
          deviceId: credentials.deviceId,
          refreshToken: credentials.refreshToken,
        });
        try {
          return await rpc.call<{ revoked: boolean }>("hubControl.revokeDevice", [deviceId]);
        } finally {
          await rpc.close();
        }
      },
      exists: fs.existsSync,
      unlink: fs.unlinkSync,
    }
  ) {}

  async exchange(hello: AttachedHostParentHello): Promise<AttachedHostChildAcceptance> {
    this.assertUsable();
    const result = await this.rpc().call("attachedHosts.bootstrapExchange", [hello]);
    return attachedHostChildAcceptanceSchema.parse(result);
  }

  async confirm(proof: AttachedHostSessionProof): Promise<void> {
    this.assertUsable();
    const canonicalProof = attachedHostSessionProofSchema.parse(proof);
    const result = (await this.rpc().call("attachedHosts.bootstrapConfirm", [
      canonicalProof,
    ])) as unknown;
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      (result as { attachedHostSessionId?: unknown }).attachedHostSessionId !==
        proof.transcript.sessionId
    ) {
      throw transportError(
        "EATTACHED_BOOTSTRAP",
        "Child did not confirm the exact attached-host session"
      );
    }
  }

  async revoke(): Promise<void> {
    if (this.revoked) return;
    const credentials = this.loadCredentials();
    await this.client?.close();
    this.client = null;
    const result = await this.operations.revoke(
      credentials,
      credentials.deviceId,
      this.childGatewayUrl
    );
    if (!result.revoked) {
      throw transportError(
        "EATTACHED_BOOTSTRAP",
        "Child did not revoke the exact bootstrap device"
      );
    }
    this.revocationConfirmed = true;
    this.revoked = true;
    this.credentials = null;
    if (this.operations.exists(this.credentialFile)) this.operations.unlink(this.credentialFile);
  }

  async verifyRevoked(): Promise<boolean> {
    return (
      this.revoked &&
      this.revocationConfirmed &&
      this.credentials === null &&
      this.client === null &&
      !this.operations.exists(this.credentialFile)
    );
  }

  private rpc(): Pick<RpcClient, "call" | "close"> {
    this.assertUsable();
    return (this.client ??= this.operations.createClient(
      this.loadCredentials(),
      this.childGatewayUrl
    ));
  }

  private loadCredentials(): CliCredentials {
    if (this.credentials) return this.credentials;
    const loaded = this.operations.load(this.credentialFile);
    if (!loaded) {
      throw transportError(
        "EATTACHED_BOOTSTRAP",
        "Exact isolated-host bootstrap credential is unavailable"
      );
    }
    return (this.credentials = loaded);
  }

  private assertUsable(): void {
    if (this.revoked) {
      throw transportError(
        "EATTACHED_BOOTSTRAP_REVOKED",
        "Attached-host bootstrap credential has been revoked"
      );
    }
  }
}

/**
 * Production attachment adapter. The one-use credential path is captured by
 * the bootstrap port and never exposed through development run state or public
 * service results.
 */
export function createAttachedHostPublicationPorts(input: {
  credentialFile: string;
  childGatewayUrl: string;
  childGenerationId: string;
  parentEndpoint: AttachedHostEndpoint;
}): {
  bootstrap: AttachedHostBootstrapPort;
  route: AttachedHostRoutePort;
} {
  return {
    bootstrap: new CliAttachedHostBootstrapPort(input.credentialFile, input.childGatewayUrl),
    route: new HttpAttachedHostRoutePort({
      gatewayUrl: input.childGatewayUrl,
      childGenerationId: input.childGenerationId,
      endpoint: input.parentEndpoint,
    }),
  };
}

export function workspaceGatewayEndpoint(gatewayUrl: string, workspaceName: string): string {
  const endpoint = new URL(gatewayUrl);
  endpoint.pathname = selectedWorkspacePath(workspaceName);
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/u, "");
}

/**
 * Post-bootstrap route over the existing loopback service-route ingress.
 * The route is intentionally public at the HTTP layer: the exact v1 Ed25519
 * envelope is its sole authentication, so there is no bearer/admin fallback.
 */
export class HttpAttachedHostRoutePort implements AttachedHostRoutePort {
  private closed = false;

  constructor(
    private readonly input: {
      gatewayUrl: string;
      childGenerationId: string;
      endpoint: AttachedHostEndpoint;
      onRouteLost?: (sessionId: string) => void;
    }
  ) {
    assertLoopbackUrl(input.gatewayUrl);
  }

  async invoke(envelope: AttachedHostInvocationEnvelope, args: unknown[]): Promise<unknown> {
    if (this.closed) {
      throw transportError("EATTACHED_ROUTE", "Attached-host route is closed");
    }
    if (envelope.childGenerationId !== this.input.childGenerationId) {
      throw transportError(
        "EATTACHED_GENERATION",
        "Attached-host route invocation targets another session generation"
      );
    }
    const record = this.input.endpoint.sessionRecord(envelope.sessionId);
    if (
      !record ||
      record.state !== "active" ||
      record.transcript.childGenerationId !== this.input.childGenerationId
    ) {
      throw transportError("EATTACHED_SESSION", "Attached-host route session is not active");
    }
    try {
      return await postRoute(this.input.gatewayUrl, { envelope, args });
    } catch (error) {
      if (routeWasLost(error)) {
        this.input.endpoint.close(envelope.sessionId, "route-lost");
        this.closed = true;
        this.input.onRouteLost?.(envelope.sessionId);
        throw transportError(
          "EAPPROVALROUTELOST",
          `Attached-host route was lost: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      throw error;
    }
  }

  async close(_reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
  }

  async recover(input: {
    sessionId: string;
    childGenerationId: string;
  }): Promise<"recovered" | "generation-lost"> {
    if (this.closed || input.childGenerationId !== this.input.childGenerationId) {
      return "generation-lost";
    }
    const record = this.input.endpoint.sessionRecord(input.sessionId);
    return record?.state === "active" &&
      record.transcript.childGenerationId === input.childGenerationId &&
      record.transcript.expiresAt > Date.now()
      ? "recovered"
      : "generation-lost";
  }
}

/**
 * Child-side half of the live attached route. It is used by the canonical
 * authority acquisition seam even after the original parent invocation has
 * returned (for example, an asynchronous eval that later reaches a gated
 * operation).
 */
export class HttpAttachedHostApprovalClient {
  constructor(
    private readonly input: {
      parentGatewayUrl: string;
      endpoint: AttachedHostEndpoint;
    }
  ) {
    assertLoopbackUrl(input.parentGatewayUrl);
  }

  async present(
    challenge: AttachedHostApprovalChallenge,
    signal?: AbortSignal
  ): Promise<AttachedHostApprovalDecision> {
    try {
      return await postApprovalChallenge(this.input.parentGatewayUrl, challenge, signal);
    } catch (error) {
      this.input.endpoint.close(challenge.sessionId, "approval-route-lost");
      throw transportError(
        "EAPPROVALROUTELOST",
        `Attached-host approval route was lost: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export function attachedHostHttpRoutes(endpoint: AttachedHostEndpoint): ServiceRouteDecl[] {
  return [
    {
      serviceName: "attached-host-route",
      path: "/invoke",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            !Array.isArray((body as { args?: unknown }).args)
          ) {
            throw transportError("EATTACHED_ENVELOPE", "Malformed attached-host route body");
          }
          const envelope = attachedHostInvocationEnvelopeSchema.parse(
            (body as { envelope?: unknown }).envelope
          );
          const args = (body as { args: unknown[] }).args;
          const result = await endpoint.receiveInvocation(envelope, args);
          sendJson(res, 200, {
            ok: true,
            kind: "result",
            result: result === undefined ? null : result,
          });
        } catch (error) {
          const code =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof (error as { code?: unknown }).code === "string"
              ? (error as { code: string }).code
              : "EATTACHED_ROUTE";
          sendJson(res, statusFor(code), {
            ok: false,
            code,
            error: error instanceof Error ? error.message : "Attached-host route failed",
          });
        }
      },
    },
  ];
}

export function attachedHostParentHttpRoutes(
  endpoint: AttachedHostEndpoint,
  presenter: Pick<AttachedHostApprovalPresenter, "present">
): ServiceRouteDecl[] {
  return [
    {
      serviceName: "attached-host-route",
      path: "/challenge",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        try {
          const challenge = attachedHostApprovalChallengeSchema.parse(await readJsonBody(req));
          const decision = await presenter.present(challenge);
          sendJson(res, 200, {
            ok: true,
            decision: attachedHostApprovalDecisionSchema.parse(decision),
          });
        } catch (error) {
          const code =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof (error as { code?: unknown }).code === "string"
              ? (error as { code: string }).code
              : "EATTACHED_DECISION";
          sendJson(res, statusFor(code), {
            ok: false,
            code,
            error: error instanceof Error ? error.message : "Attached-host decision failed",
          });
        }
      },
    },
  ];
}

async function postRoute(
  gatewayUrl: string,
  body: { envelope: AttachedHostInvocationEnvelope; args: unknown[] }
): Promise<unknown> {
  const response = await fetch(new URL("/_r/s/attached-host-route/invoke", gatewayUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: unknown;
    result?: unknown;
    kind?: unknown;
    challenge?: unknown;
    error?: unknown;
    code?: unknown;
  };
  if (!response.ok || payload.ok !== true || payload.kind !== "result") {
    throw transportError(
      typeof payload.code === "string" ? payload.code : "EATTACHED_ROUTE",
      typeof payload.error === "string"
        ? payload.error
        : `Attached-host route failed with HTTP ${response.status}`
    );
  }
  return payload.result;
}

async function postApprovalChallenge(
  gatewayUrl: string,
  challenge: AttachedHostApprovalChallenge,
  signal?: AbortSignal
): Promise<AttachedHostApprovalDecision> {
  const response = await fetch(new URL("/_r/s/attached-host-route/challenge", gatewayUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attachedHostApprovalChallengeSchema.parse(challenge)),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)])
      : AbortSignal.timeout(5 * 60_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: unknown;
    decision?: unknown;
    code?: unknown;
    error?: unknown;
  };
  if (!response.ok || payload.ok !== true) {
    throw transportError(
      typeof payload.code === "string" ? payload.code : "EATTACHED_DECISION",
      typeof payload.error === "string"
        ? payload.error
        : `Attached-host decision failed with HTTP ${response.status}`
    );
  }
  return attachedHostApprovalDecisionSchema.parse(payload.decision);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_ROUTE_BODY_BYTES) {
      throw transportError("EATTACHED_ENVELOPE", "Attached-host route body exceeds its bound");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function statusFor(code: string): number {
  if (code === "EATTACHED_EXPIRY" || code === "EATTACHED_SESSION") return 410;
  if (
    code === "EATTACHED_SIGNATURE" ||
    code === "EATTACHED_BINDING" ||
    code === "EATTACHED_REPLAY" ||
    code === "EATTACHED_CEILING"
  ) {
    return 403;
  }
  return 400;
}

function routeWasLost(error: unknown): boolean {
  return (
    !(typeof error === "object" && error !== null && "code" in error) ||
    (error as { code?: unknown }).code === "EATTACHED_ROUTE" ||
    (error as { code?: unknown }).code === "EAPPROVALROUTELOST"
  );
}

function assertLoopbackUrl(raw: string): void {
  const parsed = new URL(raw);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
  ) {
    throw transportError(
      "EATTACHED_DOWNGRADE",
      "Attached-host route requires the exact loopback child gateway"
    );
  }
}

function transportError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
