/** Environment variable naming the lease file descriptor passed to a lessee. */
export const LEASE_FD_ENV: "VIBESTUDIO_LEASE_FD";
/**
 * Child-side lease. A lessee started with `ownership.spawn(..., { lease: true })`
 * holds the read end of a pipe whose write end lives in its owner; end-of-file
 * means the owner is gone (including SIGKILL) and the lease is revoked.
 * Returns a signal that aborts, with an EOWNERSHIP reason, on lease loss. The
 * watch does not keep the process alive. Throws unless `optional` when the
 * process holds no lease.
 */
export function watchLease(options?: { optional?: boolean }): AbortSignal;
