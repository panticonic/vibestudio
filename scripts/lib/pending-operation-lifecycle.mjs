/** Turn an ownerless pending promise into a nonzero process outcome at beforeExit. */
export function failIfOperationOutlivesEventLoop(operation, description, log = console.error) {
  let settled = false;
  let reported = false;
  const onBeforeExit = () => {
    if (settled || reported) return;
    reported = true;
    const failure = new Error(`${description} remained pending after Node had no active work`);
    log(failure.stack ?? failure.message);
    process.exitCode = 1;
  };
  process.on("beforeExit", onBeforeExit);
  return Promise.resolve(operation).then(
    (result) => {
      settled = true;
      process.off("beforeExit", onBeforeExit);
      return result;
    },
    (error) => {
      settled = true;
      process.off("beforeExit", onBeforeExit);
      throw error;
    }
  );
}
