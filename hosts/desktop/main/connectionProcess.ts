import {
  ControlChannel,
  controlChannelClosed,
  type MessagePortLike,
} from "../connection/controlChannel.js";

/** The subset of Electron's `UtilityProcess` the launcher relies on. */
export interface UtilityProcessLike {
  postMessage(message: unknown, transfer?: MessagePortLike[]): void;
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface ConnectionProcessExit {
  code: number | null;
  /** True when main asked the process to stop; false for any other end. */
  requested: boolean;
  reason: string;
}

export interface ConnectionProcessHandle {
  readonly channel: ControlChannel;
  /** Settles once, with the process's actual exit. */
  readonly exited: Promise<ConnectionProcessExit>;
  /** Stop the process and wait for its exit. Idempotent. */
  dispose(): Promise<ConnectionProcessExit>;
}

export interface ConnectionProcessLaunch {
  /** Start the utility process. */
  fork(): UtilityProcessLike;
  /** A connected pair of control ports, one for each side. */
  createPorts(): [MessagePortLike, MessagePortLike];
}

/**
 * Start the connection utility process and the control channel to it.
 *
 * The process's exit is the authoritative end of the connection: it fails the
 * channel with the exit reason, which settles every pending request and
 * client. There is no liveness probe and no timer; a process that is merely
 * slow is working.
 */
export function launchConnectionProcess(launch: ConnectionProcessLaunch): ConnectionProcessHandle {
  const [local, remote] = launch.createPorts();
  const child = launch.fork();
  const channel = new ControlChannel(local, "a", { endOnPortClose: false });
  child.postMessage({ type: "control" }, [remote]);
  let requested = false;
  const exited = new Promise<ConnectionProcessExit>((resolve) => {
    child.once("exit", (code) => {
      const reason = requested
        ? "The connection process was stopped"
        : `The connection process exited unexpectedly (code ${code})`;
      resolve({ code, requested, reason });
      channel.fail(controlChannelClosed(reason));
    });
  });
  return {
    channel,
    exited,
    dispose() {
      requested = true;
      channel.close();
      child.kill();
      return exited;
    },
  };
}
