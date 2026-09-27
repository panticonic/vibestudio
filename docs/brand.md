# Vibestudio Brand Assets

Vibestudio uses a two-tone royal-blue and vermilion symbol, an ink wordmark, and a standalone "S" glyph.
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

The generator rejects SVGs that embed raster images. Mark symbol paths with
`data-brand-part="primary"` and `data-brand-part="signal"`; logo wordmark paths
use `data-brand-part="wordmark"`. The generator preserves the path geometry,
removes these role markers in outputs, and applies solid light and inverse colors.

Generated surfaces include:

- `build-resources/icon.icns`
- `build-resources/icon.ico`
- `build-resources/icons/*`
- `build-resources/dmg-background.png`
- `build-resources/brand/favicon-*`
- `build-resources/brand/vibestudio-logo*`
- `build-resources/brand/vibestudio-symbol*`
- `workspace/packages/ui/src/assets/*`
- `workspace/apps/mobile/src/assets/*`
- `apps/mobile/assets/*`
- `apps/mobile/android/app/src/main/res/mipmap-*`
- `apps/mobile/android/app/src/main/res/drawable/launch_screen.xml`
- `apps/mobile/android/app/src/main/res/drawable/splash_logo.xml`
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

SVG logo, symbol, inverse variants, and favicon files are generated under
`build-resources/brand/` for packaging and HTTP surfaces. Desktop ICO, ICNS, and
Linux icon sizes use transparent vector artwork with medium blue and vermilion.
The SVG favicon switches to pale blue and soft vermilion in dark mode. Opaque
tiles are reserved for mobile launcher icons and Apple touch icons.

Brand color direction:

- Light product surfaces use white canvas and panels, raised surfaces `#F1F3F7`,
  ink `#14243D`, muted text `#58677D`, and royal-blue primary `#204FA3`.
- Dark product surfaces use canvas `#1A202A`, panels `#242E3C`, raised surfaces
  `#323E4E`, ink `#F4F5F6`, and blue primary `#496FA8`.
- The symbol uses blue `#204FA3` and vermilion `#C73F2D` on light surfaces,
  and pale blue `#AFC8F0` with soft vermilion `#DC9584` on dark surfaces.
- The default panel theme is blue accent, slate neutrals, small radius, and solid
  panels. Explicit user theme choices remain supported.
- Desktop shell chrome uses neutral gray so it frames arbitrary panel content.
  Nautical product colors apply to the branded app and its panels.
- Use vermilion sparingly for decorative brand detail. Keep semantic success,
  warning, and danger colors distinct from the brand palette.
- Panel-local syntax colors, agent colors, and user-lane colors may use their
  own semantic palettes when they are not acting as brand chrome.
