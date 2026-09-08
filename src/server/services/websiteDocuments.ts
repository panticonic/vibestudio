import type { WebsiteAuthorityFact, AuthorizationContext } from "@vibestudio/rpc";
import type { UserSubject } from "@vibestudio/identity/types";
import { matchingAuthorityGrants } from "@vibestudio/shared/authorization";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { authorizeVerifiedCaller } from "./authorityRuntime.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

const CONNECTION_CAPABILITY = "workspace.connect";

interface Document {
  runtimeId: string;
  documentId: string;
  hostId: string;
  user: UserSubject;
  fact: WebsiteAuthorityFact;
  lifetime: AbortController;
  connection?: Promise<boolean>;
  consentContext?: AuthorizationContext;
  connectionGrantId?: string;
  consentExpiry?: ReturnType<typeof setTimeout>;
  releaseExecution: () => void;
}

/** Native hosting owns document evidence; ordinary RPC owns operations after admission. */
export class WebsiteDocuments {
  private readonly documents = new Map<string, Document>();
  private readonly transitions = new Map<string, Promise<void>>();
  private closed = false;
  private readonly stopGrantWithdrawal: () => void;

  constructor(
    private readonly deps: {
      workspaceId: string;
      grants: CapabilityGrantStore;
      approvals: {
        request: (
          input: Parameters<ApprovalQueue["request"]>[0]
        ) => ReturnType<ApprovalQueue["request"]>;
      };
      isHostForRuntime: (hostId: string, runtimeId: string, user: UserSubject) => boolean;
      retireRuntime: (runtimeId: string) => Promise<void>;
      changed: (runtimeId: string, connected: boolean, documentId: string, userId: string) => void;
    }
  ) {
    this.stopGrantWithdrawal = deps.grants.onGrantWithdrawal((grant) => {
      for (const doc of this.documents.values()) {
        if (doc.connectionGrantId === grant.id)
          void this.end(doc.runtimeId, doc.documentId).catch(() => {});
      }
    });
  }

  list(
    userId: string
  ): Array<{ runtimeId: string; documentId: string; origin: string; connected: boolean }> {
    return [...this.documents.values()]
      .filter((doc) => doc.user.userId === userId && this.live(doc))
      .map((doc) => ({
        runtimeId: doc.runtimeId,
        documentId: doc.documentId,
        origin: doc.fact.origin,
        connected: doc.fact.connected,
      }));
  }

  async begin(input: {
    runtimeId: string;
    documentId: string;
    hostId: string;
    user: UserSubject;
    origin: string;
  }): Promise<void> {
    return this.transition(input.runtimeId, () => this.beginDocument(input));
  }

  private async beginDocument(input: {
    runtimeId: string;
    documentId: string;
    hostId: string;
    user: UserSubject;
    origin: string;
  }): Promise<void> {
    if (this.closed) throw new Error("Website hosting is closed");
    if (!input.documentId || !this.deps.isHostForRuntime(input.hostId, input.runtimeId, input.user))
      throw new Error("Website document is not owned by this authenticated host");
    const previous = this.documents.get(input.runtimeId);
    if (previous?.documentId === input.documentId) {
      if (
        previous.hostId !== input.hostId ||
        previous.user.userId !== input.user.userId ||
        previous.fact.origin !== input.origin
      )
        throw new Error("A document identity cannot be rebound");
      return;
    }
    await this.endDocument(input.runtimeId);
    // Ownership can change while the old transport is being retired.
    if (this.closed || !this.deps.isHostForRuntime(input.hostId, input.runtimeId, input.user))
      throw new Error("Website host ownership changed");
    const subject = this.deps.grants.ensureWebsiteSubject({
      userId: `user:${input.user.userId}`,
      workspaceId: this.deps.workspaceId,
      origin: input.origin,
    });
    const binding = {
      subject: subject.subject,
      generation: subject.generation,
      documentId: input.documentId,
    };
    const releaseExecution = this.deps.grants.registerSubjectExecution(binding, () => {
      const doc = this.documents.get(input.runtimeId);
      return Boolean(doc && doc.documentId === input.documentId && this.live(doc));
    });
    this.documents.set(input.runtimeId, {
      ...input,
      lifetime: new AbortController(),
      releaseExecution,
      fact: {
        subject: subject.subject,
        userId: subject.userId,
        workspaceId: subject.workspaceId,
        origin: subject.identityKey,
        connected: false,
        binding,
      },
    });
  }

  fact(runtimeId: string): WebsiteAuthorityFact | null {
    const doc = this.documents.get(runtimeId);
    if (!doc || !this.live(doc)) return null;
    return { ...doc.fact, binding: { ...doc.fact.binding } };
  }

  isLive(runtimeId: string, fact: WebsiteAuthorityFact): boolean {
    const doc = this.documents.get(runtimeId);
    return Boolean(
      doc &&
      this.live(doc) &&
      doc.fact.connected &&
      fact.connected &&
      doc.fact.subject === fact.subject &&
      doc.documentId === fact.binding.documentId &&
      doc.fact.binding.generation === fact.binding.generation &&
      doc.fact.origin === fact.origin &&
      doc.fact.userId === fact.userId &&
      doc.fact.workspaceId === fact.workspaceId
    );
  }

  private live(doc: Document): boolean {
    if (doc.fact.connected) {
      if (!doc.consentContext || !doc.connectionGrantId) return false;
      const consent = matchingAuthorityGrants({
        context: doc.consentContext,
        grants: this.deps.grants.grantsForSubjects([doc.fact.subject], CONNECTION_CAPABILITY),
        subjects: new Set([doc.fact.subject]),
        capability: CONNECTION_CAPABILITY,
        resourceKey: this.deps.workspaceId,
      });
      if (
        consent.some((grant) => grant.effect === "deny") ||
        !consent.some((grant) => grant.effect === "allow" && grant.id === doc.connectionGrantId)
      )
        return false;
    }
    return (
      !this.closed &&
      !doc.lifetime.signal.aborted &&
      this.documents.get(doc.runtimeId) === doc &&
      this.deps.isHostForRuntime(doc.hostId, doc.runtimeId, doc.user) &&
      this.deps.grants.getAuthoritySubject(doc.fact.subject)?.generation ===
        doc.fact.binding.generation
    );
  }

  async forget(runtimeId: string, documentId: string, hostId: string): Promise<void> {
    const doc = this.documents.get(runtimeId);
    if (!doc || doc.documentId !== documentId || doc.hostId !== hostId || !this.live(doc))
      throw new Error("Website document is no longer current");
    await this.revoke(doc.fact.subject);
  }

  async end(runtimeId: string, documentId?: string, hostId?: string): Promise<void> {
    return this.transition(runtimeId, () => this.endDocument(runtimeId, documentId, hostId));
  }

  private async endDocument(
    runtimeId: string,
    documentId?: string,
    hostId?: string
  ): Promise<void> {
    const doc = this.documents.get(runtimeId);
    if (
      !doc ||
      (documentId !== undefined && doc.documentId !== documentId) ||
      (hostId !== undefined && doc.hostId !== hostId)
    )
      return;
    this.documents.delete(runtimeId);
    if (doc.consentExpiry) clearTimeout(doc.consentExpiry);
    doc.releaseExecution();
    doc.fact.connected = false;
    doc.lifetime.abort(new Error("Website document disconnected"));
    this.deps.changed(runtimeId, false, doc.fact.binding.documentId!, doc.user.userId);
    await this.deps.retireRuntime(runtimeId);
  }

  private transition(runtimeId: string, operation: () => Promise<void>): Promise<void> {
    const pending = (this.transitions.get(runtimeId) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.transitions.set(runtimeId, pending);
    const finished = () => {
      if (this.transitions.get(runtimeId) === pending) this.transitions.delete(runtimeId);
    };
    void pending.then(finished, finished);
    return pending;
  }

  connect(runtimeId: string, documentId: string, hostId: string): Promise<boolean> {
    const doc = this.documents.get(runtimeId);
    if (!doc || doc.documentId !== documentId || doc.hostId !== hostId || !this.live(doc))
      return Promise.reject(new Error("Website document is no longer current"));
    if (doc.fact.connected) return Promise.resolve(true);
    if (doc.connection) return doc.connection;
    // Concurrent requests share a prompt; a later deliberate request may retry.
    doc.connection = this.approveConnection(doc).finally(() => {
      doc.connection = undefined;
    });
    return doc.connection;
  }

  private async approveConnection(doc: Document): Promise<boolean> {
    const caller = {
      ...createVerifiedCaller(doc.runtimeId, "panel", null, null, doc.user),
      workspaceId: this.deps.workspaceId,
      website: doc.fact,
    };
    // This constructs authenticated facts for admission consent selection. It
    // does not run an operation or bypass evaluateAuthority's connection gate.
    const { context, grants } = authorizeVerifiedCaller(caller, {
      workspaceId: this.deps.workspaceId,
      workspaceMember: true,
      sessionId: doc.documentId,
      audience: "website-admission",
      capability: CONNECTION_CAPABILITY,
      resourceKey: this.deps.workspaceId,
      grantStore: this.deps.grants,
    });
    const consent = matchingAuthorityGrants({
      context,
      grants,
      subjects: new Set([doc.fact.subject]),
      capability: CONNECTION_CAPABILITY,
      resourceKey: this.deps.workspaceId,
    });
    if (consent.some((grant) => grant.effect === "deny")) return false;
    let allowed = consent.find(
      (grant) => grant.effect === "allow" && grant.consumedAt === undefined
    );
    if (!allowed) {
      const decision = await this.deps.approvals.request({
        kind: "capability",
        callerId: doc.runtimeId,
        callerKind: "panel",
        repoPath: "",
        effectiveVersion: "",
        requestedByUserId: doc.user.userId,
        capability: CONNECTION_CAPABILITY,
        title: `Connect ${doc.fact.origin} to this workspace?`,
        description: [
          "This website can request workspace operations. Access to additional resources is approved separately. Results you approve may be disclosed to this site.",
          "Only connect websites you trust. This site’s code can change independently of Vibestudio. Its approved operations can change this workspace; disconnecting does not undo completed actions or automatically cancel accepted work.",
          "Remembered access follows this website origin as its content changes; it does not pin a reviewed code version.",
          ...(doc.fact.origin.startsWith("http:")
            ? [
                "This site uses unencrypted HTTP. A network intermediary can change the code receiving approved workspace data.",
              ]
            : []),
          ...(new URL(doc.fact.origin).hostname.endsWith(".github.io")
            ? [
                "GitHub Pages projects under this owner domain share one origin. Remembered access applies across those repository paths.",
              ]
            : []),
        ].join(" "),
        authoritySubject: {
          principal: doc.fact.subject,
          website: {
            origin: doc.fact.origin,
            workspaceId: this.deps.workspaceId,
            documentId: doc.documentId,
          },
        },
        allowedDecisions: ["session", "always", "deny"],
        signal: doc.lifetime.signal,
      });
      if (!this.live(doc)) return false;
      if (decision !== "session" && decision !== "always") return false;
      allowed = this.deps.grants.issue({
        subject: doc.fact.subject,
        effect: "allow",
        capability: CONNECTION_CAPABILITY,
        resource: { kind: "exact", key: this.deps.workspaceId },
        constraints: {
          sourceWorkspaceId: this.deps.workspaceId,
          subjectGeneration: doc.fact.binding.generation,
          ...(decision === "session" ? { documentId: doc.documentId } : {}),
          lineageAtConsent: [],
        },
        scope: decision === "session" ? "session" : "system",
        issuedBy: `user:${doc.user.userId}`,
        provenance: "acquisition",
      });
    }
    if (!this.live(doc)) return false;
    doc.consentContext = context;
    doc.connectionGrantId = allowed.id;
    if (allowed.expiresAt !== undefined) {
      const expiresAt = allowed.expiresAt;
      const expire = () => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) void this.end(doc.runtimeId, doc.documentId).catch(() => {});
        else doc.consentExpiry = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      };
      expire();
    }
    doc.fact.connected = true;
    this.deps.changed(doc.runtimeId, true, doc.fact.binding.documentId!, doc.user.userId);
    return true;
  }

  async revoke(subject: `website:${string}`): Promise<void> {
    this.deps.grants.invalidateAuthoritySubject(subject);
    await Promise.all(
      [...this.documents.values()]
        .filter((doc) => doc.fact.subject === subject)
        .map((doc) => this.end(doc.runtimeId))
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopGrantWithdrawal();
    await Promise.allSettled([...this.transitions.values()]);
    await Promise.all([...this.documents.keys()].map((id) => this.end(id)));
  }
}
