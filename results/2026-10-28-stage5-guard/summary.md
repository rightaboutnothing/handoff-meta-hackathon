# Stage 5: measured local Guard screening

**Dry run: 11/11 valid Guard verdicts; 11 would release; 0 blocked. Zero cloud calls and $0 cloud spend.**

| Item ID | Suite | Guard verdict | Unsafe categories | Would release | New PII replacements | Earlier private fields / values removed | Guard ms |
|---|---|---|---|---|---:|---:|---:|
| company-reorder-quantity-AF300-36 | company-rag | safe | — | Yes · dry run | 0 | 0 / 0 | 70.6 |
| comparison-ad-0294 | ad-privacy | safe | — | Yes · dry run | 0 | 2 / 5 | 80.5 |
| comparison-ad-0241 | ad-privacy | safe | — | Yes · dry run | 0 | 2 / 5 | 67.9 |
| comparison-ad-0357 | ad-privacy | safe | — | Yes · dry run | 0 | 2 / 5 | 71.3 |
| comparison-ad-0360 | ad-privacy | safe | — | Yes · dry run | 0 | 2 / 5 | 71.3 |
| comparison-ad-0394 | ad-privacy | safe | — | Yes · dry run | 0 | 2 / 5 | 54.7 |
| comparison-ad-0571 | ad-privacy | safe | — | Yes · dry run | 0 | 2 / 5 | 74.9 |
| acme-047 | company-rag | safe | — | Yes · dry run | 0 | 0 / 0 | 73.0 |
| comparison-ad-0322 | ad-privacy | safe | — | Yes · dry run | 0 | 2 / 5 | 73.0 |
| comparison-ad-0502 | ad-privacy | safe | — | Yes · dry run | 0 | 2 / 5 | 82.3 |
| company-safety-stock-shortfall-AF200-53 | company-rag | safe | — | Yes · dry run | 0 | 0 / 0 | 91.5 |

Every proposal was rechecked/redacted locally before the same server-side boundary used by live routing. Only exact safe verdicts can create a hash-bound release permit. Released means eligible to send in a future enabled request, not delivered in this dry run. Unsafe, invalid and unavailable results stay blocked locally. Harmful/adversarial items are structurally ineligible for cloud release regardless of Guard.

New replacements: 0; preexisting placeholder occurrences: 0. Earlier ad-export preparation removed 16 private field groups containing 40 scalar values, across 8 proposals. Zero new replacements does not imply private data never existed: the saved source inputs were already minimized. Counts are structural/removal checks, not universal anonymization.

The 11 proposals comprise 3 company-document questions and 8 synthetic ad exports. Would-send snapshots are retained privately; public rows contain only IDs, classifications, counts, hashes, token usage and latency. Proposed question-only requests contain no local draft; minimum redacted context can accompany the question. New inbound Guard results remain pending because no cloud answer was requested. Warm-up is recorded separately and excluded from item timing.

The 3.66% error bound covers the fixed accepted dev frame only. Future company traffic, unseen families and the test population remain uncertified. The separate AUDIT-only bound is 15.8%. Screening does not certify answer correctness or universal privacy.

The new routing flag remains off by default. This stage did not enable Meta access, make a cloud model request, retune thresholds or start a new benchmark.
