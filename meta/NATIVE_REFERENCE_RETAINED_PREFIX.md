# Native reference prefix persistence

An actual Source48 native-only collector was allocator-preempted after retaining
three independently passed full packets. Its CLI cancellation/cleanup join was
then killed before `runNativeReferenceTail` wrote its source-specific state.
The original cancelled packet remains pending; cancellation is not a proof.

The shared helper serves both the paid collector's explicitly model-free tail
and the separately owned native-only collector. `runNativeReferenceBatches`
controls settled-batch drains; `selectNativeReferences` and
`summarizeNativeReferences` read the same source-keyed state. Teacher exporters,
Python/Node training readers and teacher registries do not consume this state.

Before launching the canonical CLI, the owner now atomically persists the pending
batch's actual output path, selected goals and source-file hash in that existing
state. A successor validates exact repositories, placement, installed native
catalog declarations, goal identity, packet provenance, no-model evidence and
all native checks through the same `inspectNativeReference` function. Only an
independently passed packet is recovered. Missing/interrupted/error packets stay
unchecked. Changed sources and forged goals, model evidence or contexts fail
closed. No teacher row, inferred model-call zero or aggregate completion is made.

Thirteen actual Node controls passed, including simulated loss between retained
packet and outcome checkpoint, no duplicate rerun, source/provenance forgeries,
interrupted partial/error negatives, normal tail cancellation and drain behavior.
The historical three-packet Source48 recovery used its immutable existing pure
validator and source/catalog hashes; this new Host code is a future successor,
not a mutation of Source48. Physical Workerd execution of this future helper is
unchecked. Existing owned single-writer assumptions and digest checks remain;
this does not add a concurrent-owner lock protocol.
