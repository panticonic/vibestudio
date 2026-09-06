/** Windows environment names are case-insensitive, including when Node copies
 * process.env into an ordinary object or a worker-thread environment. */
export function windowsEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const values = new Set(
    Object.entries(environment)
      .filter(([key, value]) => key.toLowerCase() === name.toLowerCase() && value !== undefined)
      .map(([, value]) => value!)
  );
  if (values.size > 1) throw new Error(`Conflicting Windows environment values for ${name}`);
  return values.values().next().value;
}
