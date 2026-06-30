/**
 * ServerInfo — Electron-main's view of the server connection.
 *
 * Keep this as a transport snapshot only. Workspace VCS and external Git
 * interop are exposed through typed service clients instead.
 */

import type { ServerInfoLike } from "@vibez1/shared/panelInterfaces";

export type ServerInfo = ServerInfoLike;
