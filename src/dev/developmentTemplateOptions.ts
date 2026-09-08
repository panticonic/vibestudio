export function extractDevelopmentTemplateCheckoutArguments(argv: readonly string[]): {
  checkouts: string[];
  forwarded: string[];
  workspaceCheckout?: string;
} {
  const checkouts: string[] = [];
  const forwarded: string[] = [];
  let workspaceCheckout: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--workspace-checkout" || arg.startsWith("--workspace-checkout=")) {
      const value =
        arg === "--workspace-checkout" ? argv[++index] : arg.slice("--workspace-checkout=".length);
      if (!value || value.startsWith("--")) throw new Error("--workspace-checkout requires a path");
      if (workspaceCheckout) throw new Error("--workspace-checkout may only be selected once");
      workspaceCheckout = value;
      continue;
    }
    if (arg === "--template-checkout") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--template-checkout requires a path");
      checkouts.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--template-checkout=")) {
      const value = arg.slice("--template-checkout=".length);
      if (!value || value.startsWith("--")) throw new Error("--template-checkout requires a path");
      checkouts.push(value);
      continue;
    }
    forwarded.push(arg);
  }
  if (
    workspaceCheckout &&
    forwarded.some((arg) =>
      ["--workspace", "--bootstrap-workspace", "--ephemeral-workspace"].some(
        (option) => arg === option || arg.startsWith(`${option}=`)
      )
    )
  )
    throw new Error(
      "--workspace-checkout cannot be combined with another startup workspace selection"
    );
  return { checkouts, forwarded, ...(workspaceCheckout ? { workspaceCheckout } : {}) };
}
