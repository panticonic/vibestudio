import {isDeepStrictEqual as equal} from "node:util";
/** Per-domain actual native evidence; no expected answer vocabulary enters review. */
export const observedContentFields = {
  "owned-operations": [["docket","effects","audit"], ["dossierReadback"]],
  "personal-automation": [["initial","latest","observations","independent","attempts","requests"], []],
  "personal-artifacts": [["libraryFirst","collectionFirst","independentLibrary","independentCollection","libraryWrites","collectionWrites","links","refreshes"], []],
  "personal-history": [["catalogEvent","repositoryId","milestones","discovery","operations","reads"], []],
  "unit-handoff": [["nativeReviewEvidence"], []],
  gmail: [["catalog", "selected", "native", "operations", "requests", "persisted", "before", "readback", "providerObservations"], []],
  calendar: [["catalog", "attempts", "providerRequests", "windows", "readback"], ["handoffText"]],
  "google-handoff": [["threads", "reviews", "providerRequests", "freshness"], ["handoffText"]],
  news: [["initial", "latest", "observations", "reads", "attempts", "concurrentReceipt"], []],
  spectrolite: [["observations", "hops", "receipts", "final"], []],
  "agent-capability": [["effects", "assignment", "evidence", "decision", "continuation"], []],
  "bridge-delivery": [["index", "scope", "operations", "bridgeRead", "fileReads", "commit"], ["artifact"]],
  "deployed-interface": [["effects", "survey", "observation", "architecture", "decision"], ["handoffText"]],
  "extension-dossier": [["assignment", "review", "candidate", "history", "decision", "effects"], ["dossierText"]],
  "installed-package": [["effects", "assignment", "observed", "plan", "repair"], []],
  "intent-discovery": [["notice", "capabilities", "evidence"], ["artifact"]],
  "launch-state": [["index", "frames", "readback", "request", "witness", "effect", "companionReadbacks", "protectedCompanion"], ["artifact"]],
  "panel-source-migration": [["assignment", "observed", "current", "move", "identity", "consumers", "effects"], []],
  "retained-memory": [["brief", "plan", "evidence"], ["artifact"]],
  "route-authority": [["offer", "snapshots", "authority", "choice", "readback"], ["artifact"]],
  "system-release": [["assignment", "runs", "cases", "effects"], ["handoffText"]],
  "testkit-closeout": [["pair", "actual", "readReceipts", "staged", "rejectedForeign"], ["artifact"]],
  "webhook-admission": [["assignment", "evidence", "binding", "effects"], ["handoffText"]],
  "workspace-claims": [["index", "packet", "choice", "evidence", "support", "test", "authority", "guideRevision"], ["artifact"]],
  "workspace-config": [["brief", "lens", "evidence"], ["artifact"]],
  "workspace-share": [["assignment", "observation", "decision", "effects"], ["handoffText"]],
  "gadDurableQuestion": [["diagnostics"], []],
  "examplesAdoption": [["card", "installed", "composition", "gate", "journal"], ["noteText"]],
  "system-diagnostics": [["catalog", "windows"], ["handoffReadback"]],
  templateMigration: [
    ["journal", "observations", "readIds", "nativePrepared", "protectedMain"],
    ["handoff", "receiptText"]
  ],
  "image-candidate": [
    [
      "index",
      "snapshots",
      "reads"
    ],
    [
      "artifact"
    ]
  ],
  "regency-briefing": [
    [
      "index",
      "frontiers",
      "forecasts",
      "witnesses",
      "advance"
    ],
    [
      "artifact"
    ]
  ],
  "demo-portfolio": [
    [
      "index",
      "frames",
      "projection",
      "garden",
      "realm"
    ],
    [
      "artifact"
    ]
  ],
  "chat-continuity": [
    [
      "index",
      "frames",
      "evidence"
    ],
    [
      "artifact"
    ]
  ],
  "owned-task": [
    [
      "effects",
      "current",
      "original",
      "delivery",
      "nativeDeliveryError",
      "raceInjected",
      "resultArtifacts"
    ],
    []
  ],
  "scheduled-recovery": [
    [
      "current",
      "authorization",
      "delivery",
      "effects"
    ],
    []
  ],
  "unit-rollout": [
    [
      "discoveries",
      "observations",
      "readbacks",
      "edits",
      "candidateChecks",
      "commits",
      "race",
      "independent"
    ],
    []
  ],
  "local-delivery": [
    [
      "catalog",
      "observations",
      "attempt",
      "readback",
      "nativeProofs",
      "boundaries",
      "rosterReadbacks"
    ],
    []
  ],
  "local-reconciliation": [
    [
      "effects",
      "window",
      "race",
      "release",
      "mergeHead",
      "nativeHead",
      "archiveRecheck",
      "integrationOracle"
    ],
    [
      "artifact"
    ]
  ],
  "recovery": [
    [
      "catalog",
      "observed",
      "durable"
    ],
    [
      "handoffText"
    ]
  ],
  "tendrilRoute": [
    [
      "current",
      "finding",
      "journal"
    ],
    [
      "receiptBytes"
    ]
  ],
  "assetIntegrity": [
    [
      "approved",
      "working",
      "findings",
      "journal"
    ],
    [
      "receiptBytes"
    ]
  ],
  "localPresentation": [["current","journal","preview","previewDisplay"],["report","display"]],
  "local-width": [
    [
      "effects",
      "survey",
      "finding"
    ],
    [
      "handoffText"
    ]
  ],
  "pdf": [
    [
      "selection",
      "documents",
      "revision",
      "binding",
      "observations"
    ],
    []
  ],
  "capability-plan": [
    [
      "observed"
    ],
    [
      "stagedBody"
    ]
  ],
  "provider-handoff": [
    [
      "card",
      "listedCards",
      "snapshots",
      "outputs"
    ],
    [
      "artifact"
    ]
  ],
  "workspace-assembly": [
    [
      "observed",
      "reads",
      "buildReceipts"
    ],
    [
      "durableText"
    ]
  ],
  "specialist-handoff": [
    [
      "index",
      "snapshots",
      "independent",
      "result",
      "membershipReads",
      "artifactReads"
    ],
    [
      "artifact"
    ]
  ],
  "api-readiness": [
    [
      "index",
      "snapshots",
      "planned",
      "calls",
      "seenPlan",
      "observations",
      "audit"
    ],
    [
      "artifact"
    ]
  ],
  "news-evidence": [
    [
      "index",
      "snapshots",
      "reads",
      "sources",
      "independent"
    ],
    [
      "artifact"
    ]
  ],
  "dictation-handoff": [
    [
      "thread",
      "listed",
      "snapshots",
      "independent",
      "exactDraft"
    ],
    [
      "artifact"
    ]
  ],
  "personal-welcome": [
    [
      "index",
      "snapshots",
      "resolution",
      "ownerRead",
      "independent",
      "probeInput",
      "probeRun"
    ],
    [
      "artifact"
    ]
  ],
  "terminal-handoff": [
    [
      "initial",
      "opened",
      "events",
      "observedExit",
      "discovery",
      "checkPlan",
      "checkResults"
    ],
    [
      "stagedText"
    ]
  ],
  "grimoireScene": [
    [
      "docket",
      "view",
      "scope",
      "gate",
      "readback",
      "journal"
    ],
    [
      "body"
    ]
  ],
  "audience-response": [["current","observed","operated"],["presentation"]],
  "google": [
    [
      "requests",
      "discovery",
      "observed"
    ],
    []
  ]
};
export const observedContentKinds = new Set(Object.keys(observedContentFields));
export function observedContentNeedsReview(world){
 // Open user goals need meaning review of native effects even without a requested return.
 return observedContentKinds.has(world.kind);
}
export function observedContentReviewInput(proof,world){
 if(world.kind==="spectrolite"&&world.writablePath)throw Error("Writable source content requires its retained edit-scope review");
 const fields=observedContentFields[world.kind],input=proof.semanticReviewInput;
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 const required=proof.outcomeContract?.returnedValue?.required;
 if(!fields||typeof required!=="boolean"||proof.semanticReviewRequired!==true||
    !equal(input?.actual,{goal:world.goal,observations:pick(fields[0]),artifacts:pick(fields[1]),requestedReturn:required?proof.actualResult??null:null})||
    !equal(input.expected,{goal:world.goal,requestedReturnRequired:required})||typeof input.rubric!=="string"||!input.rubric.trim())
   throw Error("Content meaning review must bind the requested return, actual native observations and retained bytes");
 return input;
}
