# Mission recovery ownership follow-up

The cleanup review found that MissionsDO uses `progress_at + 60_000` both to
recover nonterminal host runs after an activation ends and to query a receiver
whose completion delivery has failed. This is an existing polling mechanism;
the notification action does not add or extend it.

Deleting the timer alone would lose recovery. `runDrivers` only prevents duplicate
drivers within one activation. MissionsDO has no lifecycle lease or restart
override, and the generic durable-work queues own channel delivery and workspace
publication rather than mission advancement. Receiver execution has durable
ownership, but a failed terminal Finish delivery can remain parked until an
explicit lifecycle retry. The host poll currently compensates for that gap.

Replace this mechanism by giving host advancement explicit durable ownership
across activation and restart, with stable dispatch identity, owner fencing, and
joined cleanup. Wake reconciliation from authoritative activation, disconnect,
and terminal-delivery events. Receiver Finish delivery also needs recovery through
its lifecycle owner while retaining the original error and terminal receipt.
Elapsed time must not establish lost ownership or become a replacement completion
signal.

Verify storage reopen at each persisted phase, especially dispatch before the
host phase update, an executing receiver that remains queued or running, failed
Finish delivery, and terminal acknowledgment replay. These cases must neither
duplicate execution nor strand admitted, method, or completion work. Only after
that contract exists can the periodic run-status check be removed safely.

This investigation made no production changes to mission recovery and does not
claim to have repaired it.
