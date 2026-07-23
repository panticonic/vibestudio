# Vibestudio Brand Assets

Vibestudio uses a violet-to-pink vertical logo lockup and a standalone "S" glyph.
Do not hand-edit generated output files unless you are testing locally and plan
to regenerate the suite afterward.

## Canonical Sources

- `build-resources/brand/source/vibestudio-logo.svg`
- `build-resources/brand/source/vibestudio-symbol.svg`

These true-vector SVGs are the only canonical sources. The exact standalone
glyph is used at every symbol size, including 16 px and 24 px. Generated output
is written to desktop, web, workspace, mobile host, Android, and iOS locations.

## Regeneration

Prerequisites:

- librsvg `rsvg-convert`
- ImageMagick `convert`

Regenerate all branded assets:

```bash
pnpm generate:brand-assets
```

Replace the canonical source files from production-ready vector artwork:

```bash
pnpm generate:brand-assets -- --logo /path/to/logo.svg --symbol /path/to/symbol.svg --update-source
```

The generator rejects SVGs that embed raster images. Large PNG outputs retain
full-color gradients instead of being reduced to indexed palettes.

Generated surfaces include:

- `build-resources/icon.icns`
- `build-resources/icon.ico`
- `build-resources/dmg-background.png`
- `build-resources/brand/favicon-*`
- `build-resources/brand/vibestudio-logo*`
- `build-resources/brand/vibestudio-symbol*`
- `workspace/packages/ui/src/assets/*`
- `workspace/apps/mobile/src/assets/*`
- `apps/mobile/assets/*`
- `apps/mobile/android/app/src/main/res/mipmap-*`
- `apps/mobile/android/app/src/main/res/drawable/launch_screen.xml`
- `apps/mobile/ios/Vibestudio/Images.xcassets/AppIcon.appiconset`
- `apps/mobile/ios/Vibestudio/Images.xcassets/LaunchLogo.imageset`

## Usage Rules

Use the shared components instead of importing PNGs directly in product UI:

- Web/workspace UI: `VibestudioLogo` from `@workspace/ui`
- Workspace mobile app: `VibestudioLogo` from `workspace/apps/mobile/src/components/VibestudioLogo`
- Shipped native host fallback: `VibestudioLogo` from `apps/mobile/VibestudioLogo.js`

The web component uses the vector masters directly. Native surfaces consume
generated PNGs because React Native's core image component does not load SVGs.
Product UI should consume `VibestudioLogo` rather than importing either format.

Prefer `variant="logo"` for onboarding and prominent brand surfaces. Use
`variant="symbol"` for title bars, empty states, loading states, and compact
chrome. Use `variant="tile"` only where the glyph needs its generated
light/dark background tile.

SVG logo, symbol, background variants, and favicon files are generated under
`build-resources/brand/` for packaging and HTTP surfaces. Static platform icons
use the dark tile; the light tile remains available for light application surfaces.

Brand color direction:

- Primary surfaces are mauve-neutral with violet depth.
- The default app accent is violet; pink is the secondary brand spark.
- Brand gradients run violet through purple to pink. Keep semantic success,
  warning, and danger colors distinct from the brand palette.
- Panel-local syntax colors, agent colors, and user-lane colors may use their
  own semantic palettes when they are not acting as brand chrome.
