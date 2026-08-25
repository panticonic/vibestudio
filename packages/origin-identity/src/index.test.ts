import { describe, expect, it } from "vitest";
import { templateOrigin } from "./index.js";
import {
  originDomainFact,
  originTextSegments,
  type InstallReviewOrigin,
} from "@vibestudio/shared/authority/unitInstallReview";

/**
 * Origin identity, which is the only identity this system has
 * (docs/template-install-unit-approval-ux-plan.md §7.6.3, §13.6).
 *
 * Nothing establishes who published anything, so the origin URL is the
 * identity and the registrable domain is the part of it that says whose it is.
 * These tests are about the case that makes the emphasis worth having: a URL a
 * person will misread.
 */

function origin(url: string): InstallReviewOrigin {
  return templateOrigin({ url, version: null, admittedOriginKeys: new Set() });
}

function emphasized(text: string, from: InstallReviewOrigin): string[] {
  return originTextSegments(text, from)
    .filter((segment) => segment.emphasized)
    .map((segment) => segment.text);
}

function rejoin(text: string, from: InstallReviewOrigin): string {
  return originTextSegments(text, from)
    .map((segment) => segment.text)
    .join("");
}

describe("the registrable domain is computed, never guessed", () => {
  it("is the real boundary under a multi-label public suffix", () => {
    // "Last two labels" would say `co.uk`, which is not anybody's domain.
    expect(origin("https://www.bbc.co.uk/acme/studio").registrableDomain).toBe("bbc.co.uk");
    expect(origin("https://shop.example.com.au/acme").registrableDomain).toBe("example.com.au");
  });

  it("is the label a stranger holds under a suffix that hands out names", () => {
    // Anyone can take a name under github.io or pages.dev, so the boundary a
    // person must judge is the whole `acme.github.io`, never `github.io`.
    expect(origin("https://acme.github.io/studio").registrableDomain).toBe("acme.github.io");
    expect(origin("https://acme.pages.dev/studio").registrableDomain).toBe("acme.pages.dev");
  });

  it("keeps the whole host when there is no narrower boundary", () => {
    expect(origin("http://localhost:5173/acme").registrableDomain).toBe("localhost");
    expect(origin("http://10.0.0.7:8080/acme").registrableDomain).toBe("10.0.0.7");
  });

  it("is punycode for an internationalized domain, with no unicode anywhere a user reads", () => {
    const cyrillic = origin("https://аpple.com/acme/studio");
    expect(cyrillic.registrableDomain).toBe("xn--pple-43d.com");
    expect(cyrillic.url).not.toMatch(/[^\x00-\x7f]/u);
    expect(cyrillic.originKey).not.toMatch(/[^\x00-\x7f]/u);
    expect(originDomainFact(cyrillic)).toBe("Domain: xn--pple-43d.com");
    // The path is read as identity too, and is punycoded/escaped by the same
    // parse rather than passed through.
    const trickyPath = origin("https://example.com/аcme/‮studio");
    expect(trickyPath.url).not.toMatch(/[^\x00-\x7f]/u);
    expect(rejoin(trickyPath.url!, trickyPath)).not.toMatch(/[^\x00-\x7f]/u);
  });

  it("says nothing about a domain for the host's own build", () => {
    expect(
      originDomainFact({
        url: null,
        originKey: "vibestudio",
        registrableDomain: null,
        version: "1.4.0",
        isHostBuild: true,
        firstEncounter: false,
      })
    ).toBeNull();
  });
});

describe("the emphasis lands on who this actually is", () => {
  it("emphasizes attacker.net in github.com.attacker.net, and never github.com", () => {
    const lookalike = origin("https://github.com.attacker.net/acme/studio");
    expect(lookalike.registrableDomain).toBe("attacker.net");
    expect(emphasized(lookalike.url!, lookalike)).toEqual(["attacker.net"]);
    expect(emphasized(lookalike.url!, lookalike)).not.toContain("github.com");
    // And the whole URL is still there, character for character.
    expect(rejoin(lookalike.url!, lookalike)).toBe("https://github.com.attacker.net/acme/studio");
  });

  it("emphasizes the multi-label registrable domain, not the public suffix", () => {
    const bbc = origin("https://www.bbc.co.uk/acme/studio");
    expect(emphasized(bbc.url!, bbc)).toEqual(["bbc.co.uk"]);
    expect(originTextSegments(bbc.url!, bbc)[0]).toEqual({
      text: "https://www.",
      emphasized: false,
    });
  });

  it("never abbreviates the URL away, at any level", () => {
    const long = origin("https://git.example.co.uk:8443/acme/studio/deep/path?ref=main#top");
    expect(rejoin(long.url!, long)).toBe(long.url);
    expect(emphasized(long.url!, long)).toEqual(["example.co.uk"]);
  });

  it("emphasizes inside the authority only, never a path that repeats the domain", () => {
    // A path may contain anything, including the domain's own text.
    const mirrored = origin("https://gitlab.com/mirror/gitlab.com/studio");
    const segments = originTextSegments(mirrored.url!, mirrored);
    expect(segments.filter((segment) => segment.emphasized)).toHaveLength(1);
    expect(segments[0]).toEqual({ text: "https://", emphasized: false });
    expect(segments[1]).toEqual({ text: "gitlab.com", emphasized: true });
  });

  it("is not fooled by userinfo that looks like a host", () => {
    const userinfo = origin("https://github.com@attacker.net/acme");
    expect(userinfo.registrableDomain).toBe("attacker.net");
    expect(emphasized(userinfo.url!, userinfo)).toEqual(["attacker.net"]);
  });

  it("emphasizes within a sentence that contains the URL", () => {
    const acme = origin("https://github.com/acme/studio");
    const sentence = `This workspace is built from code at ${acme.url}.`;
    expect(emphasized(sentence, acme)).toEqual(["github.com"]);
    expect(rejoin(sentence, acme)).toBe(sentence);
  });

  it("emphasizes nothing rather than something wrong", () => {
    const acme = origin("https://github.com/acme/studio");
    // A string that does not contain this URL gets no emphasis at all.
    expect(emphasized("Vibestudio 1.4.0", acme)).toEqual([]);
    // Neither does one whose domain we do not know.
    expect(
      emphasized("https://github.com/acme/studio", { ...acme, registrableDomain: null })
    ).toEqual([]);
  });

  it("distinguishes the two lookalikes a person cannot tell apart unaided", () => {
    // Same domain, different owner path: the domain is emphasized identically,
    // and the difference stays visible because the path is never dropped.
    const real = origin("https://github.com/acme/studio");
    const near = origin("https://github.com/acme-studio/studio");
    expect(emphasized(real.url!, real)).toEqual(emphasized(near.url!, near));
    expect(real.originKey).toBe("github.com/acme");
    expect(near.originKey).toBe("github.com/acme-studio");
    expect(rejoin(near.url!, near)).toContain("/acme-studio/");
  });
});
