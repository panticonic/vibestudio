export interface DevelopmentInstanceIsolation {
  cleanRoom: boolean;
  disposable: boolean;
  forwarded: string[];
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function withoutFlag(argv: readonly string[], name: string): string[] {
  return argv.filter((arg) => arg !== name && !arg.startsWith(`${name}=`));
}

/** Instance state is disposable in both modes. Only clean-room runs isolate
 * immutable derived data from the ordinary profile-level development cache. */
export function resolveDevelopmentInstanceIsolation(
  argv: readonly string[]
): DevelopmentInstanceIsolation {
  const cleanRoom = hasFlag(argv, "--clean-room");
  return {
    cleanRoom,
    disposable: cleanRoom || hasFlag(argv, "--ephemeral"),
    forwarded: withoutFlag(withoutFlag(argv, "--ephemeral"), "--clean-room"),
  };
}
