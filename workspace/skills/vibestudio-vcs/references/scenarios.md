# Scenarios

## Child work with an undo chain

The child edits one file through several intermediate values and changes an independent file. Compare reports at most one row per stable coordinate, while attribution names every touch, including undone intermediates. One default merge call adopts the clean page. Review `intents` and `composed`, compare again for `complete && concluded`, then commit. Never replay the intermediate values.

## Same-file conflict with stated intent

Both parent and child author the same file with meaningful `intent`. Compare reports a content conflict with both attribution chains and both `stated` intent values. The parent uses `edit` with intent to author the truthful combination, then calls merge with a `current` resolution and rationale. The resolution creates a decision link without an unchanged file transition.

## Net-zero child

The child changes a coordinate and returns it to the base value before commit. Compare has no material coordinate to adopt but is not concluded. Call merge once with no coordinates. The decision-only application concludes the source; the next commit includes it as a parent and its entire story remains ancestry-reachable.

## External delta

Register the exact old-to-new delta and compare using the returned delta identity. The declared description is the external work unit's `stated` intent. Merge and resolve through the same coordinate surface as an event. Finalize only after resolution is complete and concluded.

## Non-overlapping text edits

Parent changes the header and child changes the footer. Compare requests exact content, runs deterministic three-way composition, and reports `composed`. Merge authors the composed bytes with mapped `incorporates` edges to both parent applied changes. Review the two intents before committing.

## Structural group

The source creates a repository and places a file in it. Compare gives the repository and file one group. Select both or let the default page choose them. Selecting only the file returns `CoupledGroupIncomplete`; it is never repaired by ordering two partial calls.
