/**
 * Mobile WebViews can render most media directly, but Android WebView does not
 * provide an in-process PDF viewer. Keep the decision based on the URL rather
 * than adding a PDF engine to the mobile bundle.
 */
export function isPdfUrl(rawUrl: string): boolean {
  if (!/^https?:\/\//i.test(rawUrl)) return false;

  const withoutFragment = rawUrl.split("#", 1)[0] ?? rawUrl;
  const path = withoutFragment.split("?", 1)[0] ?? withoutFragment;
  let decodedPath = path;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    // A malformed escape cannot turn a non-PDF URL into a PDF URL.
  }
  return /\.pdf$/i.test(decodedPath);
}

export function shouldOpenPdfExternally(platform: string, url: string): boolean {
  return platform === "android" && isPdfUrl(url);
}
