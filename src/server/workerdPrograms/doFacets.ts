/**
 * The facet names of a userland object's cell, shared by the UniversalDO program
 * and the host's fork operation (a fork at a commit names the Dolt facet).
 */

/** The object's cell: the one facet that holds its state, whatever its engine. */
export const DO_FACET = "do";
/** Where a legacy SQLite facet's state is staged while the Dolt facet is rebuilt (§9.2); never a lasting name. */
export const DO_STAGING_FACET = "do-staging";
