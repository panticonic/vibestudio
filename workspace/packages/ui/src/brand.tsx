import type { CSSProperties } from "react";
import vibestudioLogoDark from "@workspace/brand-assets/vibestudio-dark.png";
import vibestudioLogoLight from "@workspace/brand-assets/vibestudio-light.png";
import vibestudioMarkOnDark from "@workspace/brand-assets/vibestudio-mark-on-dark.png";
import vibestudioMarkOnLight from "@workspace/brand-assets/vibestudio-mark-on-light.png";

export interface VibestudioLogoProps {
  /** Pixel size for the square logo box. */
  size?: number | string;
  /** Tile includes the source background; mark uses transparent artwork. */
  variant?: "tile" | "mark";
  /** Set to false when the logo should be announced as an image. */
  decorative?: boolean;
  alt?: string;
  className?: string;
  style?: CSSProperties;
}

export function VibestudioLogo({
  size = 48,
  variant = "tile",
  decorative = true,
  alt = "Vibestudio",
  className,
  style,
}: VibestudioLogoProps) {
  const lightSrc = variant === "mark" ? vibestudioMarkOnLight : vibestudioLogoLight;
  const darkSrc = variant === "mark" ? vibestudioMarkOnDark : vibestudioLogoDark;
  const accessibleAlt = decorative ? "" : alt;
  return (
    <span
      className={["vibestudio-logo", `vibestudio-logo-${variant}`, className].filter(Boolean).join(" ")}
      style={{ width: size, height: size, ...style }}
      aria-hidden={decorative ? "true" : undefined}
    >
      <img className="vibestudio-logo-img vibestudio-logo-img-light" src={lightSrc} alt={accessibleAlt} />
      <img className="vibestudio-logo-img vibestudio-logo-img-dark" src={darkSrc} alt={accessibleAlt} />
    </span>
  );
}
