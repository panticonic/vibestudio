import {isDeepStrictEqual as equal} from "node:util";
import {createHash} from "node:crypto";
/** Per-domain actual native evidence; no expected answer vocabulary enters review. */
export const observedContentFields = {
  "workspace-smoke": [["assignment","source","selection","runtime","effects"],["receipt","retainedText"]],
  "delivery-wake": [["assignment","evidence","initial","current","nativeReceipt","effects"],[]],
  notificationState: [["journal","assigned","initial","refresh","current","ack","final","durable"], []],
  systemCandidateTriage: [["card","frontier","preview","gate","readback","journal"],["body"]],
  scaffoldReview: [["card","options","units","receipt","readback","journal"],[]],
  "provenance-question": [["assignment","candidates","evidence","native","effects"], []],
  desktopReadiness: [["desk","window","updates","exactAdmission","journal"], []],
  preparedContentProject: [["nativeProjectEvidence"], []],
  phoneFirstRun: [["card","assignment","phases","build","journal","refusedOperations","nativeFacts"], []],
  mobileContinuity: [["profile","observations","journal"], []],
  "source-attribution": [["assignment","files","evidence","effects","native"], ["receipt","retainedText"]],
  "program-run": [["catalog","inspections","attempts","observations"], ["signedText"]],
  terminalAppRepair: [["journal","proof"], []],
  "live-local-inventory": [["docket","inventoryReadback"], []],
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
  "content-archive": [["assignment", "observation", "working", "receipt", "effects"], []],
  "cli-route": [["docket", "observed", "selected", "scope", "available", "protocol"], []],
  "same-turn-eval": [["assignment", "evidence", "recovery", "effects"], []],
  "agent-capability": [["effects", "assignment", "evidence", "decision", "continuation", "notebookState", "retainedValueReads"], []],
  "board-migration": [["available","rendered","basis","targetObservations","final"], []],
  "bridge-delivery": [["index", "scope", "operations", "bridgeRead", "fileReads", "commit", "nativeFiles"], ["artifact"]],
  "deployed-interface": [["effects", "survey", "observation", "architecture", "decision"], ["handoffText"]],
  "extension-dossier": [["assignment", "review", "candidate", "history", "decision", "effects"], ["dossierText"]],
  "installed-package": [["effects", "assignment", "observed", "plan", "repair", "authorization"], []],
  "intent-discovery": [["notice", "capabilities", "evidence"], ["artifact"]],
  "launch-state": [["index", "frames", "readback", "request", "witness", "effect", "companionReadbacks", "protectedCompanion"], ["artifact"]],
  "panel-source-migration": [["assignment", "observed", "current", "move", "identity", "consumers", "effects"], []],
  "retained-memory": [["brief", "plan", "evidence"], ["artifact"]],
  "route-authority": [["offer", "snapshots", "authority", "choice", "readback", "routeReadbacks"], ["artifact"]],
  "system-release": [["assignment", "runs", "cases", "effects", "handoffProtocol"], ["handoff", "handoffText"]],
  "testkit-closeout": [["pair", "actual", "readReceipts", "staged", "rejectedForeign", "nativeFacts"], ["artifact"]],
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
      "advance",
      "nativeFacts"
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
  "google-runbook": [["productReview"],[]],
  "publication": [["selected","observations","artifact","renderer","journal","reads"],[]],
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
      "finding",
      "nativeInventory"
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
      "checkResults",
      "journal",
      "registry"
    ],
    [
      "stagedText"
    ]
  ],
  "grimoireScene": [
    [
      "docket",
      "view",
      "current",
      "scope",
      "gate",
      "readback",
      "journal",
      "nativeFacts"
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
 return observedContentKinds.has(world.kind)&&!(world.kind==="spectrolite"&&world.writablePath)&&!(world.kind==="google-runbook"&&world.action==="revise");
}
export function observedContentReviewInput(proof,world){
 if(world.kind==="spectrolite"&&world.writablePath||world.kind==="google-runbook"&&world.action==="revise")throw Error("Writable source content requires its retained edit-scope review");
 const fields=observedContentFields[world.kind],input=proof.semanticReviewInput;
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 const required=proof.outcomeContract?.returnedValue?.required;
 for(const field of ["requestedReturnRequired","requestedAnswerRequired"])if(Object.hasOwn(world,field)&&(typeof world[field]!=="boolean"||world[field]!==required))throw Error("Goal return obligation differs from its authored literal contract");
 const recoveryShapes={"cli-route":{objects:["docket","observed","selected","protocol"],arrays:["available"]},"same-turn-eval":{objects:["assignment","evidence"],arrays:["effects"]},"content-archive":{objects:["assignment","observation"],arrays:["working","effects"]},"agent-capability":{objects:["assignment","evidence","notebookState"],arrays:["effects"]}};
 const recovery=recoveryShapes[world.kind];
 if(recovery&&(recovery.objects.some(key=>!proof[key]||typeof proof[key]!=="object"||Array.isArray(proof[key]))||recovery.arrays.some(key=>!Array.isArray(proof[key]))))throw Error("Recovery meaning review requires actual native identity, observations and operation evidence");
 if(world.kind==="phoneFirstRun"&&(!Array.isArray(proof.refusedOperations)||proof.refusedOperations.some(row=>!row||typeof row.service!=="string"||typeof row.method!=="string"||typeof row.reason!=="string")))throw Error("Phone meaning review requires actual native refusal observations");
 if(world.kind==="phoneFirstRun"){
  const facts=proof.nativeFacts,roles={assignment:["phoneFirstRun","inspect"],startup:["phoneFirstRun","phases"],provider:["phoneFirstRun","provider"],resume:["phoneSetupRead","readiness"]};
  if(!facts||typeof facts!=="object"||!Array.isArray(proof.journal)||!facts.actorObserved||
     Object.entries(roles).some(([role,[service,method]])=>typeof facts.actorObserved[role]!=="boolean"||facts.actorObserved[role]!==proof.journal.some(row=>row?.service===service&&row?.method===method))||
     !facts.workspaceBefore||typeof facts.workspaceBefore!=="object"||!facts.workspaceAfter||typeof facts.workspaceAfter!=="object"||
     typeof facts.readProtocol!=="string"||!facts.readProtocol.trim()||typeof facts.evidenceProtocol!=="string"||!facts.evidenceProtocol.trim())throw Error("Phone meaning review requires actual actor observations and native workspace/protocol facts");
 }

 if(world.kind==="testkit-closeout"){
  const facts=proof.nativeFacts;
  if(!facts||!Array.isArray(proof.actual)||proof.actual.length!==2||!Array.isArray(proof.readReceipts)||
     !["off","clear","any"].includes(facts.privateNotePermission)||typeof facts.protocol!=="string"||!facts.protocol.trim()||
     ["current","prior"].some((role,index)=>!facts[role]||typeof facts[role].receipt!=="string"||facts[role].receipt!==proof.pair?.[role]?.receipt||
       facts[role].evidence?.receipt!==facts[role].receipt||!equal(facts[role].evidence,proof.actual[index])||
       typeof facts[role].actorInspected!=="boolean"||facts[role].actorInspected!==proof.readReceipts.includes(facts[role].receipt))||
     facts.current.receipt===facts.prior.receipt)throw Error("Testkit review requires exact current/prior native attempt roles and truthful inspection custody");
 }

 if(world.kind==="local-width"){
  const inventory=proof.nativeInventory;
  const readbacks=Array.isArray(proof.effects)?proof.effects.filter(row=>row?.service==="localModels"):null;
  if(!inventory||!Array.isArray(inventory.current)||inventory.current.some(row=>!row||typeof row.slug!=="string"||typeof row.state!=="string")||
     !readbacks||typeof inventory.actorObserved!=="boolean"||inventory.actorObserved!==(readbacks.length>0)||
     !equal(inventory.readbacks,readbacks)||readbacks.some(row=>row.method!=="listModels"||!equal(row.args,[])||!Array.isArray(row.result)||!equal(row.result,inventory.current)))
    throw Error("Local width review requires exact native inventory wire readbacks, distinct from interpreted readiness");
 }
 if(world.kind==="agent-capability"){
  const reads=proof.retainedValueReads;
  const effects=Array.isArray(proof.effects)?proof.effects.filter(row=>row?.service==="agentCapabilityEvidence"&&row?.method==="readRetainedValues"):null;
  if(!Array.isArray(reads)||!effects||reads.some(row=>!row||typeof row.id!=="string"||typeof row.resultDigest!=="string"||typeof row.revision!=="string"||typeof row.returned!=="boolean"||
      (row.returned?row.values!==null&&!Array.isArray(row.values):row.values!==null||typeof row.refusal!=="string"||!row.refusal))||
     !equal(reads.filter(row=>row.returned).map(row=>({args:[row.id,row.resultDigest,row.revision],result:row.values})),effects.map(row=>({args:row.args,result:row.result})))||
     reads.some(row=>row.values?.some(value=>!value||typeof value.content!=="string"||typeof value.digest!=="string"||
       value.digest!==createHash("sha256").update(value.content).digest("hex")||value.attempt?.id!==row.id||value.attempt?.notebook!==proof.assignment?.notebook||
       value.revision!==row.revision||value.attempt?.revision!==row.revision||!Array.isArray(proof.assignment?.attempts)||!equal(value.attempt,proof.assignment.attempts.find(card=>card.id===row.id))||
       !proof.effects.some(effect=>effect?.service==="agentCapabilityEvidence"&&effect?.method==="inspect"&&effect.result?.attempt?.id===row.id&&effect.result?.runId===value.runId&&effect.result?.resultDigest===row.resultDigest&&effect.result?.notebook?.revision===row.revision)||
       typeof value.runId!=="string"||typeof value.key!=="string"||
       !(value.observedAfterContinuation===null||typeof value.observedAfterContinuation==="string"&&value.observedAfterContinuation===proof.continuation?.runId))))
    throw Error("Agent recovery review requires actual owner-bound retained value reads and explicit refusals");
 }
 if(!fields||typeof required!=="boolean"||proof.semanticReviewRequired!==true||
    !equal(input?.actual,{goal:world.goal,observations:pick(fields[0]),artifacts:pick(fields[1]),requestedReturn:required?proof.actualResult??null:null})||
    !equal(input.expected,{goal:world.goal,requestedReturnRequired:required})||typeof input.rubric!=="string"||!input.rubric.trim())
   throw Error("Content meaning review must bind the requested return, actual native observations and retained bytes");
 return input;
}
