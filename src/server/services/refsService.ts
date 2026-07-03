/**
 * refs service — the RPC surface over the host-owned protected MAIN-ref table
 * ({@link RefService}). Reads (`readMain`/`listMains`/`readMainLog`) are broadly
 * available to anyone who can hold source. The single write — `updateMains` —
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

import type { ServiceDefinition } from "@vibez1/shared/serviceDefinition";
import { ServiceAccessError } from "@vibez1/shared/serviceDispatcher";
import type { VerifiedCaller } from "@vibez1/shared/serviceDispatcher";
import { refsMethods, updateMainsInputSchema } from "@vibez1/shared/serviceSchemas/refs";
import type { RefService } from "./refService.js";
import type { MainAdvanceOperation, RefAdvanceGateContext } from "./mainAdvanceApproval.js";
import {
  vcsInvocationMethodAllowsOperation,
  type VcsInvocationRecord,
  type VcsInvocationTable,
} from "./vcsInvocationTable.js";

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

/** The RPC `operation` frames the approval prompt; the gate's advance path only
 *  distinguishes push vs merge (delete/restore/import frame as push-class). */
function advanceOperationLabel(operation: string): MainAdvanceOperation {
  return operation === "merge" ? "merge" : "push";
}

function assertInvocationRecordScoped(input: {
  record: VcsInvocationRecord;
  operation: string;
  writerIdentity: string;
  actualWriterId: string;
}): void {
  if (input.record.type !== "refs.updateMains") {
    throw new Error("refs.updateMains: invocation token has the wrong purpose");
  }
  if (input.record.via !== input.writerIdentity || input.record.via !== input.actualWriterId) {
    throw new Error("refs.updateMains: invocation token was minted for a different VCS writer");
  }
  if (input.record.operation !== input.operation) {
    throw new Error(
      `refs.updateMains: invocation token scoped to ${input.record.operation}, not ${input.operation}`
    );
  }
  if (!vcsInvocationMethodAllowsOperation(input.record.method, input.record.operation)) {
    throw new Error(
      `refs.updateMains: invocation token method ${input.record.method} is not scoped to ${input.record.operation}`
    );
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
        case "readMainLog": {
          const [query] = args as [{ repoPath: string; limit?: number }];
          return deps.refs.readMainLog({
            repoPath: query.repoPath,
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
          });
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
          let onBehalfOf: string | null = null;
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
              operation: input.operation,
              writerIdentity,
              actualWriterId: ctx.caller.runtime.id,
            });
            gateCaller = record.caller;
            onBehalfOf = `${record.caller.runtime.kind}:${record.caller.runtime.id}`;
            via = ctx.caller.runtime.id;
          }

          const gateContext: RefAdvanceGateContext = {
            kind: "caller",
            caller: gateCaller,
            operation: advanceOperationLabel(input.operation),
            ...(via ? { via } : {}),
          };

          return await deps.refs.updateMains({
            entries: input.entries,
            operation: input.operation,
            reason:
              input.reason ?? `refs.updateMains (${input.operation}) by ${ctx.caller.runtime.id}`,
            writer: `${ctx.caller.runtime.kind}:${ctx.caller.runtime.id}`,
            onBehalfOf,
            gateContext,
          });
        }
        default:
          throw new Error(`Unknown refs method: ${method}`);
      }
    },
  };
}
