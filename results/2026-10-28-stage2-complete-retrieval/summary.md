# Stage 2: complete retrieval, cited claims and local calculators

Run 2026-10-28-stage2-complete-retrieval. **Tier 0: 0 cloud calls, $0 spend, 0 external requests.**

## Matched Stage 1 → Stage 2

| Cohort | Model | Full credit | Raw invalid citation items | Missing any valid citation | Missing claim citations | Parse failures | All required sources retrieved | Median local ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| saved60 | llama3.1:8b | 29/59 → 35/59 | 0/16 → 0/16 | 0/16 → 0/16 | 16/16 → 0/16 | 1 → 0 | 10/16 → 15/16 | 588.1 → 471.7 |
| saved60 | gemma3:4b | 20/59 → 31/59 | 0/16 → 0/16 | 1/16 → 0/16 | 16/16 → 0/16 | 3 → 1 | 10/16 → 15/16 | 706.2 → 580.7 |
| saved60 | gemma3:12b | 38/59 → 44/59 | 0/16 → 0/16 | 2/16 → 0/16 | 15/16 → 0/16 | 7 → 3 | 10/16 → 15/16 | 1757.5 → 1489.6 |
| plain50 | llama3.1:8b | 24/50 → 25/50 | 1/14 → 2/14 | 4/14 → 1/14 | 14/14 → 3/14 | 0 → 0 | 11/14 → 14/14 | 1281.9 → 897.2 |
| plain50 | gemma3:4b | 19/50 → 24/50 | 0/14 → 0/14 | 1/14 → 0/14 | 14/14 → 1/14 | 0 → 0 | 11/14 → 14/14 | 856.0 → 607.6 |
| plain50 | gemma3:12b | 22/50 → 28/50 | 0/14 → 0/14 | 0/14 → 0/14 | 11/14 → 1/14 | 0 → 0 | 11/14 → 14/14 | 1881.6 → 1314.1 |

Full credit uses unchanged deterministic rubric labels. Raw citation invalidity is measured before validation. Missing any citation and missing citations on individual factual claims are separate; zero invalid IDs cannot hide missing support. Baseline claim coverage is a retrospective application of the new per-claim rule; old global citation lists do not establish claim-level associations. Claim coverage is structural, not proof of semantic entailment. The saved questions, model versions, temperature and seeds stay fixed; company evidence changes by design. All calibration objects and thresholds remain unchanged.

Latency includes retrieval plus model/tool answer and self-check stages. Shared retrieval is reconstructed for each model; this is not a live end-to-end cloud timing. Report JSON also separates the answer path.

## Fixed 31-question multi-document diagnostic

Every required source: **13/31 → 30/31**. Required product-source hits: **17/37 → 37/37**. All required source occurrences: 47/78 → 77/78.

The oracle share of required files is evaluated only after retrieval using held-out source lists. Runtime completeness instead uses question/product/entity/policy requirements inferred from the local catalogue; both are reported alongside the original-query best cosine. No references or expected answers enter retrieval, calculators or generation. Context is source-diverse and bounded at 1800 locally counted tokens and 8 chunks.

## Deterministic arithmetic

| Cohort | Model | Arithmetic full credit before → after | Eligible / supported after | Complete deterministic answers | Insufficient tool evidence |
|---|---|---:|---:|---:|---:|
| saved60 | llama3.1:8b | 7/14 → 13/14 | 14 / 14 | 12 | 2 |
| saved60 | gemma3:4b | 3/14 → 13/14 | 14 / 14 | 12 | 2 |
| saved60 | gemma3:12b | 7/14 → 13/14 | 14 / 14 | 12 | 2 |
| plain50 | llama3.1:8b | 8/13 → 10/13 | 13 / 13 | 10 | 3 |
| plain50 | gemma3:4b | 5/13 → 10/13 | 13 / 13 | 10 | 3 |
| plain50 | gemma3:12b | 7/13 → 13/13 | 13 / 13 | 10 | 3 |

Eligibility is fixed from question text before inference, including unsupported and missing-evidence cases. A calculator bypasses model answer generation only when it has all necessary sourced values; its answer and cited trace cannot be rewritten by the model. Missing facts remain missing. The local self-check still runs. Calculation traces cite their input source chunks and a local calc hash; they are not cloud receipts.

## Structured cap diagnostic

Structured answers use 768 tokens; plain answers retain 384; self-checks retain 128. The separate cap-only pilot repeats the 11 prior failures with original Stage 1 schema/context, isolating the cap change from retrieval, claims and calculators. It is a selected diagnostic subset, not an unbiased accuracy estimate.

| Model | Selected prior failures at 384 | Parse failures at 768, old schema/context | Call errors |
|---|---:|---:|---:|
| llama3.1:8b | 1 | 0 | 0 |
| gemma3:4b | 3 | 1 | 0 |
| gemma3:12b | 7 | 4 | 0 |

Main-run parse counts include calculator-rendered answers; generated-answer and cap-hit denominators are explicit in report.json. Plain parse success is not proof of no truncation. Arithmetic and sources remain local, adversarial routes stay local-only, and no calibrator was trained.

**STOP before Stage 3: the 820-item dev recalibration has not run.**

## Paired uncertainty

| Cohort | Model | Paired first-grader full-credit change, 95% CI | Paired mean-score change, 95% CI | Common supported questions |
|---|---|---:|---:|---:|
| saved60 | llama3.1:8b | 10.2 pp [0.0, 21.7] | 6.2 pp [-2.9, 15.5] | 59/60 |
| saved60 | gemma3:4b | 18.6 pp [8.2, 30.2] | 12.2 pp [3.4, 21.9] | 59/60 |
| saved60 | gemma3:12b | 10.2 pp [0.0, 21.0] | 5.9 pp [0.0, 13.2] | 59/60 |
| plain50 | llama3.1:8b | 2.0 pp [-8.3, 11.5] | 1.7 pp [-6.7, 9.3] | 50/50 |
| plain50 | gemma3:4b | 10.0 pp [2.2, 18.8] | 7.2 pp [1.3, 14.1] | 50/50 |
| plain50 | gemma3:12b | 12.0 pp [2.2, 22.0] | 8.2 pp [1.7, 15.7] | 50/50 |

Intervals use the unchanged seeded 2,000-replicate source-group bootstrap on common supported answers. The independent deterministic second-grader results and their paired changes are retained separately in report.json; neither grader is expert semantic gold.

## Independent audit and remaining limits

All 130 question strings and all frozen classifier hashes/thresholds match the baseline. Source index remains 23 chunks. The 51 new company contexts select 123 chunks, with a maximum of 720 locally counted text tokens under the 1,800 cap. There were no truncated retrieval chunks, wrong explicit-product specifications, source-hash errors or reference inputs to planning. Best original-query cosine remains unchanged.

The remaining multi-document miss is `acme-058`, missing `sales/forecast.md`. Runtime inferred completeness reports 1.0 because the planner inferred only account notes. This is a real planner blind spot: the inferred score is not a guarantee that every required source is known or present. It was retained as measured, without a post-test source-selection patch.

There are 23 unique fully computed tool tasks, producing 69 answers across the three models; all 69 receive full credit under the current rubric and replay exactly from question/evidence. Thirteen saved60 and ten plain50 answers per model use the tool. Within the predeclared arithmetic subset this is twelve of fourteen and ten of thirteen; the additional saved60 tool answer is a warranty-age comparison outside that predicate. Unsupported and insufficient cases stay in the arithmetic denominator. Fallbacks include genuinely unstated installed-spare counts for AF100/AF300 and an AF200 safety-stock wording/parser limitation, not a missing policy value. No nonexistent facts were added to the corpus or tool.

All five incomplete claim-citation answers (Llama plain three, Gemma 4B plain one, Gemma 12B plain one) were gated from local acceptance. Two had passed the model self-check, demonstrating the independent code gate. Llama plain has two raw-invalid citation items versus one before; both are repaired through unambiguous local source aliases, and original errors remain counted. No invalid ID reaches validated citations or scoring.

All four main structured parse failures hit 768 tokens (Gemma 4B one, Gemma 12B three); no below-cap schema failures remain. The isolated cap pilot still has five failures, all cap hits. Plain cap hits are 7/50, 6/50 and 4/50; plain parse success does not mean complete generation. All 330 self-checks parse. Every request fits the unchanged 4,096-token context capacity.

The run records 651 local requests, zero external/generation/grading/counting cloud requests and $0 cloud spend, with no call errors or missing rows. All six adversarial cohort/model rows remain local-only. Frozen routing still accepts zero company-data answers: the eight local acceptances across cohorts are XSTest items. This stage improves retrieval and answer quality; it does not claim calibrated local-retention improvement. **Stage 3 has not started.**
