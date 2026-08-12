---
name: development
description: Use the development panel to adopt Vibestudio source, build an exact semantic working state, run semantic or native development sessions, checkpoint native work, and inspect run diagnostics.
---

# Development panel

`panels/development` is the UI for the canonical `development` service, not a
shell or checkout runner.

- If the project is absent, use the panel's explicit **Adopt source** action.
  It imports `projects/vibestudio` from the credential-free canonical origin and
  creates an ordinary semantic candidate. The panel uses the exact repository
  ID admitted by the atomic import receipt (and resolves it from the current
  semantic state after reload); repository identity is never guessed from the
  display path. Adoption never refreshes, resets, or overwrites local semantic
  work. Integrate that candidate through normal VCS flow before opening a
  development session.
- Choose the session mode explicitly. **Semantic workspace** forks the exact
  semantic working head; **Native tool** launches the selected reviewed tool in
  an owned writable tree. The live tool roster names unavailable tools and the
  executor reason; do not try a different executable or raw host path. Native
  edits only enter semantic history through the explicit **Checkpoint into
  semantic history** action. The panel states that
  native tools and project builds execute with the executor's local OS
  authority; they are not a sandbox.
- Choose a typed reviewed target (build-only, current-host Electron, or
  isolated host with/without a client). The panel never accepts a command line,
  executor path, or filesystem projection as an alternative.
- Opening, stopping, checkpointing, inspecting, and retaining a session are
  owner-scoped actions. Native builds, retrying a build, destruction, and
  force-retirement retain their canonical authority/confirmation behavior.
  Force-retiring a live native session states whether external changes are
  pending and offers **Checkpoint first** while the native tree is readable.
- Refresh is explicit. Live run events append deltas to the selected log; they
  do not reset the log or trigger a full reload for every line. Ambiguous
  mutations retain their idempotency intent until a durable refresh settles it.
- Session and run history is cursor-paged. **Load older** advances the stable
  server cursor without discarding the newest page or fetching unbounded
  history.
- Read native pending-change, terminal, instance, digest, grant, and repair
  facts from the panel/service. Client launch/attestation, host readiness, and
  attached-route state are shown only when their typed run records exist. Do
  not infer them from the selected target, a PID, or gateway URL.
- **Integrate with agent…** and **Integrate checkpoint…** open an ordinary chat
  in the target parent context with the exact source context/event. The agent
  must compare and incrementally integrate through documented semantic VCS.
  Checkpointing and adoption never auto-integrate, reset, or overwrite work.
- Do not infer a build's source from a filesystem projection or claim cleanup
  succeeded when a repair record says an effect is unknown.
