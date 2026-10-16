import { describe, expect, it } from "vitest";
import type { PendingUnitInstallReviewApproval } from "./approvals.js";
import type { InstallReviewPart } from "./authority/unitInstallReview.js";
import {
  formatLaunchGateForTerminal,
  formatLaunchGateUnitsForTerminal,
  launchGateSources,
  launchGateView,
  samePendingApprovals,
  sourceLabel,
} from "./bootstrapLaunchGate.js";
import { templateOrigin } from "@vibestudio/origin-identity";

const hostOrigin = {
  url: null,
  originKey: "vibestudio",
  registrableDomain: null,
  version: "1.4.0",
  isHostBuild: true as const,
  isWorkspaceRoot: true,
  firstEncounter: false,
};

function part(overrides: Partial<InstallReviewPart> = {}): InstallReviewPart {
  return {
    identityKey: `${overrides.repoPath ?? "apps/shell"}@ev`,
    kind: "client",
    label: "Client",
    surfaces: [],
    name: "@workspace-apps/shell",
    title: "Shell",
    purpose: "The desktop app itself.",
    repoPath: "apps/shell",
    effectiveVersion: "ev",
    version: "1.0.0",
    requiredUnitKeys: [],
    runsInBackground: false,
    runtime: "web",
    origin: hostOrigin,
    notableRows: [],
    everydayRows: [],
    change: "added",
    section: "template",
    ...overrides,
  };
}

function review(
  parts: InstallReviewPart[],
  executionPlatform: PendingUnitInstallReviewApproval["executionPlatform"] = "linux"
): PendingUnitInstallReviewApproval {
  return {
    kind: "unit-install-review",
    approvalId: "gate-1",
    callerId: "system:startup",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "",
    requestedAt: 1,
    executionPlatform,
    mode: "adopt-root",
    title: "Start this workspace?",
    description: "",
    parts,
    summary: { panels: 0, agents: 0, services: 0, clients: 0, extensions: 0 },
    unchangedPartCount: 0,
  };
}

const acme = {
  url: "https://github.com/acme/studio",
  originKey: "github.com/acme",
  registrableDomain: "github.com",
  version: "v2.1",
  selfName: "Acme Studio",
  isHostBuild: false as const,
  firstEncounter: true,
};

const acmeRoot = { ...acme, isWorkspaceRoot: true };

describe("the common case", () => {
  it("reads as one fact and one button", () => {
    const view = launchGateView({
      approvals: [
        review([
          part(),
          part({
            kind: "extension",
            label: "Extension",
            repoPath: "extensions/shell",
            runtime: null,
          }),
        ]),
      ],
    });

    expect(view.summary).toBe(
      "Vibestudio needs to run 2 programs on this computer — 1 client · 1 extension, all from Vibestudio 1.4.0."
    );
    expect(view.sources).toHaveLength(1);
    expect(view.sourcesExpandedByDefault).toBe(false);
    expect(view.acceptLabel).toBe("Start");
  });

  it("discloses the execution contract of the workspace host", () => {
    const withExtension = launchGateView({
      approvals: [review([part({ kind: "extension", label: "Extension", runtime: null })])],
    });
    expect(withExtension.nativeCodeWarning).toBe(
      "Workspace commands and extensions run in a sandbox on the Linux host. Separately approved host actions can run outside that sandbox."
    );
    expect(
      launchGateView({
        approvals: [
          review([part({ kind: "extension", label: "Extension", runtime: null })], "windows"),
        ],
      }).nativeCodeWarning
    ).toBe(
      "Workspace commands and extensions run on the Windows host with the host account's permissions."
    );
    expect(
      launchGateView({
        approvals: [
          review([part({ kind: "extension", label: "Extension", runtime: null })], "macos"),
        ],
      }).nativeCodeWarning
    ).toContain("run in a sandbox on the macOS host");
    expect(launchGateView({ approvals: [review([part()])] }).nativeCodeWarning).toBeNull();
  });
});

describe("identity without an identity system", () => {
  it("shows the origin URL, because there is nothing else that is not self-asserted", () => {
    expect(sourceLabel(acme)).toBe("https://github.com/acme/studio  at v2.1");
  });

  it("lets the host name its own build, and nothing else name itself", () => {
    expect(sourceLabel(hostOrigin)).toBe("Vibestudio 1.4.0");
    // A hostile template calling itself Vibestudio still renders as its URL.
    expect(sourceLabel({ ...acme, selfName: "Vibestudio" })).not.toContain("Vibestudio 1.4.0");
  });

  it("renders an internationalized origin as punycode, with no unicode trickery", () => {
    // Origins are only ever constructed here, from a template pin.
    const origin = templateOrigin({
      url: "https://\u0430pple.com/acme/studio",
      version: "v1",
      admittedOriginKeys: new Set(),
    });
    expect(origin.registrableDomain).toBe("xn--pple-43d.com");
    expect(origin.url).not.toMatch(/[^\x00-\x7f]/u);
    expect(sourceLabel(origin)).toContain("xn--pple-43d.com");
  });

  it("states the registrable domain, so a lookalike host cannot pass as a known one", () => {
    const lookalike = templateOrigin({
      url: "https://github.com.attacker.net/acme/studio",
      version: "v1",
      admittedOriginKeys: new Set(),
    });
    const [source] = launchGateSources([part({ origin: lookalike })]);

    // The URL is whole, and the fact beside it names the domain that owns it.
    expect(source!.label).toBe("https://github.com.attacker.net/acme/studio  at v1");
    expect(source!.domainLine).toBe("Domain: attacker.net");
    expect(source!.domainLine).not.toContain("github.com");
  });

  it("says nothing about a domain for our own build, which asserts nothing", () => {
    const [source] = launchGateSources([part()]);
    expect(source!.domainLine).toBeNull();
  });

  it("never quietly rewrites the identity string", () => {
    // A non-default port is part of who this is. Dropping it made two different
    // sources print identically.
    const origin = templateOrigin({
      url: "https://git.example.test:8443/acme/studio",
      version: "v2",
      admittedOriginKeys: new Set(),
    });
    expect(origin.url).toBe("https://git.example.test:8443/acme/studio");
    expect(sourceLabel(origin)).toContain(":8443");
  });

  it("keys first encounter on the origin, so a new repo under a known owner is not a new source", () => {
    const known = new Set(["github.com/acme"]);
    expect(
      templateOrigin({
        url: "https://github.com/acme/other",
        version: null,
        admittedOriginKeys: known,
      }).firstEncounter
    ).toBe(false);
    expect(
      templateOrigin({
        url: "https://github.com/other/x",
        version: null,
        admittedOriginKeys: known,
      }).firstEncounter
    ).toBe(true);
  });

  it("marks a first encounter with an origin, and only a first encounter", () => {
    const first = launchGateSources([part({ origin: acme })]);
    expect(first[0]!.firstEncounterLine).toBe("You haven't run code from github.com/acme before.");
    const familiar = launchGateSources([part({ origin: { ...acme, firstEncounter: false } })]);
    expect(familiar[0]!.firstEncounterLine).toBeNull();
  });
});

describe("a workspace built from someone else's code", () => {
  const acmeWorkspace = () => [
    review([
      part({ repoPath: "apps/studio", title: "Studio", origin: acmeRoot }),
      part({
        kind: "extension",
        label: "Extension",
        repoPath: "extensions/acme-tools",
        title: "Acme Tools",
        runtime: null,
        origin: acmeRoot,
      }),
    ]),
  ];

  it("leads with the origin even when it is the only source", () => {
    // The case the single-source sentence used to swallow: everything here is
    // from github.com/acme, and "all from ..." buried that at the end of a
    // sentence about counts.
    const view = launchGateView({ approvals: acmeWorkspace() });

    expect(view.summary).toBe(
      "This workspace is built from code at https://github.com/acme/studio."
    );
    expect(view.sources).toHaveLength(1);
  });

  it("puts the first encounter at the top level, not inside the disclosure", () => {
    const view = launchGateView({ approvals: acmeWorkspace() });

    expect(view.firstEncounterLine).toBe("You haven't run code from github.com/acme before.");
    // Promoted, not duplicated.
    expect(view.sources[0]!.firstEncounterLine).toBeNull();
    expect(view.sourcesExpandedByDefault).toBe(true);
    expect(view.disclosureLabel).toBe("Review each");
  });

  it("promotes the domain beside the URL it leads with, and does not repeat it below", () => {
    const view = launchGateView({ approvals: acmeWorkspace() });

    expect(view.domainLine).toBe("Domain: github.com");
    expect(view.sources[0]!.domainLine).toBeNull();
  });

  it("keeps the program count when it leads with an origin", () => {
    expect(launchGateView({ approvals: acmeWorkspace() }).programsLine).toBe(
      "It needs to run 2 programs on this computer, including 1 extension."
    );
  });

  it("says nothing about a first encounter with an origin the user has run before", () => {
    const familiar = { ...acmeRoot, firstEncounter: false };
    const view = launchGateView({
      approvals: [review([part({ origin: familiar }), part({ origin: familiar })])],
    });

    expect(view.summary).toBe(
      "This workspace is built from code at https://github.com/acme/studio."
    );
    expect(view.firstEncounterLine).toBeNull();
    expect(view.sources[0]!.firstEncounterLine).toBeNull();
  });

  it("never lets a template's self-given name stand where identity is read", () => {
    const impostor = { ...acmeRoot, selfName: "Vibestudio" };
    const view = launchGateView({
      approvals: [review([part({ origin: impostor }), part({ origin: impostor })])],
    });

    expect(view.summary).toBe(
      "This workspace is built from code at https://github.com/acme/studio."
    );
    expect(view.sources[0]!.label).toBe("https://github.com/acme/studio  at v2.1");
    // The name survives only in the slot that says whose name it is.
    const text = words(
      formatLaunchGateForTerminal([review([part({ origin: impostor })])], "desktop")
    );
    expect(text).toContain(words('"Vibestudio" — name given by this template'));
    expect(text).not.toContain("all from Vibestudio");
  });
});

describe("more than one source", () => {
  it("names every source and orders unfamiliar ones first", () => {
    const view = launchGateView({
      approvals: [
        review([
          part(),
          part({
            kind: "extension",
            label: "Extension",
            repoPath: "extensions/news",
            title: "Feed Reader",
            runtime: null,
            origin: acme,
          }),
        ]),
      ],
    });

    expect(view.sourcesExpandedByDefault).toBe(true);
    expect(view.sources.map((source) => source.origin.originKey)).toEqual([
      "github.com/acme",
      "vibestudio",
    ]);
    expect(view.summary).toBe("Vibestudio needs to run 2 programs on this computer.");
  });

  it("orders unfamiliar origins first and our own build last, stably", () => {
    const familiar = {
      url: "https://github.com/panticonic/news",
      originKey: "github.com/panticonic",
      registrableDomain: "github.com",
      version: "v1.2.0",
      isHostBuild: false as const,
      firstEncounter: false,
    };
    const sources = launchGateSources([
      part({ repoPath: "apps/shell" }),
      part({
        repoPath: "extensions/news",
        kind: "extension",
        label: "Extension",
        origin: familiar,
      }),
      part({ repoPath: "extensions/acme", kind: "extension", label: "Extension", origin: acme }),
    ]);

    expect(sources.map((source) => source.origin.originKey)).toEqual([
      "github.com/acme",
      "github.com/panticonic",
      "vibestudio",
    ]);
  });

  it("preserves distinct reviewed identities when program titles repeat", () => {
    const source = launchGateSources([
      part({ repoPath: "extensions/local-models", title: "local-models", origin: acme }),
      part({ repoPath: "workers/local-models", title: "local-models", origin: acme }),
    ])[0]!;
    expect(source.units.map((unit) => unit.name)).toEqual(["local-models", "local-models"]);
    expect(source.units.map((unit) => unit.identityKey)).toEqual([
      "extensions/local-models@ev",
      "workers/local-models@ev",
    ]);
  });

  it("counts the base as the workspace's own source, so one added extension does not lead", () => {
    // 16 programs from our build and one extension from elsewhere: the added
    // extension is named in the list, but it is not what this workspace is.
    const base = Array.from({ length: 16 }, (_unused, index) =>
      part({ repoPath: `apps/base-${index}` })
    );
    const view = launchGateView({
      approvals: [
        review([
          ...base,
          part({
            kind: "extension",
            label: "Extension",
            repoPath: "extensions/news",
            title: "Feed Reader",
            runtime: null,
            origin: acme,
          }),
        ]),
      ],
    });

    expect(view.summary).toBe("Vibestudio needs to run 17 programs on this computer.");
    expect(view.programsLine).toBeNull();
    // Still named, never folded into a count, and still first.
    expect(view.sources[0]!.firstEncounterLine).toBe(
      "You haven't run code from github.com/acme before."
    );
  });
});

describe("declining says what it costs", () => {
  it("says the app will not start when the app is what is under review", () => {
    const view = launchGateView({ approvals: [review([part()])] });
    expect(view.declineConsequence).toBe(
      "Vibestudio won't start. Nothing is installed or changed."
    );
    expect(view.declineLabel).toBe("Quit");
  });

  it("says only that extension will not run when nothing else is at stake", () => {
    const view = launchGateView({
      approvals: [
        review([part({ kind: "extension", label: "Extension", title: "News", runtime: null })]),
      ],
    });
    expect(view.declineConsequence).toBe(
      "The News extension won't run. The rest of your workspace works normally."
    );
    expect(view.declineLabel).toBe("Don't start");
  });

  it("names every extension when several are declined together", () => {
    const view = launchGateView({
      approvals: [
        review([
          part({ kind: "extension", label: "Extension", title: "News", runtime: null }),
          part({
            kind: "extension",
            label: "Extension",
            title: "Calendar",
            runtime: null,
            repoPath: "extensions/calendar",
          }),
        ]),
      ],
    });
    expect(view.declineConsequence).toBe(
      "The News and Calendar extensions won't run. The rest of your workspace works normally."
    );
  });
});

describe("the terminal form", () => {
  it("carries the same sources, notable lines, and consequence copy as the window", () => {
    const text = words(
      formatLaunchGateForTerminal(
        [
          review([
            part(),
            part({
              kind: "extension",
              label: "Extension",
              repoPath: "extensions/news",
              title: "Feed Reader",
              runtime: null,
              origin: acme,
            }),
          ]),
        ],
        "desktop"
      )
    );

    expect(text).toContain(words("https://github.com/acme/studio  at v2.1"));
    expect(text).toContain(words('"Acme Studio" — name given by this template'));
    expect(text).toContain(words("You haven't run code from github.com/acme before."));
    expect(text).toContain(words("run in a sandbox on the Linux host"));
    expect(text).toContain(words("Vibestudio won't start. Nothing is installed or changed."));
  });

  it("leads with the same origin, first encounter, and count as the window", () => {
    const approvals = [
      review([
        part({ repoPath: "apps/studio", origin: acmeRoot }),
        part({
          kind: "extension",
          label: "Extension",
          repoPath: "extensions/acme",
          runtime: null,
          origin: acmeRoot,
        }),
      ]),
    ];
    const view = launchGateView({ approvals });
    const text = words(formatLaunchGateForTerminal(approvals, "terminal"));

    expect(text).toContain(words(view.summary));
    expect(text).toContain(words(view.domainLine!));
    expect(text).toContain(words(view.firstEncounterLine!));
    expect(text).toContain(words(view.programsLine!));
    expect(text).toContain(words(view.nativeCodeWarning!));
    // Promoted once, in both forms — never printed twice.
    expect(text.split(view.firstEncounterLine!).length - 1).toBe(1);
  });

  it("states the domain in words, because plain text cannot emphasize honestly", () => {
    // The window emphasizes the registrable domain inside the URL. Plain text
    // has no way to do that which a hostile URL could not imitate, so the
    // terminal carries the same claim as a sentence — and the URL stays whole.
    const lookalike = templateOrigin({
      url: "https://github.com.attacker.net/acme/studio",
      version: "v1",
      admittedOriginKeys: new Set(),
    });
    const text = words(
      formatLaunchGateForTerminal(
        [review([part(), part({ repoPath: "extensions/x", origin: lookalike })])],
        "terminal"
      )
    );

    expect(text).toContain(words("https://github.com.attacker.net/acme/studio  at v1"));
    expect(text).toContain(words("Domain: attacker.net"));
    // Our own build claims no domain, and no line pretends the lookalike is
    // github.com.
    expect(text).not.toContain("Domain: github.com");
    expect(text).not.toContain("Domain: vibestudio");
  });

  it("prints no commit id or content digest at any level", () => {
    const text = words(
      formatLaunchGateForTerminal([review([part(), part({ origin: acme })])], "desktop")
    );
    expect(text).not.toMatch(/[0-9a-f]{40}/u);
    expect(text).not.toContain("ev");
  });
});

/** Wrapping is layout: compare the terminal form as words. */
function words(text: string): string {
  return text.replace(/\s+/gu, " ");
}

describe("an instance's first start", () => {
  it("asks once about every workspace it starts, each named by where its code is", () => {
    const systemRoot = templateOrigin({
      url: "https://github.com/acme/system",
      version: null,
      admittedOriginKeys: new Set(),
      isWorkspaceRoot: true,
    });
    const personalRoot = templateOrigin({
      url: "https://github.com/acme/personal",
      version: null,
      admittedOriginKeys: new Set(),
      isWorkspaceRoot: true,
    });
    const approvals = [
      review([
        part({ repoPath: "apps/shell", origin: systemRoot }),
        part({
          repoPath: "panels/about",
          kind: "panel",
          label: "Panel",
          runtime: null,
          origin: systemRoot,
        }),
      ]),
      review([
        part({
          repoPath: "panels/chat",
          kind: "panel",
          label: "Panel",
          title: "chat",
          runtime: null,
          origin: personalRoot,
        }),
      ]),
    ];
    const view = launchGateView({ approvals });
    expect(view.title).toBe("Start your workspaces?");
    expect(view.summary).toBe(
      "Your workspaces are built from code at https://github.com/acme/personal and https://github.com/acme/system."
    );
    // One owner, said once.
    expect(view.firstEncounterLine).toBe("You haven't run code from github.com/acme before.");
    // Every program counts somewhere.
    expect(view.sources.map((source) => source.counts).sort()).toEqual([
      "1 client · 1 other part",
      "1 part",
    ]);

    const summary = formatLaunchGateForTerminal(approvals, "terminal", 60);
    expect(summary.split("\n").every((line) => line.length <= 60)).toBe(true);
    // The programs themselves are one step away, not ahead of the question.
    expect(summary).not.toContain("chat (Panel)");
    expect(formatLaunchGateUnitsForTerminal(approvals, 60)).toContain("chat (Panel)");
  });
});

describe("change detection", () => {
  it("treats the same pending set as the same", () => {
    expect(samePendingApprovals([review([part()])], [review([part()])])).toBe(true);
    expect(
      samePendingApprovals([review([part()])], [review([part({ effectiveVersion: "ev-2" })])])
    ).toBe(false);
  });
});
