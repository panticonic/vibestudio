# Semantic control plane

This package is product-sealed internal bundle source. Its location under
`workspace/packages/` gives the implementation ordinary package structure and
dependency ergonomics; it does **not** make the authority workspace-configurable
or a userland runtime unit.

The host bundles the package only through `src/server/internalDOs/index.ts`.
Runtime routing identity comes exclusively from `SEMANTIC_CONTROL_PLANE` and is
therefore always `vibestudio/internal:GadWorkspaceDO`, independent of this
physical package path. The package intentionally declares no `vibestudio.kind`
metadata and exports only its internal bundle entry point.
