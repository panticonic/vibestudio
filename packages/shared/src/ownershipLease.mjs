import net from "node:net";

export const LEASE_FD_ENV = "VIBESTUDIO_LEASE_FD";

function leaseLost(detail) {
  return Object.assign(new Error(`Ownership lease lost: ${detail}`), { code: "EOWNERSHIP" });
}

export function watchLease({ optional = false } = {}) {
  const controller = new AbortController();
  const raw = process.env[LEASE_FD_ENV];
  if (raw === undefined) {
    if (!optional) throw leaseLost("this process holds no lease");
    return controller.signal;
  }
  const fd = Number(raw);
  if (!Number.isSafeInteger(fd) || fd < 3) throw leaseLost(`invalid lease descriptor ${raw}`);
  // The owner never writes: the only event this socket ever delivers is the
  // end of the stream, which the kernel produces when the owner's end closes
  // for any reason, SIGKILL included.
  const socket = new net.Socket({ fd, readable: true, writable: false });
  const lost = (detail) => {
    if (!controller.signal.aborted) controller.abort(leaseLost(detail));
  };
  socket.on("end", () => lost("owner closed the lease"));
  socket.on("close", () => lost("lease channel closed"));
  socket.on("error", (error) => lost(error.message));
  socket.on("data", () => undefined);
  socket.unref();
  return controller.signal;
}
