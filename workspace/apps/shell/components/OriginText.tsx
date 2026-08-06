import {
  originTextSegments,
  type InstallReviewOrigin,
} from "@vibestudio/shared/authority/unitInstallReview";

/**
 * An identity string with its registrable domain emphasized in place (§7.6.3).
 *
 * There is no publisher identity in this system, so the origin URL is the
 * identity. It is written whole — never abbreviated away, never replaced by a
 * name the code gave itself — and only the run that says whose code this is
 * carries the emphasis. `github.com.attacker.net` emphasizes `attacker.net` and
 * leaves `github.com` flat, which is the entire reason the emphasis exists: the
 * lookalike is the case the plain string cannot defend against.
 *
 * `<strong>` rather than a styled span, and weight plus an underline rather than
 * colour, so the emphasis survives a monochrome display and reaches a renderer
 * that ignores our CSS. Bold is not announced, so it is never the only place
 * the fact appears — every caller renders `originDomainFact` beside this.
 */
export function OriginText({ text, origin }: { text: string; origin: InstallReviewOrigin }) {
  return (
    <>
      {originTextSegments(text, origin).map((segment, index) =>
        segment.emphasized ? (
          <strong
            key={index}
            style={{ fontWeight: 800, textDecoration: "underline", textUnderlineOffset: "2px" }}
          >
            {segment.text}
          </strong>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  );
}
