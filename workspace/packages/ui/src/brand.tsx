import type { CSSProperties } from "react";
import vibez1LogoDark from "@workspace/brand-assets/vibez1-dark.png";
import vibez1LogoLight from "@workspace/brand-assets/vibez1-light.png";
import vibez1MarkOnDark from "@workspace/brand-assets/vibez1-mark-on-dark.png";
import vibez1MarkOnLight from "@workspace/brand-assets/vibez1-mark-on-light.png";

export interface Vibez1LogoProps {
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

export function Vibez1Logo({
  size = 48,
  variant = "tile",
  decorative = true,
  alt = "Vibez1",
  className,
  style,
}: Vibez1LogoProps) {
  const lightSrc = variant === "mark" ? vibez1MarkOnLight : vibez1LogoLight;
  const darkSrc = variant === "mark" ? vibez1MarkOnDark : vibez1LogoDark;
  const accessibleAlt = decorative ? "" : alt;
  return (
    <span
      className={["vibez1-logo", `vibez1-logo-${variant}`, className].filter(Boolean).join(" ")}
      style={{ width: size, height: size, ...style }}
      aria-hidden={decorative ? "true" : undefined}
    >
      <img className="vibez1-logo-img vibez1-logo-img-light" src={lightSrc} alt={accessibleAlt} />
      <img className="vibez1-logo-img vibez1-logo-img-dark" src={darkSrc} alt={accessibleAlt} />
    </span>
  );
}
