export function gitCredentialRequirement(
  name: string | undefined,
  remoteUrl: string
): {
  name: string;
  remoteUrl: string;
  provider: string;
} {
  const provider = new URL(remoteUrl).hostname;
  return { name: name ?? provider, remoteUrl, provider };
}
