/** Collection has an explicit per-episode wall-time budget, separate from normal tests. */
export const DEFAULT_TEACHER_TIMEOUT_MS = 3_600_000;
export function teacherEpisodeTimeout(value) {
  const text = value === undefined ? String(DEFAULT_TEACHER_TIMEOUT_MS) : value;
  if (typeof text !== 'string' || !/^\d+$/u.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0)
    throw new Error('--test-timeout-ms must be a positive integer');
  return text;
}
