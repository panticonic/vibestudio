/** Own original Electron observations until they settle or their actual app closes. */
export function createDesktopObservationOwner() {
  let sealed = false;
  const pending = new Set();
  return {
    observe(read) {
      if (sealed) throw new Error("Desktop observation owner is stopping");
      const operation = Promise.resolve().then(read);
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation)
      );
      return operation;
    },
    seal() {
      sealed = true;
    },
    async join() {
      // The app owner closes the real target first, settling every original read.
      // Read failures belong to their callers, rather than becoming cleanup debt.
      await Promise.allSettled([...pending]);
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
