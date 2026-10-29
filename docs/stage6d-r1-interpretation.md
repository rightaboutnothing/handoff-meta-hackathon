# Stage 6d first measurement: preserve the failures

The complete first Stage 6d run is preserved without modification at `results/2026-10-29-stage6d-question-boundary`. Measurement commit: **ba6f169c85053b7e5f869cae4de38b0cd486a67a**. Source fingerprint: `440a4ef2c0a57d1664de7543f67c586d7158796ab89078c9d62bf84bcfd2c3ef`. Report SHA-256: `62d476efab2f7e55ab5669ba0f642349a13e1b271e6291305113eca44c95f708`. Seed: **20261027**. Zero cloud calls, zero external attempts and $0 cloud spend; dispatch remained disabled.

| Setup | Frozen / country survivors | Frozen / country usable | Safe blocked | Final unresolved pipeline operations | Completed applications / 11 | Applied full-credit answers |
|---|---|---|---:|---:|---:|---:|
| Meta lens | 0/50 / 0/60 | 50/50 / 60/60 | 14/74 | 3 | 1 | 0 |
| Google lens | 0/50 / 0/60 | 50/50 / 60/60 | 12/74 | 2 | 1 | 0 |
| Google native-only | 0/50 / 0/60 | 50/50 / 60/60 | 12/74 | 2 | 1 | 0 |
| Presidio, PII-only control | 50/50 / 60/60 | Redacted source text | N/A | 0 | N/A | N/A |

**No row passes Stage 7.** Full Wilson intervals, per-item attribution and all eleven application scores are in the unchanged measured report. A valid source excerpt is not automatically a relevant or complete answer, as the single completed case's zero rubric score demonstrates.

The country regression is fixed: Google's sixty repeated conditional questions are usable again. This was an integration defect, not evidence of sixty independent Google model failures. Planted-value survivors remain zero in both full lenses, but these synthetic samples do not establish zero leakage in future traffic.

The remaining Meta false blocks are thirteen final intent-validation blocks and one additional harmful-content Guard block. Five Prompt Guard flags overlap already blocked questions; they are not five additional operational failures. The thirteen intent cases include eight missing calculation obligations, three missing writing obligations, one grouping constraint and one specificity/topic failure. Some aliases are too narrow, but actual calculation, writing and grouping obligations must not be waived merely to improve the number. The natural-language fallback sometimes treats multiple record sentences and the actual request as one task; source extraction and a source-derived intent contract require repair.

Initial capitalization-based extraction also registered ordinary grammatical/instruction words from the unextracted record/task as private entities. Their later occurrence in general guidance caused seven `OUTPUT_KNOWN_PRIVATE_VALUE` application blocks per lens. This is a provenance/registration defect: fix non-entity registration rather than exempt an actual detected private name or weaken the known-value check. The audit uses hashes and fixed classifications, without publishing the underlying values.

Meta retained **62 failed protocol attempts**, of which **50 recovered**, leaving three unresolved operations: two rewrite-format failures and one inbound literal-span failure. Google retained **42 failed operational observations**, 37 recovered, leaving two unresolved operations. A separate transport journal records four failed attempts for one Google local operation; its HTTP status and backend-specific cause are unknown because the available server logs predate the active server. Operational observations, unique calls, reused observations and transport attempts are distinct denominators. The old two Google rewrite-cap failures must not be confused with the new transport incident or authored development failures.

Prompt Guard remains **86M primary at 0.5**, with 22M comparison-only; neither threshold was tuned. The injection-labelled standalone weakness remains **5/50** for 86M. A corrected second run must preserve this first measurement, use a new source identity and fresh inference caches, and keep the same privacy rules and release criteria. Reusing this known frame for implementation repairs is not an unseen validation study.
