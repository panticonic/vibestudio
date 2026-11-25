import {isDeepStrictEqual as equal} from 'node:util';
import {observedContentReviewInput} from './observed-content-admission.mjs';
/** Join the whole-goal review to actual native project observations. Artifact
 * profiles retain the existing independent lifecycle/document review binding. */
export function preparedProjectReviewInput(proof,world){
 if(!["commit","draft","pending","occupied","missing","conflict","moved"].includes(world?.profile))throw Error("Expected a declared native project authority profile");
 const project=proof?.preparedContentProject;
 const keys=['contextId','caseId','sourceGroup','repoPath','sourcesPath','before','actual','sourceReadback','sourceNow','journal','artifact'];
 const native=Object.fromEntries(keys.map(key=>[key,project?.[key]]));
 if(project?.contextId!==proof.contextId||project?.caseId!==world.id||project?.sourceGroup!==world.sourceGroup||
   !equal(native,proof.nativeProjectEvidence))throw Error('Expected exact native project observations for goal review');
 if(world.profile==='commit'||world.profile==='draft'){
  const artifact=project.artifact,input=artifact?.semanticReviewInput;
  const expected=world.profile==='commit'?'committed':'draft';
  if(project.expectedOutcome!==expected||artifact?.passed!==true||artifact.semanticReviewRequired!==true||artifact.reasons?.length!==0||
    input?.actual?.contextId!==proof.contextId||!equal(input.actual.state,project.actual?.workingHead)||
    !equal(input.actual.lifecycle?.baseline,{committedEvent:project.before?.committed,workingHead:project.before?.workingHead,clean:project.before?.clean,protectedMainEventId:project.before?.mainEventId})||
    !equal(input.actual.lifecycle?.current,{committedEvent:project.actual?.committed,workingHead:project.actual?.workingHead,clean:project.actual?.clean,protectedMainEventId:project.actual?.mainEventId})||
    input.actual.lifecycle.requestedDisposition!==expected||
    !equal(input.actual.lifecycle?.delta,{committedEventChanged:project.actual?.committed?.eventId!==project.before?.committed?.eventId,workingHeadChanged:!equal(project.actual?.workingHead,project.before?.workingHead),protectedMainChanged:project.actual?.mainEventId!==project.before?.mainEventId})||
    !Array.isArray(input.actual.documents)||input.actual.documents.length===0||typeof input.rubric!=='string'||!input.rubric.trim())
      throw Error('Expected independently read native project lifecycle and retained documents');
 }
 return observedContentReviewInput(proof,world);
}
