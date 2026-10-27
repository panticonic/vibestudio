/**
 * Entry point of the desktop's connection utility process.
 *
 * Electron starts this with `utilityProcess.fork`. Main sends one message
 * carrying the control port; everything else (establishing the hub connection,
 * serving renderer ports) is requested over that channel. The process ends
 * when the control channel does, which is when main closes it or goes away.
 */

import * as path from "node:path";
import { NodeArtifactStore } from "@vibestudio/client-host-core/node";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { establishServerSession } from "../main/serverSession.js";
import { ControlChannel, type MessagePortLike } from "./controlChannel.js";
import { ConnectionHost } from "./connectionHost.js";
import { createWorkspaceLaunchPreparation } from "./workspaceLaunchPreparation.js";

interface ParentPort {
  once(
    event: "message",
    listener: (event: { data: unknown; ports: MessagePortLike[] }) => void
  ): unknown;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  throw new Error("The connection process must be started with utilityProcess.fork");
}

parentPort.once("message", (event) => {
  const [port] = event.ports;
  if (!port) throw new Error("The connection process received no control port");
  const channel = new ControlChannel(port, "b");
  const host = new ConnectionHost({
    channel,
    establish: establishServerSession,
    createCentralData: () => new CentralDataManager(),
    createArtifactStore: (userDataPath) =>
      new NodeArtifactStore(path.join(userDataPath, "client-artifacts")),
    prepareLaunch: createWorkspaceLaunchPreparation,
  });
  // The control channel ending is the end of this process's purpose: release
  // everything the connection owns, then exit.
  channel.onClose(() => {
    void host.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("[connection] cleanup failed:", error);
        process.exit(1);
      }
    );
  });
});
