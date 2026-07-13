import type { CallerKind } from "@vibestudio/rpc";
import type { AgentBinding, UserSubject } from "./types.js";

/**
 * Domain seam for resolving a transport principal to its host-verified account.
 * Implementations may consult hub-owned identity data; transports only consume
 * this interface and do not own account attribution rules.
 */
export interface UserSubjectSource {
  resolve(
    callerId: string,
    callerKind: CallerKind,
    agentBinding?: AgentBinding
  ): UserSubject | null;
}
