import {isDeepStrictEqual as equal} from "node:util";
/** Per-domain actual native evidence; no expected answer vocabulary enters review. */
export const observedContentFields = {
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
 if(!observedContentKinds.has(world.kind))return false;
 if(world.kind==="unit-rollout")return !world.expected.repair&&!world.expected.release;
 if(world.kind==="owned-task")return !world.expected.update&&!world.expected.handoff;
 if(world.kind==="scheduled-recovery")return !world.expected.effect&&!world.expected.handoff;
 if(world.kind==="local-delivery")return !world.expected.send;
 return true;
}
export function observedContentReviewInput(proof,world){
 const fields=observedContentFields[world.kind],input=proof.semanticReviewInput;
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 const required=proof.outcomeContract?.returnedValue?.required;
 if(!fields||typeof required!=="boolean"||proof.semanticReviewRequired!==(required||fields[1].length>0)||
    !equal(input?.actual,{goal:world.goal,observations:pick(fields[0]),artifacts:pick(fields[1]),requestedReturn:required?proof.actualResult??null:null})||
    !equal(input.expected,{goal:world.goal,requestedReturnRequired:required})||typeof input.rubric!=="string"||!input.rubric.trim())
   throw Error("Content meaning review must bind the requested return, actual native observations and retained bytes");
 return proof.semanticReviewRequired?input:null;
}
