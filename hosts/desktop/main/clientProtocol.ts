import { protocol, type Session } from "electron";
import { CLIENT_SCHEME } from "./clientDelivery.js";

/**
 * Register `vs-client://` as a privileged scheme. Electron requires this
 * before the app is ready, and it must list every privileged scheme once.
 * `standard` + `secure` make a client page a normal secure origin
 * (`vs-client://<clientId>`), so its storage persists across its builds.
 */
export function registerClientScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CLIENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Serve `vs-client://` from the verified cache on one session. A client window
 * has its own session partition, so the handler is installed on every session
 * (the app's `session-created` hook does that); a session that never loads a
 * client simply never receives such a request.
 */
export function installClientProtocol(
  target: Session,
  respond: (request: { url: string; method: string }) => Promise<Response>
): void {
  target.protocol.handle(CLIENT_SCHEME, (request) => respond(request));
}
