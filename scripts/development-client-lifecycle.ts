import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { OwnedProcessGroup } from "@vibestudio/shared/ownedProcessGroup";

/** Acquisition and retirement form one owned process scope. */
export function createOwnedProcessLifetime() {
  const groups: OwnedProcessGroup[] = [];
  const children = new WeakMap<ChildProcess, OwnedProcessGroup>();
  let stopping = false;
  let retirement: Promise<void> | undefined;
  return {
    acquire(start: () => ChildProcess): ChildProcess {
      if (stopping) throw new Error("Client lifetime is stopping");
      const child = start();
      // Startup callers still observe this error; it must not bypass their
      // finally block before they attach their operation-specific listener.
      child.on("error", () => undefined);
      if (child.pid === undefined) return child;
      const group = OwnedProcessGroup.create(child, {
        // Revoking a native IPC lease lets the child join its own descendants
        // before its exit becomes this scope's retirement receipt.
        ...(child.connected
          ? {
              requestGracefulStop: () => {
                if (child.connected) child.send({ type: "vibestudio:parent-owned-stop" });
              },
            }
          : {}),
      });
      groups.push(group);
      children.set(child, group);
      return child;
    },
    retireChild(child: ChildProcess) {
      const group = children.get(child);
      if (!group) throw new Error("Process was not acquired by this lifetime");
      return group.retire();
    },
    requestStop() {
      stopping = true;
      for (const group of groups) void group.retire().catch(() => undefined);
    },
    retire() {
      stopping = true;
      retirement ??= (async () => {
        const results = await Promise.allSettled(groups.map((group) => group.retire()));
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        );
        if (failures.length) throw new AggregateError(failures, "Client process retirement failed");
      })();
      return retirement;
    },
  };
}

/** The temporary state belongs to these groups until every group retires. */
export function createDevelopmentClientLifetime(tempRoot: string) {
  const lifetime = createOwnedProcessLifetime();
  let closing: Promise<void> | undefined;
  return {
    acquire: lifetime.acquire,
    requestStop: lifetime.requestStop,
    close() {
      closing ??= lifetime.retire().then(() => rm(tempRoot, { recursive: true, force: true }));
      return closing;
    },
  };
}
