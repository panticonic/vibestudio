/**
 * The value following a flag at `argv[index]`. A missing value (end of argv or
 * another `--flag`) is a usage error, never a silent default.
 */
export function flagValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
