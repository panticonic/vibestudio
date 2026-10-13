import { isRpcConnectionLost } from "@vibestudio/rpc";

/**
 * Join the physical terminal receipt with the logical work it owns.
 *
 * A connection-loss rejection is another form of normal physical closure, but
 * it becomes routine only after logical retirement has completed. Any other
 * native rejection remains the primary failure and is retained alongside an
 * independent logical-retirement failure.
 */
export async function settleIrohPhysicalClosure(
  closure: Promise<string>,
  retireLogical: (reason: string) => Promise<void>
): Promise<void> {
  let reason: string;
  let physicalFailed = false;
  let physicalFailure: unknown;
  try {
    reason = await closure;
  } catch (error) {
    physicalFailed = true;
    physicalFailure = error;
    reason = error instanceof Error ? error.message : String(error);
  }

  let logicalFailed = false;
  let logicalFailure: unknown;
  try {
    await retireLogical(reason);
  } catch (error) {
    logicalFailed = true;
    logicalFailure = error;
  }

  if (physicalFailed && !isRpcConnectionLost(physicalFailure)) {
    if (logicalFailed) {
      throw new AggregateError(
        [physicalFailure, logicalFailure],
        "Iroh physical closure and logical retirement failed",
        { cause: physicalFailure }
      );
    }
    throw physicalFailure;
  }
  if (logicalFailed) throw logicalFailure;
}
