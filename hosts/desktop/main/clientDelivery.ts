import { sha256Integrity, type ClientArtifactStore } from "@vibestudio/client-host-core";
import type { ClientArtifactDescriptor } from "@vibestudio/workspace-contracts/clients";

/**
 * Verified delivery of client builds to renderers (docs/client-hosts-and-clients-plan.md §4.5).
 *
 * A client page is never loaded from the network. The host downloads each
 * artifact into the content-addressed cache, verifies its integrity, and
 * serves the page to its window through the privileged `vs-client://` scheme:
 *
 *   vs-client://<clientId>/<buildKey>/<artifact path>
 *
 * This module is the pure half: the catalog of delivered builds and the
 * responder that answers a request from the verified store. It reads bytes
 * only by the integrity the server declared and verifies them again before
 * serving, so bytes that changed on disk after verification are never served.
 */

export const CLIENT_SCHEME = "vs-client";

/** A client document may load only its own origin's scripts, styles and images. */
export const CLIENT_DOCUMENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: http: https:";

/** One build of one client whose artifacts the host verified into the store. */
export interface DeliveredBuild {
  clientId: string;
  buildKey: string;
  /** Artifacts as declared by the server; `path` is build-relative. */
  artifacts: readonly ClientArtifactDescriptor[];
}

/**
 * The build-relative path of an artifact, as the server declares it. It maps the
 * artifact into the `vs-client://` URL space only; fetching is the shared
 * launcher's, which forms the gateway route itself.
 */
export function buildRelativePath(artifactPath: string): string {
  if (
    artifactPath.length === 0 ||
    artifactPath.startsWith("/") ||
    artifactPath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid client artifact path: ${artifactPath}`);
  }
  return artifactPath;
}

export function clientBuildBaseUrl(clientId: string, buildKey: string): string {
  return `${CLIENT_SCHEME}://${clientId}/${buildKey}/`;
}

export function clientArtifactUrl(
  build: DeliveredBuild,
  artifact: ClientArtifactDescriptor
): string {
  return `${clientBuildBaseUrl(build.clientId, build.buildKey)}${buildRelativePath(artifact.path)}`;
}

/** The page a web client runs: its one primary HTML artifact. */
export function clientEntryUrl(build: DeliveredBuild): string {
  const primaries = build.artifacts.filter((artifact) => artifact.role === "primary");
  const page = primaries[0];
  if (primaries.length !== 1 || !page || !page.path.endsWith(".html")) {
    throw new Error(
      `Client ${build.clientId} build ${build.buildKey} must have exactly one primary HTML page`
    );
  }
  return clientArtifactUrl(build, page);
}

export class ClientBuildCatalog {
  private readonly builds = new Map<string, Map<string, Map<string, ClientArtifactDescriptor>>>();

  /** Make a verified build servable. Re-registering a build replaces it. */
  register(build: DeliveredBuild): void {
    const artifacts = new Map<string, ClientArtifactDescriptor>();
    for (const artifact of build.artifacts) {
      const relative = buildRelativePath(artifact.path);
      if (artifacts.has(relative)) {
        throw new Error(`Client ${build.clientId} build declares ${relative} twice`);
      }
      artifacts.set(relative, artifact);
    }
    let byBuild = this.builds.get(build.clientId);
    if (!byBuild) {
      byBuild = new Map();
      this.builds.set(build.clientId, byBuild);
    }
    byBuild.set(build.buildKey, artifacts);
  }

  /** Stop serving a build, once no window runs it. */
  retire(clientId: string, buildKey: string): void {
    const byBuild = this.builds.get(clientId);
    byBuild?.delete(buildKey);
    if (byBuild?.size === 0) this.builds.delete(clientId);
  }

  /** The artifact a `vs-client://` URL names, or null when no registered build serves it. */
  lookup(rawUrl: string): { artifact: ClientArtifactDescriptor; buildKey: string } | null {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== `${CLIENT_SCHEME}:`) return null;
    let segments: string[];
    try {
      segments = url.pathname
        .split("/")
        .filter((part) => part.length > 0)
        .map(decodeURIComponent);
    } catch {
      return null;
    }
    const [buildKey, ...rest] = segments;
    if (!buildKey || rest.length === 0 || rest.some((part) => part === "." || part === "..")) {
      return null;
    }
    const artifact = this.builds.get(url.hostname)?.get(buildKey)?.get(rest.join("/"));
    return artifact ? { artifact, buildKey } : null;
  }
}

/**
 * Answer a `vs-client://` request from the verified store. Unknown paths are
 * 404. Bytes that no longer match their declared integrity are never served:
 * the response is a 500 that names the artifact, not the content.
 */
export function createVerifiedClientResponder(
  catalog: ClientBuildCatalog,
  store: Pick<ClientArtifactStore, "has" | "read">,
  onIntegrityFailure: (message: string) => void = () => {}
): (request: { url: string; method: string }) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const found = catalog.lookup(request.url);
    if (!found) return new Response("Client artifact not found", { status: 404 });
    const { artifact } = found;
    if (!(await store.has(artifact.integrity))) {
      return new Response("Client artifact is not in the verified cache", { status: 404 });
    }
    const bytes = await store.read(artifact.integrity);
    const actual = await sha256Integrity(bytes);
    if (actual !== artifact.integrity) {
      const message =
        `Refusing to serve ${artifact.path}: the cached bytes no longer match ` +
        `their declared integrity ${artifact.integrity}`;
      onIntegrityFailure(message);
      return new Response(message, { status: 500 });
    }
    const headers = new Headers({
      "content-type": artifact.contentType,
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    });
    if (artifact.contentType.startsWith("text/html")) {
      headers.set("content-security-policy", CLIENT_DOCUMENT_CSP);
    }
    return new Response(request.method === "HEAD" ? null : (bytes as BodyInit), {
      status: 200,
      headers,
    });
  };
}
