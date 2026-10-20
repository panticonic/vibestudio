/**
 * Hub → workspace-child fan-out that ends live sessions of revoked client
 * principals. Mirrors `/_r/s/sessions/close-device`: admin-token authenticated,
 * mounted by each child, called by the hub after identity.db revocation.
 */

import { z } from "zod";
import type { ServiceRouteDecl } from "./routeRegistry.js";

export const CLOSE_CLIENT_PRINCIPALS_PATH = "/close-principals";
/** The mount point of `createCloseClientPrincipalsRoute`: `/_r/s/<serviceName><path>`. */
export const CLOSE_CLIENT_PRINCIPALS_ROUTE = `/_r/s/sessions${CLOSE_CLIENT_PRINCIPALS_PATH}`;

export const CloseClientPrincipalsBodySchema = z
  .object({
    principalIds: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
  })
  .strict();
export type CloseClientPrincipalsBody = z.infer<typeof CloseClientPrincipalsBodySchema>;

export interface CloseClientPrincipalsRouteDeps {
  /** Close every live connection of these principals and retire their callers; returns how many were closed. */
  retireClientPrincipalSessions(
    principalIds: readonly string[],
    reason: string
  ): Promise<number> | number;
}

export function createCloseClientPrincipalsRoute(
  deps: CloseClientPrincipalsRouteDeps
): ServiceRouteDecl {
  return {
    serviceName: "sessions",
    path: CLOSE_CLIENT_PRINCIPALS_PATH,
    methods: ["POST"],
    auth: "admin-token",
    handler: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const parsed = CloseClientPrincipalsBodySchema.safeParse(
        chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
      );
      if (!parsed.success) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: parsed.error.message }));
        return;
      }
      const closed = await deps.retireClientPrincipalSessions(
        parsed.data.principalIds,
        parsed.data.reason
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ closed }));
    },
  };
}
