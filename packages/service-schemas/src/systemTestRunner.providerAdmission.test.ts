import { expect, it } from "vitest";
import { systemTestRunSummarySchema } from "./systemTestRunner.js";
const summary = {runId:"TEST-run",status:"cancelled",total:4,passed:2,failed:2,errored:0,toolFailureCount:0,testsWithToolFailures:0,skipped:0,notInstalled:[],durationMs:1,failedTests:["TEST-one","TEST-two"],testsWithUnexpectedToolFailures:[]};
it("preserves optional source-bound pending admission evidence through the real shared schema",()=>{
 const admissionStopped={reason:"provider-transport-outage",queuedTests:["TEST-three"],evidence:[{caseName:"TEST-one",callId:"TEST-call",kind:"generation",model:"TEST:local",errorSha256:"a".repeat(64),circuitOpen:false}]};
 expect(systemTestRunSummarySchema.parse({...summary,admissionStopped})).toEqual({...summary,admissionStopped});
 expect(systemTestRunSummarySchema.parse(summary)).toEqual(summary);
 expect(()=>systemTestRunSummarySchema.parse({...summary,admissionStopped:{...admissionStopped,evidence:[{...admissionStopped.evidence[0],errorSha256:"invented"}]}})).toThrow();
});
