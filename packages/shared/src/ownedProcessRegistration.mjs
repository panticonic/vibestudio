import { randomBytes } from "node:crypto";
import {
  observeOwnedProcessGroup,
  ownedProcessDescendsFrom,
  parseOwnedProcessIdentity,
} from "./ownedProcessIdentity.mjs";

const REGISTER = "vibestudio:owned-process-group";
const ACCEPTED = "vibestudio:owned-process-group-accepted";
const REJECTED = "vibestudio:owned-process-group-rejected";

/** Transfer a creation receipt through the native IPC owner chain. */
export async function registerOwnedProcessGroup(identity, target = process) {
  if (!target.send) return;
  const registrationId = randomBytes(16).toString("hex");
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      target.off("message", onMessage);
      target.off("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message) => {
      if (!message || message.registrationId !== registrationId) return;
      if (message.type === ACCEPTED) finish();
      else if (message.type === REJECTED)
        finish(new Error("Native parent rejected process-group ownership"));
    };
    const onDisconnect = () =>
      finish(new Error("Native parent disconnected before accepting process-group ownership"));
    target.on("message", onMessage);
    target.once("disconnect", onDisconnect);
    if (target.connected === false) {
      onDisconnect();
      return;
    }
    try {
      target.send({ type: REGISTER, registrationId, identity }, (error) => {
        if (error) finish(error);
      });
    } catch (error) {
      finish(error);
    }
  });
}

/** Keep admitted groups until the child IPC producer is closed and all drain. */
export function createOwnedProcessGroupReceiver(
  child,
  childIdentity,
  adopt,
  { forwardToParent = false } = {}
) {
  const groups = new Map();
  const pending = new Set();
  const closed = new Promise((resolve) => child.once("close", resolve));
  let retirement;
  let sealed = false;
  const reply = (registrationId, accepted) => {
    if (!child.connected) return;
    // The close boundary owns delivery: a disconnected child cannot continue
    // startup, and all groups retained here still retire below.
    child.send({ type: accepted ? ACCEPTED : REJECTED, registrationId }, () => {});
  };
  const accept = async (message) => {
    let identity;
    try {
      if (sealed || observeOwnedProcessGroup(childIdentity) !== "owned")
        throw new Error("Native owner is no longer live");
      identity = parseOwnedProcessIdentity(message.identity);
      if (
        observeOwnedProcessGroup(identity) !== "owned" ||
        !ownedProcessDescendsFrom(childIdentity.pid, identity.pid)
      )
        throw new Error("Process group is outside the native child ownership tree");
      const key = `${identity.pid}:${identity.startCoordinate}`;
      if (!groups.has(key)) groups.set(key, adopt(identity));
      if (forwardToParent) await registerOwnedProcessGroup(identity);
      reply(message.registrationId, true);
    } catch {
      reply(message.registrationId, false);
    }
  };
  const onMessage = (message) => {
    if (!message || message.type !== REGISTER || typeof message.registrationId !== "string") return;
    const operation = accept(message);
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };
  child.on("message", onMessage);
  return {
    close() {
      retirement ??= (async () => {
        await closed;
        sealed = true;
        child.off("message", onMessage);
        await Promise.all(pending);
        const results = await Promise.allSettled(
          // The actual producer close is authoritative owner destruction;
          // these retained detached groups can no longer perform valid work.
          [...groups.values()].map((group) => group.retire("SIGKILL"))
        );
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        );
        if (failures.length)
          throw Object.assign(
            new AggregateError(failures, "Registered native process groups did not retire"),
            { code: "EOWNERSHIP" }
          );
        groups.clear();
      })();
      return retirement;
    },
  };
}
