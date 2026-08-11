# Manual agentic workspace rescue

This is the pre-launch operator path when a workspace's own harness or template
Composer cannot start. Its only goal is to repair normal startup and hand back
to the ordinary retained template-update session. It is not an alternate
migration or publication mechanism.

## Safety boundary

- Work on an isolated fork/rescue context and preserve the current protected
  main event as the rollback point.
- Materialize the exact rescue context through the host's existing semantic VCS
  materialization path.
- Run Codex in a contained environment whose root is that checkout: clear the
  environment and ambient profiles; expose no provider credentials, user home,
  host paths, host RPC, or Vibestudio CLI authority. The model credential stays
  with the outside driver, never with commands run from repository-controlled
  code.
- Read system notes from the host-shipped `base-template-release.json`, not from
  the mutable workspace's `migrations/system` copy. Record every rescue output
  as outside/model-authored content.

## Procedure

1. Stop ordinary use of the affected workspace and record its workspace id,
   current protected-main event, host version, and release artifact.
2. Create a disposable semantic fork/rescue context and materialize its exact
   checkout into a uniquely named contained working directory.
3. Give Codex only the checkout, the host artifact's raw system notes, and this
   mission: inspect actual state; repair the smallest surface needed for the
   workspace harness and normal template Composer to start; run the notes'
   relevant verification plus focused startup/build checks; do not attempt to
   complete or publish the template migration from outside.
4. Review the diff and transcript. If the harness/Composer startup contract is
   not proved, leave protected main unchanged and escalate with the evidence.
5. Import the repaired exact snapshot into the rescue context using the
   existing `importSnapshot` path. Supply external integrity/lineage keys for
   every outside checkpoint; never attribute rescue bytes to the host.
6. Commit the imported repair and publish it through the existing protected-main
   mutation and approval path. There is no rescue-only authoring bridge.
7. Start the workspace's own harness, locate the durable host base-template
   operation, and finish it with the Templates skill: read incoming notes,
   repair contract-first, verify, journal, and `resume` through normal gates.
8. Confirm the ordinary operation landed and normal startup works, then remove
   the disposable materialization and contained process. Preserve the semantic
   transcript and events as the rescue record.

If the contained repair cannot restore the normal path, stop. The terminal
fallback is rebirth: recompose from current templates and agentically re-import
user repositories and reconnect surviving private data. Rebirth preserves code
and stored bytes as a floor; it is not promised to reconnect every userland
database automatically.
