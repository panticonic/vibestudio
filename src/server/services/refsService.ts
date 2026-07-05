/**
 * refs service — the RPC surface over the host-owned protected MAIN-ref table
 * ({@link RefService}). Reads (`readMain`/`listMains`) are broadly available to
 * anyone who can hold source. The single write — `updateMains` —
 * is restricted to ONE writer: the gad-store DO backing the workspace `vcs`
 * service declaration, matched by TARGET IDENTITY (`do:{source}:{className}:
 * {objectKey}` from `resolveVcsStoreBinding`), not by caller kind (§3). Every
 * other caller gets a structured policy rejection.
 *
 * On-behalf-of (§4): `updateMains` may carry an `invocationToken` — a host-minted
 * correlation nonce the host resolves against its own invocation table to
 * attribute the advance to the ORIGINATING principal. The token is never a
 * credential; a missing token attributes the advance to the DO itself, and an
 * invalid/expired/foreign token fails the advance closed.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceAccessError } from "@vibestudio/shared/serviceDispatcher";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { refsMethods, updateMainsInputSchema } from "@vibestudio/shared/serviceSchemas/refs";
import type { RefService } from "./refService.js";
import type { RefAdvanceGateContext } from "./mainAdvanceApproval.js";
import type { VcsInvocationRecord, VcsInvocationTable } from "./vcsInvocationTable.js";

export interface RefsServiceDeps {
  refs: RefService;
  /**
   * The single-writer identity: `do:{source}:{className}:{objectKey}` for the
   * DO backing the workspace `vcs` service declaration
   * (`resolveVcsStoreBinding`), or null when no such binding exists. Recomputed
   * per call so a meta-change re-declaration is picked up (and a second/fake DO
   * never matches).
   */
  getVcsWriterIdentity: () => string | null;
  /** The host invocation-token table for on-behalf-of resolution (§4). */
  invocations: VcsInvocationTable;
}

/**
 * The invocation token is a host-side correlation record, NOT a credential. It
 * authorizes nothing on its own: the real gate on a main advance is the host's
 * own content diff + user consent (D3). We only assert its IDENTITY binding —
 * that it is a refs-writer record minted at the relay for THIS single VCS
 * writer DO — so a foreign or repurposed token can never masquerade as the
 * writer's on-behalf-of principal. It carries no VCS-operation scope.
 */
function assertInvocationRecordScoped(input: {
  record: VcsInvocationRecord;
  writerIdentity: string;
  actualWriterId: string;
}): void {
  if (input.record.type !== "refs.updateMains") {
    throw new Error("refs.updateMains: invocation token has the wrong purpose");
  }
  if (input.record.via !== input.writerIdentity || input.record.via !== input.actualWriterId) {
    throw new Error("refs.updateMains: invocation token was minted for a different VCS writer");
  }
}

export function createRefsService(deps: RefsServiceDeps): ServiceDefinition {
  return {
    name: "refs",
    description:
      "Protected host main refs (repoPath → main): broad read/log access; the updateMains group compare-and-swap is DO-only and invocation-token checked.",
    policy: { allowed: ["panel", "app", "worker", "do", "shell", "server", "extension"] },
    methods: refsMethods,
    handler: async (ctx, method, args) => {
      switch (method) {
        case "readMain": {
          const [repoPath] = args as [string];
          return deps.refs.readMain(repoPath);
        }
        case "listMains": {
          return deps.refs.listMains();
        }
        case "listMainRefLog": {
          const [input] = args as [{ repoPath: string; sinceId?: number }];
          return deps.refs.listMainRefLog(input.repoPath, input.sinceId);
        }
        case "updateMains": {
          const input = updateMainsInputSchema.parse(args[0]);

          // Single-writer policy (§3): only the DO backing the workspace `vcs`
          // service declaration, matched by TARGET IDENTITY — not runtime.kind.
          // A panel/app/worker/extension, a non-writer DO, or a re-declared fake
          // `vcs` service (whose identity differs) all fail here.
          const writerIdentity = deps.getVcsWriterIdentity();
          if (
            ctx.caller.runtime.kind !== "do" ||
            writerIdentity === null ||
            ctx.caller.runtime.id !== writerIdentity
          ) {
            throw new ServiceAccessError(
              "refs",
              "updateMains",
              ctx.caller.runtime.kind,
              "refs.updateMains is restricted to the workspace VCS store DO"
            );
          }

          // On-behalf-of resolution (§4). The token is a correlation nonce, NOT
          // a credential: identity comes ONLY from the host invocation table.
          let gateCaller: VerifiedCaller = ctx.caller;
          let via: string | undefined;
          if (input.invocationToken !== undefined) {
            const record = deps.invocations.resolve(input.invocationToken);
            if (!record) {
              // Invalid / expired / foreign → fail closed (never silently
              // attribute to the DO).
              throw new Error("refs.updateMains: invalid or expired invocation token");
            }
            assertInvocationRecordScoped({
              record,
              writerIdentity,
              actualWriterId: ctx.caller.runtime.id,
            });
            gateCaller = record.caller;
            via = ctx.caller.runtime.id;
          }

          const gateContext: RefAdvanceGateContext = {
            kind: "caller",
            caller: gateCaller,
            ...(via ? { via } : {}),
          };

          // Capture the token-resolved attribution into the main-ref log BEFORE
          // it is discarded (§2/§4.1): `writer` is the single VCS writer DO
          // (this call's runtime identity), `onBehalfOf` is the originating
          // principal (`gateCaller` — the DO itself when no token was resolved).
          return await deps.refs.updateMains({
            entries: input.entries,
            gateContext,
            operation: input.operation,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            writer: ctx.caller.runtime.id,
            onBehalfOf: gateCaller,
          });
        }
        default:
          throw new Error(`Unknown refs method: ${method}`);
      }
    },
  };
}
