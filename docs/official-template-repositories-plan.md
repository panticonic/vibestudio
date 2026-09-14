# Workspace template repositories

Workspace templates are ordinary, independently published Git repositories.
The host repository contains the small discovery catalog at
`templates/registry.json`; there is no registry repository, promotion branch,
distribution manifest, or release-coordinate ledger.

## Source model

- `vibestudio-base`, `vibestudio-personal`, and `vibestudio-system` are
  independent template repositories.
- Optional templates such as Examples, News, Google Workspace, and Spectrolite
  are independent repositories too.
- Every repository owns one `meta/vibestudio.yml`. Its `template.dependencies`
  entries are moving repository declarations by default. A template author can
  pin a dependency deliberately, but the catalog never does so on their behalf.
- Personal and System depend on Base. Development-only support such as System
  Testing is composed into its declared consumers only by the development
  launcher; it is not copied into published templates.

## Registry

The version-1 registry is JSON:

```json
{
  "version": 1,
  "templates": [
    {
      "id": "examples",
      "role": "catalog",
      "name": "Examples",
      "description": "Explore sample panels, agents, tools, and playable worlds.",
      "url": "git+https://github.com/panticonic/vibestudio-template-examples.git"
    }
  ]
}
```

An entry contains presentation metadata and a moving repository URL. Commit,
snapshot, tag, promotion, and release fields are invalid. This keeps discovery
loosely coupled to template publication.

The default registry URL is the raw `templates/registry.json` on
`panticonic/vibestudio/main`. The workspace chooser accepts another HTTP(S)
registry URL. A development instance instead receives the current checkout's
local registry file through its host environment, so edits to the catalog and
all registered template checkouts participate in the same local happy path.

## Development workflow

`pnpm dev:templates setup [root]` reads the host checkout's registry, clones
every listed source into `<root>/<id>`, validates the complete set, and records
that one root in local Git config. `pnpm dev:templates status` and
`pnpm dev:templates sync` always operate on the same set. Product and managed
development launches checkpoint every registered checkout and prefer those
checkpoints whenever a matching template or dependency URL is resolved.

No template is silently sourced differently from its peers: a configured set
is complete or startup fails with the missing checkout named explicitly.

## Authoring and publication

Vibestudio's authoring flow computes which workspace parts are owned locally
and which arrive from declared dependencies. Publication writes only the local
parts plus the repository's `meta/vibestudio.yml`, then pushes that template
repository. Updating the discovery catalog is an ordinary change to
`templates/registry.json` in the host repository and is independent of
publishing the template.
