# Workspace enabled website

`npm ci && npm run build` builds an ordinary static site in `docs/`. It needs no running workspace, GitHub credential or model credential. The committed lockfile and vendored runtime package make a Git clone independently buildable. Commit `vendor/` and `sdk.json` with the source.

`App.tsx` is the application. `index.tsx` exposes it as an installed Vibestudio panel; `site.tsx` renders the identical component on the web. Both use `@workspace/runtime`. The website's package dependency resolves that name to the bundled shared SDK. Installed panels use the runtime supplied by Vibestudio's build conditions.

Connect is an explicit action. Importing the SDK performs no workspace calls. Outside Vibestudio the page remains readable. Connection, per-operation grants and permission to publish are separate decisions. Never put credentials, connection handles, private context or captured transcripts in source or static assets.

All assets use relative URLs, including under `https://OWNER.github.io/REPOSITORY/`. This is a single-page entry with no server-side routing requirement. `.nojekyll` disables Jekyll processing. `docs/vibestudio-build.json` records the exact source, locked SDK and public-file hashes; rebuilding unchanged inputs produces the same build identity.

For publication, use Vibestudio's GitHub account setup with **Publish websites**, select the exact repository, and review both source and the complete `docs/` inventory before publishing. Use semantic workspace publication followed by protected-main Git export. Configure GitHub Pages to the published branch's `/docs` directory. An existing Actions workflow or different publishing source requires a separate reviewed change. Observe the Pages build and verify the served `vibestudio-build.json` before reporting the site live.

The build runs TypeScript checking before bundling. The sample can inspect an
exact template and request a new workspace through `workspaces.create`. It saves
pending input before submitting and offers receipt recovery after reconnection.
A missing receipt permits an explicit retry of the same input and operation ID;
a denial does not silently start another operation. The sample stores pending
requests in this browser's local storage, keyed by the connected context. It
never stores workspace credentials. Applications needing recovery across devices
should retain their exact request in their own authenticated application storage.

For the managed Git publication, Pages configuration and read-only verification
helpers, see Base `skills/github/PAGES.md`. Only a verified `deployed` result is a
live-publication success, not merely a successful push.
