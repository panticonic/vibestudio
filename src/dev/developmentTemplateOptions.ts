export function extractDevelopmentTemplateCheckoutArguments(argv: readonly string[]): {
  checkouts: string[];
  forwarded: string[];
} {
  const checkouts: string[] = [];
  const forwarded: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--template-checkout") {
      const value = argv[index + 1];
      if (!value) throw new Error("--template-checkout requires a path");
      checkouts.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--template-checkout=")) {
      const value = arg.slice("--template-checkout=".length);
      if (!value) throw new Error("--template-checkout requires a path");
      checkouts.push(value);
      continue;
    }
    forwarded.push(arg);
  }
  return { checkouts, forwarded };
}
