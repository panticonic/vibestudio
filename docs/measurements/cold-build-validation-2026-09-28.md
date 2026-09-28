# Cold builds and first-use validation — 28 September 2026

The first performance pass was committed before this investigation: host
`066edfcc1`; Base `44fe7f6` and `a3f95c2`; System `75e685f` and `6733d64`;
System-testing `1f638ff`. Concurrent work was excluded, apart from the minimal
public `ensureActivated` declaration required by the committed activation fix.

## Attribution and change

Native `profileBuild` measurements on a fresh, uniquely owned managed instance
confirmed that cached emitted artifacts still incur first-use validation. The
validation worker was temporarily instrumented with bounded V8 and native compiler
CPU profiles and TypeScript's request/transfer counters. Those probes were removed
after attribution; they are not part of the product change.

Both authority folds enumerated the native compiler's files, fetched each remote
AST, and only then rejected declarations and source outside their workspace scope.
The chat check fetched 1,605 ASTs and about 65 MB of compiler responses; the shell
fetched 1,686 ASTs and about 70 MB. Most transferred nodes were never materialized
into JavaScript AST objects by the analyzer.

The folds now apply the same source-ownership predicate to compiler filenames
before retrieving ASTs. Import analysis also uses declaration handles' existing
source paths to construct reverse edges, rather than resolving an imported AST
only to reject it as out of scope. Independent symbol lookups are batched per
module. The compiler retains its complete semantic program, and external executable
module analysis, provider resolution, authority checks, and TypeScript diagnostics
remain in place. No validation bypass or additional cache was introduced.

## Measured work and latency

| First-use validation counter | Chat before | Chat final | Shell before | Shell final |
| ---------------------------- | ----------: | ---------: | -----------: | ----------: |
| Source ASTs fetched          |       1,605 |        295 |        1,686 |         248 |
| AST nodes fetched            |   1,396,174 |    535,152 |    1,415,117 |     537,975 |
| Compiler response bytes      |  65,457,805 | 25,520,745 |   70,217,535 |  27,582,616 |
| Compiler API requests        |       3,657 |      1,366 |        6,771 |       4,502 |
| AST nodes materialized by JS |      26,394 |     26,393 |      124,025 |     124,020 |

Compiler response traffic fell approximately 61% for both units. The unchanged
scale of JS-materialized nodes reflects retaining the actual semantic analysis
while avoiding unrelated transfer.

| Native build-profile boundary                    |    Before |     Final |
| ------------------------------------------------ | --------: | --------: |
| Chat first report, emitted artifact preexisting  | 20,438 ms | 13,423 ms |
| Shell first report, emitted artifact preexisting | 26,507 ms | 15,008 ms |
| Actual cold chat build plus validation           | 28,294 ms | 22,186 ms |
| Cold chat build's verified same-key repeat       |    373 ms |    239 ms |

The cold build changed only a comment in the disposable context's chat entry.
Both receipts explicitly reported `built-during-profile`; this did not delete
shared caches or alter the template checkout. Installed dependencies remained
available. The first-report samples explicitly reported `preexisting` and must
not be presented as cold compilation.

The first-use chat authority phase fell from 6,283 to 4,366 ms; shell authority
fell from 14,383 to 5,991 ms. Cold-chat authority fell from 7,263 to 5,953 ms.
The intermediate source-filter-only experiment measured 11,086/11,835 ms for
chat/shell first reports and 19,899 ms for the cold chat build. Its lower total
wall time despite doing more compiler transfer than the final version illustrates
the shared host's scheduling and memory variability.

These are individual samples with the same temporary probes, not percentiles or
controlled isolated-host speedup estimates. Unrelated workloads remained active.
Native TypeScript time also varied substantially: for example first-use chat's
compiler phase was 10,592 ms before and 7,458 ms in the final run, although this
change acts on the subsequent authority phase. Do not attribute the entire
end-to-end wall-time reduction to this change. Transfer and request reductions
are the more reliable evidence of removed work.

## Validation and remaining cost

All 46 focused authority, compiler-snapshot, and typecheck-fold tests passed.
The regression includes a real imported declaration outside the unit scope and
rejects attempts to retrieve its AST. It verifies that diagnostics still succeed
using the complete native semantic project. Existing tests cover workspace wrapper
calls, provider catalogs, external executable effects, compiler grouping, and
consumer composition.

Native CPU attribution showed substantive type-relationship, generic instantiation,
and expression-checking work still inside TypeScript. Cold dependency installation
and platform bundling also remain separate costs; the earlier Android measurements
are not represented as improved by this host authority-analysis change.

All managed instances used here were stopped through the system-test owner, their
temporary state was removed, and profiling sessions were closed. Raw profiles are
kept locally under `/tmp/vibestudio-validation-*`; this report contains aggregates
rather than source-bearing profiles.
