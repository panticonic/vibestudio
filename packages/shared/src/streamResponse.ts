import { z } from "zod";

/**
 * A live streaming RPC result, not a JSON value. Validation preserves the
 * Response and its body; the selected transport owns reading and cancellation.
 */
export const StreamResponseSchema = z.instanceof(Response);
