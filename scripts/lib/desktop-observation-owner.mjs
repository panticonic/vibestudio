/** Own original Electron observations until they settle or their actual app closes. */
export function createDesktopObservationOwner() {
  let sealed = false;
  const pending = new Map();
  const recent = [];
  let pendingAtRetirement = [];
  const settle = (operation, status) => {
    const observation = pending.get(operation);
    pending.delete(operation);
    recent.push({ ...observation, status, settledAt: new Date().toISOString() });
    if (recent.length > 20) recent.shift();
  };
  return {
    observe(read, label = "Electron observation") {
      if (sealed) throw new Error("Desktop observation owner is stopping");
      const operation = Promise.resolve().then(read);
      pending.set(operation, { label, startedAt: new Date().toISOString() });
      void operation.then(
        () => settle(operation, "fulfilled"),
        () => settle(operation, "rejected")
      );
      return operation;
    },
    seal() {
      if (!sealed) pendingAtRetirement = [...pending.values()];
      sealed = true;
    },
    snapshot() {
      return { sealed, pending: [...pending.values()], pendingAtRetirement, recent: [...recent] };
    },
    async join() {
      // The app owner closes the real target first, settling every original read.
      // Read failures belong to their callers, rather than becoming cleanup debt.
      await Promise.allSettled([...pending.keys()]);
    },
  };
}

/** Record a native directory allocation before dispatch; cancellation joins that allocation. */
export function createOwnedTemporaryDirectory(create, remove) {
  let sealed = false;
  let creation;
  let retirement;
  return {
    acquire() {
      if (sealed) throw new Error("Temporary directory owner is stopping");
      creation ??= Promise.resolve().then(create);
      return creation;
    },
    seal() {
      sealed = true;
    },
    async join() {
      // A failed atomic mkdtemp created no returned directory. Its original
      // error is retained by the acquisition caller, not duplicate cleanup debt.
      return creation ? await creation.catch(() => null) : null;
    },
    retire() {
      sealed = true;
      retirement ??= (async () => {
        const root = creation ? await creation.catch(() => null) : null;
        if (root !== null) await remove(root);
      })();
      return retirement;
    },
  };
}
