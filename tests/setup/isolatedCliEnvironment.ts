import path from "node:path";

/**
 * Give a CLI subprocess a disposable profile even when the operator exports a
 * machine-wide XDG_CONFIG_HOME. Pairing tests must use this boundary before
 * invoking any command that can persist a device credential or agent session.
 */
export function isolatedCliEnvironment(
  inherited: NodeJS.ProcessEnv,
  home: string
): NodeJS.ProcessEnv {
  return {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
}
