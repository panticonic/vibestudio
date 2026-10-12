export function spawnResultFailure(result, command) {
  const details = [];
  if (result.signal) details.push(new Error(`${command} was terminated by ${result.signal}`));
  if (result.status !== 0 && result.status !== null && result.status !== undefined)
    details.push(new Error(`${command} exited with status ${result.status}`));
  if (result.error && details.length)
    return new AggregateError([result.error, ...details], `${command} failed`, {
      cause: result.error,
    });
  if (result.error) return result.error;
  if (!details.length && result.status === 0) return undefined;
  if (details.length === 1) return details[0];
  if (details.length > 1)
    return new AggregateError(details, `${command} failed`, { cause: details[0] });
  return new Error(`${command} failed (status ${result.status ?? "unknown"})`);
}
