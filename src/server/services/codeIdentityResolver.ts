export interface ResolvedCodeIdentity {
  callerId: string;
  callerKind: "worker" | "panel";
  repoPath: string;
  effectiveVersion: string;
}

export class CodeIdentityResolver {
  private readonly byCallerId = new Map<string, ResolvedCodeIdentity>();

  upsertCallerIdentity(identity: ResolvedCodeIdentity): void {
    this.byCallerId.set(identity.callerId, identity);
  }

  resolveByCallerId(callerId: string): ResolvedCodeIdentity | null {
    const exact = this.byCallerId.get(callerId);
    if (exact) return exact;

    const doServiceCallerId = serviceCallerIdForConcreteDo(callerId);
    if (!doServiceCallerId) return null;
    const serviceIdentity = this.byCallerId.get(doServiceCallerId);
    if (!serviceIdentity) return null;
    return {
      ...serviceIdentity,
      callerId,
    };
  }

  unregisterCaller(callerId: string): void {
    this.byCallerId.delete(callerId);
  }
}

function serviceCallerIdForConcreteDo(callerId: string): string | null {
  if (!callerId.startsWith("do:")) return null;
  const parts = callerId.slice("do:".length).split(":");
  if (parts.length < 3) return null;
  const source = parts[0];
  const className = parts[1];
  const objectKey = parts.slice(2).join(":");
  if (!source || !className || !objectKey) return null;
  return `do-service:${source}:${className}`;
}
