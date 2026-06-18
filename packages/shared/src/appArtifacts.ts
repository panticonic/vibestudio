export const APP_ARTIFACT_ROUTE_PREFIX = "/_a";

export function appArtifactBuildRoute(buildKey: string): string {
  return `${APP_ARTIFACT_ROUTE_PREFIX}/${encodeURIComponent(buildKey)}`;
}

export function appArtifactRoute(buildKey: string, artifactPath: string): string {
  const path = artifactPath.replace(/^\/+/, "") || "index.html";
  return `${appArtifactBuildRoute(buildKey)}/${encodeArtifactPath(path)}`;
}

export function appArtifactUrl(
  gatewayBaseUrl: string,
  buildKey: string,
  artifactPath: string
): string {
  return resolveGatewayRouteUrl(gatewayBaseUrl, appArtifactRoute(buildKey, artifactPath));
}

export function resolveGatewayRouteUrl(gatewayBaseUrl: string, routePath: string): string {
  const gateway = new URL(gatewayBaseUrl);
  const route = routePath.startsWith("/") ? routePath : `/${routePath}`;
  const basePath = gateway.pathname.replace(/\/+$/, "");
  const url = new URL(gateway.href);
  url.pathname = `${basePath}${route}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.href;
}

export function encodeArtifactPath(artifactPath: string): string {
  return artifactPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
