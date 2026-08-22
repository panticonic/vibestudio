const GUI_TRIGGERS = new Set(["open", "gui", "app", "--gui"]);
const PAIR_URL_PREFIX = "https://vibestudio.app/p#";
const PAIR_DEEP_LINK_PREFIX = "vibestudio://connect";

export function isDesktopPairingArgument(value) {
  return (
    typeof value === "string" &&
    (value.startsWith(PAIR_URL_PREFIX) || value.startsWith(PAIR_DEEP_LINK_PREFIX))
  );
}

/** Decide whether the public `vibestudio` bin launches Electron or the CLI.
 * Pairing carriers are GUI invocations in their own right, so users may run
 * either `vibestudio open URL` or simply `vibestudio URL`. */
export function resolveDesktopLaunchArgs(argv) {
  const args = [...argv];
  const explicitGui = GUI_TRIGGERS.has(args[0]);
  if (explicitGui) args.shift();
  return {
    wantsGui: argv.length === 0 || explicitGui || isDesktopPairingArgument(args[0]),
    args,
  };
}
