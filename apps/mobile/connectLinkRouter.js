export async function routeIncomingConnectLink(
  rawUrl,
  {
    consumeReplay,
    parse,
    claim,
    release,
    markConsumed,
    consumeUsbApproval,
    connect,
    present,
    onUsbApproved,
  }
) {
  if (await consumeReplay(rawUrl)) return "replay";

  let pairing = null;
  try {
    pairing = parse(rawUrl);
  } catch {
    present(rawUrl);
    return "presented";
  }
  if (!pairing) {
    present(rawUrl);
    return "presented";
  }

  // Android can deliver the same URL through both getInitialURL() and the live
  // Linking event. Claim it before the asynchronous native approval lookup so
  // the second delivery cannot turn a trusted, already-running connection into
  // a manual confirmation prompt. The durable replay marker is written only
  // after pairing succeeds; this claim covers just the in-flight window.
  if (!claim(rawUrl)) return "replay";

  let usbApproved = false;
  try {
    usbApproved = Boolean(await consumeUsbApproval(rawUrl));
  } catch {
    // Native approval failures must fall back to explicit user confirmation.
  }
  if (!usbApproved) {
    release(rawUrl);
    present(rawUrl);
    return "presented";
  }

  // Native USB approval is the one-time acceptance boundary. Persist it before
  // pairing starts and retain the process-local claim even if pairing or bundle
  // activation later fails. Recovery then uses the stored device credential or
  // a fresh invite; the accepted one-time URL must never become a manual prompt.
  await markConsumed(rawUrl);
  onUsbApproved();
  await connect({ pairing, rawUrl });
  return "connected";
}

/**
 * Coalesce overlapping pairing requests onto the active happy path. A fresh
 * request is only attempted after the active one reports failure; successful
 * pairing/activation satisfies every overlapping request without opening a
 * second Iroh pipe or racing two bundle streams.
 */
export function createSuccessfulConnectCoalescer(connect) {
  let active = null;
  return async (request) => {
    while (active) {
      const observed = active;
      if (await observed) return true;
      if (active !== observed) continue;
      break;
    }

    const operation = Promise.resolve().then(() => connect(request));
    active = operation;
    try {
      return await operation;
    } finally {
      if (active === operation) active = null;
    }
  };
}
