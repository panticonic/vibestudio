# Native model provider evidence

Current shipping source uses the ordinary installed `@panticonic/pi-*` version
`0.99.2-vibestudio.9`. Authenticated native task/trajectory binding and the
credential-connection wake are implemented, and genuine hosted-model workflows
have installed acceptance evidence. The complete installed catalog and immutable
product/template release remain open. The
[implementation audit](durable-pi-implementation-audit.md) records the current
checkpoint, including owner-scoped invocation effects, original error propagation
and joined receipt/transport shutdown.

The component cohort below was verified on 2026-10-02 against version
`0.99.2-vibestudio.5`. It retains the scope and limits of that historical proof;
its counts are not a current product-release verdict.

The production provider port uses the existing `credentials.resolveCredential` and local-model extension operations. Original scheduler intent is durable before protected preparation. Pi's `ModelRequestApi.prepare` commits the effective endpoint before dispatch, preserves all other model metadata, and supplies that endpoint to generation, compaction, deferred retrieval and cancellation. No catalog mutation, URL rewrite or old execution-owner callback participates.

Credential absence parks on a typed, non-model input entry after the conversation's current committed frontier. A successful connection prompts that exact conversation to check again; the credential resolver remains the source of readiness. One read after frontier selection covers a connection that precedes parking. A different provider's event does not wake the task, and continued absence advances the frontier instead of repeatedly waking on an old event. SQLite replacement preserves the original request despite catalog changes.

The local extension owns its shared model servers. The request owns attributed HTTP/socket resources and joins their cancellation or closure. Provider code receives a credential sentinel; the current extension key exists only in the transport closure and is injected at the attributed fetch boundary. The actual endpoint must match the extension's current origin attestation. Cleanup failure retains ownership and propagates its original error.

A prepared local request cannot silently adopt a different supervisor port after replacement. The SQLite test prepares port 32123 before key approval, reopens with port 32124, and observes `Model preparation conflicts with its committed endpoint` without a second key acquisition or provider dispatch. Any product retry must start a normal new kernel attempt after truthful failure handling.

Canonical approval binding also checks the exact host-owned authority lifetime. A receipt with matching runtime/image but a different session cannot establish a native receipt, even when its projected invocation sessions agree with each other.

Verification from the host checkout:

```sh
pnpm test:userland -- --template base \
  --filter packages/agentic-do/src/native-model-provider.test.ts \
  --filter packages/agentic-do/src/native-model-transport.test.ts \
  --filter packages/agentic-do/src/native-agent-owner.test.ts \
  --filter packages/agentic-do/src/native-agent-session.test.ts \
  --filter packages/agentic-do/src/native-channel-session.test.ts
pnpm check:userland-dependencies
pnpm check:template-checkout-hygiene
```

The projected cohort passed 93 tests: provider 10, transport 26, owner 37, session 6 and channel 14. The host build and artifact contracts passed. Dependency ownership and checkout hygiene passed; all command processes joined. An earlier build caught an invalid schema import in the new host provenance verifier before running any Base tests; the owning implementation corrected it to the existing wire contract and the complete cohort then passed.

Full current Base/System-testing composition and host typechecks now pass; see the current audit. This historical component cohort alone does not establish product cutover or complete agentic acceptance.
