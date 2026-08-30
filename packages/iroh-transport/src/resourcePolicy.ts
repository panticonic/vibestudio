/**
 * Catastrophic containment boundaries for process-owned Iroh bookkeeping.
 *
 * These are deliberately several orders of magnitude above ordinary product
 * fanout. They are not throughput controls: QUIC flow control, streaming, and
 * work deduplication govern normal pressure. Reaching one indicates a broken or
 * hostile peer that would otherwise retain process memory without bound.
 */
export const IROH_CATASTROPHIC_LOGICAL_SESSION_CEILING = 65_536;
export const IROH_CATASTROPHIC_ACTIVE_REQUEST_CEILING = 1_048_576;
// Equal to the native replenishing MAX_STREAMS window: this cannot throttle
// healthy work before QUIC's own transport-level admission boundary does.
export const IROH_CATASTROPHIC_PENDING_STREAM_HEADER_CEILING = 32_768;
