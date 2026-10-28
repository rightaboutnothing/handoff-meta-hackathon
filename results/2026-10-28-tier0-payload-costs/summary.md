# Corrected Tier 0 payload cost and grading audit

Run 2026-10-28-tier0-payload-costs; cloud inference calls **0**, remote counting calls **0**, actual cloud spend **$0**. STOP before Tier 1.

## Cloud fees over the complete query population

These are item-level projections from retained exact lean payloads, not routed-share multipliers. All 60 source items remain in every population; local/blocked/adversarial cloud fees are zero. Category/eligibility weights match the original 1,000-item core. The headline saving is the all-query cloud-fee comparison. Local hardware allocation is secondary and excluded from that headline.

| Pipeline | Variant | Input / total tokens per all query | Input / total tokens per handoff | USD / 1,000 all queries | Matched all-cloud | Saving | USD / 1,000 handoffs | Matched cloud-only handoffs | Quality / $ |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| llama8b+llamaguard+musespark | question-only | 195.43 / 448.15 | 210.74 / 483.27 | $1.9072 | $1.9873 | 4.0% | $2.0566 | $2.0566 | pending Tier 1 |
| llama8b+llamaguard+gemini | question-only | 211.07 / 463.79 | 227.61 / 500.14 | $0.6951 | $0.7232 | 3.9% | $0.7496 | $0.7496 | pending Tier 1 |
| llama8b+shieldgemma+musespark | question-only | 203.56 / 461.60 | 213.15 / 483.35 | $1.9553 | $1.9873 | 1.6% | $2.0475 | $2.0475 | pending Tier 1 |
| llama8b+shieldgemma+gemini | question-only | 219.29 / 477.32 | 229.62 / 499.81 | $0.7109 | $0.7232 | 1.7% | $0.7444 | $0.7444 | pending Tier 1 |
| gemma4b+llamaguard+musespark | question-only | 197.22 / 454.67 | 204.51 / 471.49 | $1.9392 | $1.9873 | 2.4% | $2.0109 | $2.0109 | pending Tier 1 |
| gemma4b+llamaguard+gemini | question-only | 212.76 / 470.21 | 220.63 / 487.61 | $0.7075 | $0.7232 | 2.2% | $0.7336 | $0.7336 | pending Tier 1 |
| gemma4b+shieldgemma+musespark | question-only | 205.07 / 467.16 | 207.83 / 473.45 | $1.9827 | $1.9873 | 0.2% | $2.0094 | $2.0094 | pending Tier 1 |
| gemma4b+shieldgemma+gemini | question-only | 220.71 / 482.80 | 223.68 / 489.30 | $0.7214 | $0.7232 | 0.2% | $0.7312 | $0.7312 | pending Tier 1 |
| gemma12b+llamaguard+musespark | question-only | 197.22 / 454.67 | 204.51 / 471.49 | $1.9392 | $1.9873 | 2.4% | $2.0109 | $2.0109 | pending Tier 1 |
| gemma12b+llamaguard+gemini | question-only | 212.76 / 470.21 | 220.63 / 487.61 | $0.7075 | $0.7232 | 2.2% | $0.7336 | $0.7336 | pending Tier 1 |
| gemma12b+shieldgemma+musespark | question-only | 205.07 / 467.16 | 207.83 / 473.45 | $1.9827 | $1.9873 | 0.2% | $2.0094 | $2.0094 | pending Tier 1 |
| gemma12b+shieldgemma+gemini | question-only | 220.71 / 482.80 | 223.68 / 489.30 | $0.7214 | $0.7232 | 0.2% | $0.7312 | $0.7312 | pending Tier 1 |
| llama8b+local-only | question-only | 0.00 / 0.00 | n/a / n/a | $0.0000 | $1.9873 | 100.0% | n/a | n/a | pending Tier 1 |
| gemma4b+local-only | question-only | 0.00 / 0.00 | n/a / n/a | $0.0000 | $1.9873 | 100.0% | n/a | n/a | pending Tier 1 |
| gemma12b+local-only | question-only | 0.00 / 0.00 | n/a / n/a | $0.0000 | $1.9873 | 100.0% | n/a | n/a | pending Tier 1 |
| cloud-only+musespark | question-only | 205.35 / 468.12 | 207.01 / 471.89 | $1.9873 | $1.9873 | 0.0% | $2.0033 | $2.0033 | pending Tier 1 |
| cloud-only+gemini | question-only | 220.98 / 483.74 | 222.76 / 487.65 | $0.7232 | $0.7232 | 0.0% | $0.7290 | $0.7290 | pending Tier 1 |
| llama8b+guard-off+musespark | question-only | 203.56 / 461.60 | 213.15 / 483.35 | $1.9553 | $1.9873 | 1.6% | $2.0475 | $2.0475 | pending Tier 1 |
| llama8b+guard-off+gemini | question-only | 219.29 / 477.32 | 229.62 / 499.81 | $0.7109 | $0.7232 | 1.7% | $0.7444 | $0.7444 | pending Tier 1 |
| gemma4b+guard-off+musespark | question-only | 205.35 / 468.12 | 207.01 / 471.89 | $1.9873 | $1.9873 | 0.0% | $2.0033 | $2.0033 | pending Tier 1 |
| gemma4b+guard-off+gemini | question-only | 220.98 / 483.74 | 222.76 / 487.65 | $0.7232 | $0.7232 | 0.0% | $0.7290 | $0.7290 | pending Tier 1 |
| gemma12b+guard-off+musespark | question-only | 205.35 / 468.12 | 207.01 / 471.89 | $1.9873 | $1.9873 | 0.0% | $2.0033 | $2.0033 | pending Tier 1 |
| gemma12b+guard-off+gemini | question-only | 220.98 / 483.74 | 222.76 / 487.65 | $0.7232 | $0.7232 | 0.0% | $0.7290 | $0.7290 | pending Tier 1 |
| llama8b+llamaguard+musespark | with-draft | 212.03 / 464.75 | 228.65 / 501.17 | $1.9404 | $1.9873 | 2.4% | $2.0924 | $2.0566 | pending Tier 1 |
| llama8b+llamaguard+gemini | with-draft | 230.98 / 483.70 | 249.08 / 521.60 | $0.7011 | $0.7232 | 3.1% | $0.7560 | $0.7496 | pending Tier 1 |
| llama8b+shieldgemma+musespark | with-draft | 220.33 / 478.36 | 230.71 / 500.90 | $1.9889 | $1.9873 | -0.1% | $2.0826 | $2.0475 | pending Tier 1 |
| llama8b+shieldgemma+gemini | with-draft | 239.42 / 497.45 | 250.70 / 520.89 | $0.7169 | $0.7232 | 0.9% | $0.7507 | $0.7444 | pending Tier 1 |
| gemma4b+llamaguard+musespark | with-draft | 228.72 / 486.17 | 237.18 / 504.15 | $2.0022 | $1.9873 | -0.7% | $2.0762 | $2.0109 | pending Tier 1 |
| gemma4b+llamaguard+gemini | with-draft | 249.52 / 506.98 | 258.75 / 525.73 | $0.7185 | $0.7232 | 0.7% | $0.7451 | $0.7336 | pending Tier 1 |
| gemma4b+shieldgemma+musespark | with-draft | 236.42 / 498.51 | 239.60 / 505.22 | $2.0454 | $1.9873 | -2.9% | $2.0729 | $2.0094 | pending Tier 1 |
| gemma4b+shieldgemma+gemini | with-draft | 257.37 / 519.46 | 260.83 / 526.45 | $0.7324 | $0.7232 | -1.3% | $0.7423 | $0.7312 | pending Tier 1 |
| gemma12b+llamaguard+musespark | with-draft | 228.62 / 486.07 | 237.07 / 504.05 | $2.0020 | $1.9873 | -0.7% | $2.0760 | $2.0109 | pending Tier 1 |
| gemma12b+llamaguard+gemini | with-draft | 250.12 / 507.58 | 259.37 / 526.35 | $0.7187 | $0.7232 | 0.6% | $0.7453 | $0.7336 | pending Tier 1 |
| gemma12b+shieldgemma+musespark | with-draft | 236.31 / 498.40 | 239.49 / 505.11 | $2.0452 | $1.9873 | -2.9% | $2.0727 | $2.0094 | pending Tier 1 |
| gemma12b+shieldgemma+gemini | with-draft | 257.92 / 520.02 | 261.40 / 527.02 | $0.7326 | $0.7232 | -1.3% | $0.7425 | $0.7312 | pending Tier 1 |
| llama8b+local-only | with-draft | 0.00 / 0.00 | n/a / n/a | $0.0000 | $1.9873 | 100.0% | n/a | n/a | pending Tier 1 |
| gemma4b+local-only | with-draft | 0.00 / 0.00 | n/a / n/a | $0.0000 | $1.9873 | 100.0% | n/a | n/a | pending Tier 1 |
| gemma12b+local-only | with-draft | 0.00 / 0.00 | n/a / n/a | $0.0000 | $1.9873 | 100.0% | n/a | n/a | pending Tier 1 |
| cloud-only+musespark | with-draft | 205.35 / 468.12 | 207.01 / 471.89 | $1.9873 | $1.9873 | 0.0% | $2.0033 | $2.0033 | pending Tier 1 |
| cloud-only+gemini | with-draft | 220.98 / 483.74 | 222.76 / 487.65 | $0.7232 | $0.7232 | 0.0% | $0.7290 | $0.7290 | pending Tier 1 |
| llama8b+guard-off+musespark | with-draft | 220.33 / 478.36 | 230.71 / 500.90 | $1.9889 | $1.9873 | -0.1% | $2.0826 | $2.0475 | pending Tier 1 |
| llama8b+guard-off+gemini | with-draft | 239.42 / 497.45 | 250.70 / 520.89 | $0.7169 | $0.7232 | 0.9% | $0.7507 | $0.7444 | pending Tier 1 |
| gemma4b+guard-off+musespark | with-draft | 237.02 / 499.78 | 238.93 / 503.82 | $2.0506 | $1.9873 | -3.2% | $2.0672 | $2.0033 | pending Tier 1 |
| gemma4b+guard-off+gemini | with-draft | 257.96 / 520.73 | 260.04 / 524.93 | $0.7343 | $0.7232 | -1.5% | $0.7402 | $0.7290 | pending Tier 1 |
| gemma12b+guard-off+musespark | with-draft | 237.05 / 499.82 | 238.97 / 503.85 | $2.0507 | $1.9873 | -3.2% | $2.0673 | $2.0033 | pending Tier 1 |
| gemma12b+guard-off+gemini | with-draft | 258.67 / 521.44 | 260.76 / 525.64 | $0.7345 | $0.7232 | -1.6% | $0.7404 | $0.7290 | pending Tier 1 |

Total tokens combine counted input with assumed visible answer and reasoning tokens; they are projections, not observed cloud output. Both cost denominators are weighted by category and eligibility to the fixed 1,000-item core. Sample handoff counts/rates elsewhere are unweighted diagnostics.

## Why the earlier Gemini headline was higher

The old Finkd/Gemini figure $1.3759 included $0.2000 local allocation. Its cloud fees were $1.1759, below the $1.2549 cloud-only reference by $0.0789. Guard wrappers, receipts and local drafts contributed zero cloud tokens. The apparent $0.1211 premium was accounting scope, not metadata overhead.

The exact legacy-input source recount and its matched cloud-only breakdown are in report.json. Both draft variants keep all receipts, Guard verdicts, file paths and PII maps local. Context is relevance-trimmed, deduplicated, top-2, within 768 tokens under the stricter of both local counters; optional redacted draft is capped at 192.

## Tokenizers and forecast assumptions

Gemini: Google SDK-selected local google/gemma-4-E4B-it@ee0ef6023621cff504d758262d4e04895a5af4a2. Muse Spark: installed Llama 3.1 BPE **proxy**, not the unavailable Muse Spark tokenizer. Asset/model hashes and the pinned Google SDK mapping are recorded. Text counts are exact for these artifacts; hidden service framing and actual billed input remain **unknown**. Headline projections assume 0 additional framing tokens and zero cache discount; per-type answer/reasoning lengths are assumptions bounded by the shared output cap. No provider API or cache-creation call was made.

Gemma 4B and Gemma 12B are computed separately. Question-only figures can match because their frozen route masks and payload bytes match under the same Guard; a common cloud tokenizer and per-type output assumption then produce equal cloud fees. The with-draft variant includes each model’s actual redacted draft, so equality is checked per item rather than imposed. See gemmaComparison in report.json.

## Blind second grading method

| Cohort | Model | Supported labels, grader 1 / 2; paired | Original mean score (95% CI) | Independent mean score (95% CI) | Exact score agreement (95% CI) |
|---|---|---:|---:|---:|---:|
| Random 200 | llama3.1:8b | 197 / 197; 197 of 200 | 32.9% [26.8%, 40.4%] | 33.1% [27.2%, 40.4%] | 99.5% [98.4%, 100.0%] |
| Random 200 | gemma3:12b | 197 / 197; 197 of 200 | 51.3% [42.1%, 60.0%] | 52.8% [43.9%, 61.2%] | 97.5% [93.9%, 100.0%] |
| Original 60 | llama3.1:8b | 59 / 59; 59 of 60 | 36.0% [24.2%, 49.5%] | 36.0% [24.2%, 49.5%] | 100.0% [100.0%, 100.0%] |
| Original 60 | gemma3:12b | 59 / 59; 59 of 60 | 68.7% [56.7%, 79.5%] | 67.0% [54.8%, 78.3%] | 94.9% [88.9%, 100.0%] |

Scores above use common labels between graders within a model. Cross-model gap estimates below use the stricter common-label intersection across both models: 196/200 random questions and 59/60 original questions. Unsupported outcomes remain pending; they are not counted as failures.

Random 200: Gemma 12B minus Llama 8B gap, original grader 18.5% [7.7%, 27.9%], second grader 19.8% [9.6%, 28.9%].

Original 60: Gemma 12B minus Llama 8B gap, original grader 32.7% [15.9%, 48.3%], second grader 31.0% [14.3%, 46.7%].

### Predeclared 50-item prompt-format control

| Model | Original JSON prompt (95% CI) | Plain-answer prompt (95% CI) | Paired change (95% CI) |
|---|---:|---:|---:|
| llama3.1:8b | 29.7% [18.3%, 42.4%] | 51.0% [34.4%, 65.4%] | 21.3% [4.3%, 37.2%] |
| gemma3:12b | 49.7% [34.8%, 63.9%] | 51.7% [37.4%, 65.7%] | 2.0% [-4.3%, 9.4%] |

Gemma 12B minus Llama 8B gap: JSON 20.0% [2.3%, 36.0%]; plain 0.7% [-15.3%, 17.4%]; paired gap change -19.3% [-36.6%, -1.0%].

All point estimates, 95% paired/source-group bootstrap intervals, model-gap changes, per-category agreement and format-disagreement IDs are in report.json. The second grader is independently implemented and format-tolerant, not a human semantic gold standard. The random 200 held-out items and original reported 60 are separate cohorts. The predeclared 50-item plain-answer prompt ablation is reported separately; neither experiment retunes routing thresholds. Raw answers and GPQA question text stay in ignored local files.

Cloud quality per dollar is **pending Tier 1**.

## Input-token source reconciliation

Recounted historical Gemini request content, category/eligibility weighted per **all query**, including zero on local/blocked items. These native-tokenizer content counts explain the saved text; the historical dollar bridge retains its historical character/output assumptions. There was no receipt/Guard/draft token premium.

| Source | Historical routed payloads | Historical cloud-only |
|---|---:|---:|
| instructions | 109.93 | 117.49 |
| query | 137.87 | 145.63 |
| retrievedContext | 166.88 | 167.40 |
| localDraft | 0.00 | 0.00 |
| guardWrapper | 0.00 | 0.00 |
| receiptMetadata | 0.00 | 0.00 |
| piiMap | 0.00 | 0.00 |
| Total | 414.67 | 430.53 |

## Output-length assumptions by item type

| Item type | Visible answer tokens | Reasoning tokens |
|---|---:|---:|
| reasoning | 224 | 128 |
| knowledge | 128 | 64 |
| instruction-following | 192 | 48 |
| safety-boundary | 96 | 32 |
| privacy | 128 | 64 |
| company-data single-doc | 128 | 48 |
| company-data multi-doc | 224 | 128 |

## Interpretation and verification

The original-prompt random-200 comparison retains a Gemma 12B advantage under the second grader: +19.8 percentage points (95% CI 9.6 to 28.9) on 196 commonly supported pairs. On the original slice it is +31.0 points (14.3 to 46.7). Grading extraction alone therefore does not explain the entire original gap.

Prompt format does materially change the result: on the predeclared 50-question control, the second-graded scores change from 29.7% to 51.0% for Llama 8B and from 49.7% to 51.7% for Gemma 12B. The Gemma-minus-Llama gap shrinks from 20.0 to 0.7 points (plain-answer gap 95% CI -15.3 to 17.4; paired gap change -19.3 points, CI -36.6 to -1.0). The earlier 68.7% versus 36.0% must not be treated as a format-independent capability ranking. The plain prompt also frees output budget otherwise used for JSON metadata. Fifty questions and automated phrase/number graders cannot prove semantic equivalence or the absence of bias.

Costs are conditional on frozen original routing and Guard outcomes; optional drafts have not been re-screened to measure changed Guard decisions, handoff rates or cloud quality. The same lean baseline is used for each cloud, so handoff-only question-only fees equal the matched cloud-only subset; all-query savings come from genuinely skipped cloud requests. Drafts add input cost, with quality benefit pending.

Verified: 2,760 per-pipeline/item/variant token records; 211 unique lean payloads; 422/422 local counterfactual receipt signatures and payload hashes valid; zero chain breaks; 92 adversarial/ineligible row variants have zero payload tokens and no handoff. Network record: 546 local requests, **0 external requests**; cloud inference/counting requests **0**, actual spend **$0**. Receipts prove retained local counterfactual content, not remote delivery.
