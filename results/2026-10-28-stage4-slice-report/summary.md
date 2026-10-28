# Handoff Stage 4: slice results and private-gateway demo

On the frozen 60-question comparison, Gemma 12B answered 13 of 16 company-data questions locally; all 13 accepted answers received full rubric credit. Its Wilson IID sensitivity interval is 77.2–100.0%. Llama 8B and Gemma 4B continue to abstain. The 3.66% upper error bound applies only to the fixed accepted dev frame; future traffic remains uncertified. Every cloud answer and all spending remain deferred: this report made zero cloud calls and spent $0.

**Read-only Tier 0 analysis: zero new model/cloud/token-endpoint calls; $0 spend.** Source: 2026-10-28-stage3-dev-risk-calibration, policy a1c9b90667b1f70bceaa4291e5660591c1edfec6223afdf41739828e8c2aad77. Primary population is the frozen saved60 test; controls and dev AUDIT remain separate.

## Headline metrics by slice

| Model | Slice | Accepted / all | Acceptance | Accepted full credit / accepted | Wilson 95% IID sensitivity | Escalation | Local-only | Median local ms |
|---|---|---:|---:|---:|---|---:|---:|---:|
| llama3.1:8b | Company data | 0/16 | 0.0% | 0/0 | undefined | 100.0% | 0 | 376.9 |
| llama3.1:8b | Company · single document | 0/8 | 0.0% | 0/0 | undefined | 100.0% | 0 | 283.0 |
| llama3.1:8b | Company · multiple documents | 0/8 | 0.0% | 0/0 | undefined | 100.0% | 0 | 467.3 |
| llama3.1:8b | Company · arithmetic (overlay) | 0/14 | 0.0% | 0/0 | undefined | 100.0% | 0 | 330.9 |
| llama3.1:8b | General knowledge · MMLU-Pro | 0/17 | 0.0% | 0/0 | undefined | 100.0% | 0 | 389.9 |
| llama3.1:8b | Hard questions · GPQA | 0/1 | 0.0% | 0/0 | undefined | 100.0% | 0 | 352.2 |
| llama3.1:8b | Other · instruction, privacy and safety | 0/26 | 0.0% | 0/0 | undefined | 92.3% | 2 | 584.1 |
| llama3.1:8b | Observed blended workload | 0/60 | 0.0% | 0/0 | undefined | 96.7% | 2 | 471.7 |
| gemma3:4b | Company data | 0/16 | 0.0% | 0/0 | undefined | 100.0% | 0 | 353.0 |
| gemma3:4b | Company · single document | 0/8 | 0.0% | 0/0 | undefined | 100.0% | 0 | 288.5 |
| gemma3:4b | Company · multiple documents | 0/8 | 0.0% | 0/0 | undefined | 100.0% | 0 | 415.3 |
| gemma3:4b | Company · arithmetic (overlay) | 0/14 | 0.0% | 0/0 | undefined | 100.0% | 0 | 326.2 |
| gemma3:4b | General knowledge · MMLU-Pro | 0/17 | 0.0% | 0/0 | undefined | 100.0% | 0 | 596.4 |
| gemma3:4b | Hard questions · GPQA | 0/1 | 0.0% | 0/0 | undefined | 100.0% | 0 | 396.5 |
| gemma3:4b | Other · instruction, privacy and safety | 0/26 | 0.0% | 0/0 | undefined | 92.3% | 2 | 614.9 |
| gemma3:4b | Observed blended workload | 0/60 | 0.0% | 0/0 | undefined | 96.7% | 2 | 580.7 |
| gemma3:12b | Company data | 13/16 | 81.3% | 13/13 | [77.2%, 100.0%] | 18.8% | 0 | 792.6 |
| gemma3:12b | Company · single document | 8/8 | 100.0% | 8/8 | [67.6%, 100.0%] | 0.0% | 0 | 583.0 |
| gemma3:12b | Company · multiple documents | 5/8 | 62.5% | 5/5 | [56.6%, 100.0%] | 37.5% | 0 | 947.9 |
| gemma3:12b | Company · arithmetic (overlay) | 12/14 | 85.7% | 12/12 | [75.8%, 100.0%] | 14.3% | 0 | 772.8 |
| gemma3:12b | General knowledge · MMLU-Pro | 0/17 | 0.0% | 0/0 | undefined | 100.0% | 0 | 1619.1 |
| gemma3:12b | Hard questions · GPQA | 0/1 | 0.0% | 0/0 | undefined | 100.0% | 0 | 2392.3 |
| gemma3:12b | Other · instruction, privacy and safety | 0/26 | 0.0% | 0/0 | undefined | 92.3% | 2 | 1566.0 |
| gemma3:12b | Observed blended workload | 13/60 | 21.7% | 13/13 | [77.2%, 100.0%] | 75.0% | 2 | 1489.6 |

Arithmetic is a nonadditive overlay over company single/multi-document items. MMLU-Pro includes its reasoning-tagged questions; GPQA is its exact suite, with only one primary item. General knowledge and GPQA accepted accuracy are undefined because every policy abstains. Two adversarial primary items stay local-only, so escalation plus acceptance does not equal 100% for every slice. Wilson intervals are IID sensitivity, not family-independent guarantees. Latency is the saved local pipeline including reconstructed shared retrieval and excluding unavailable Guard/cloud completion; this report performs no live timing.

## Cloud fee projections by slice and observed blend

| Model | Slice | Cloud | Fees / 1,000 | Safe all-cloud / 1,000 | Saving $ / 1,000 | Saving % | Counted input / all query |
|---|---|---|---:|---:|---:|---:|---:|
| llama3.1:8b | Company data | Gemini | $0.7330 | $0.7330 | $0.0000 | 0.0% | 243.38 |
| llama3.1:8b | Company data | Muse Spark | $2.0220 | $2.0220 | $0.0000 | 0.0% | 219.00 |
| llama3.1:8b | Company · single document | Gemini | $0.4974 | $0.4974 | $0.0000 | 0.0% | 191.25 |
| llama3.1:8b | Company · single document | Muse Spark | $1.4070 | $1.4070 | $0.0000 | 0.0% | 175.50 |
| llama3.1:8b | Company · multiple documents | Gemini | $0.9686 | $0.9686 | $0.0000 | 0.0% | 295.50 |
| llama3.1:8b | Company · multiple documents | Muse Spark | $2.6370 | $2.6370 | $0.0000 | 0.0% | 262.50 |
| llama3.1:8b | Company · arithmetic | Gemini | $0.7019 | $0.7019 | $0.0000 | 0.0% | 244.43 |
| llama3.1:8b | Company · arithmetic | Muse Spark | $1.9479 | $1.9479 | $0.0000 | 0.0% | 219.64 |
| llama3.1:8b | General knowledge · MMLU-Pro | Gemini | $0.7319 | $0.7319 | $0.0000 | 0.0% | 212.18 |
| llama3.1:8b | General knowledge · MMLU-Pro | Muse Spark | $2.0079 | $2.0079 | $0.0000 | 0.0% | 202.06 |
| llama3.1:8b | Hard questions · GPQA | Gemini | $0.9460 | $0.9460 | $0.0000 | 0.0% | 220.00 |
| llama3.1:8b | Hard questions · GPQA | Muse Spark | $2.5540 | $2.5540 | $0.0000 | 0.0% | 221.00 |
| llama3.1:8b | Other · instruction, privacy and safety | Gemini | $0.4790 | $0.4790 | $0.0000 | 0.0% | 125.00 |
| llama3.1:8b | Other · instruction, privacy and safety | Muse Spark | $1.2985 | $1.2985 | $0.0000 | 0.0% | 119.42 |
| llama3.1:8b | Observed blended workload | Gemini | $0.6262 | $0.6262 | $0.0000 | 0.0% | 182.85 |
| llama3.1:8b | Observed blended workload | Muse Spark | $1.7134 | $1.7134 | $0.0000 | 0.0% | 171.08 |
| gemma3:4b | Company data | Gemini | $0.7330 | $0.7330 | $0.0000 | 0.0% | 243.38 |
| gemma3:4b | Company data | Muse Spark | $2.0220 | $2.0220 | $0.0000 | 0.0% | 219.00 |
| gemma3:4b | Company · single document | Gemini | $0.4974 | $0.4974 | $0.0000 | 0.0% | 191.25 |
| gemma3:4b | Company · single document | Muse Spark | $1.4070 | $1.4070 | $0.0000 | 0.0% | 175.50 |
| gemma3:4b | Company · multiple documents | Gemini | $0.9686 | $0.9686 | $0.0000 | 0.0% | 295.50 |
| gemma3:4b | Company · multiple documents | Muse Spark | $2.6370 | $2.6370 | $0.0000 | 0.0% | 262.50 |
| gemma3:4b | Company · arithmetic | Gemini | $0.7019 | $0.7019 | $0.0000 | 0.0% | 244.43 |
| gemma3:4b | Company · arithmetic | Muse Spark | $1.9479 | $1.9479 | $0.0000 | 0.0% | 219.64 |
| gemma3:4b | General knowledge · MMLU-Pro | Gemini | $0.7319 | $0.7319 | $0.0000 | 0.0% | 212.18 |
| gemma3:4b | General knowledge · MMLU-Pro | Muse Spark | $2.0079 | $2.0079 | $0.0000 | 0.0% | 202.06 |
| gemma3:4b | Hard questions · GPQA | Gemini | $0.9460 | $0.9460 | $0.0000 | 0.0% | 220.00 |
| gemma3:4b | Hard questions · GPQA | Muse Spark | $2.5540 | $2.5540 | $0.0000 | 0.0% | 221.00 |
| gemma3:4b | Other · instruction, privacy and safety | Gemini | $0.4790 | $0.4790 | $0.0000 | 0.0% | 125.00 |
| gemma3:4b | Other · instruction, privacy and safety | Muse Spark | $1.2985 | $1.2985 | $0.0000 | 0.0% | 119.42 |
| gemma3:4b | Observed blended workload | Gemini | $0.6262 | $0.6262 | $0.0000 | 0.0% | 182.85 |
| gemma3:4b | Observed blended workload | Muse Spark | $1.7134 | $1.7134 | $0.0000 | 0.0% | 171.08 |
| gemma3:12b | Company data | Gemini | $0.1792 | $0.7330 | $0.5539 | 75.6% | 47.19 |
| gemma3:12b | Company data | Muse Spark | $0.4788 | $2.0220 | $1.5433 | 76.3% | 41.38 |
| gemma3:12b | Company · single document | Gemini | $0.0000 | $0.4974 | $0.4974 | 100.0% | 0.00 |
| gemma3:12b | Company · single document | Muse Spark | $0.0000 | $1.4070 | $1.4070 | 100.0% | 0.00 |
| gemma3:12b | Company · multiple documents | Gemini | $0.3583 | $0.9686 | $0.6103 | 63.0% | 94.38 |
| gemma3:12b | Company · multiple documents | Muse Spark | $0.9575 | $2.6370 | $1.6795 | 63.7% | 82.75 |
| gemma3:12b | Company · arithmetic | Gemini | $0.1389 | $0.7019 | $0.5630 | 80.2% | 43.86 |
| gemma3:12b | Company · arithmetic | Muse Spark | $0.3779 | $1.9479 | $1.5700 | 80.6% | 38.07 |
| gemma3:12b | General knowledge · MMLU-Pro | Gemini | $0.7319 | $0.7319 | $0.0000 | 0.0% | 212.18 |
| gemma3:12b | General knowledge · MMLU-Pro | Muse Spark | $2.0079 | $2.0079 | $0.0000 | 0.0% | 202.06 |
| gemma3:12b | Hard questions · GPQA | Gemini | $0.9460 | $0.9460 | $0.0000 | 0.0% | 220.00 |
| gemma3:12b | Hard questions · GPQA | Muse Spark | $2.5540 | $2.5540 | $0.0000 | 0.0% | 221.00 |
| gemma3:12b | Other · instruction, privacy and safety | Gemini | $0.4790 | $0.4790 | $0.0000 | 0.0% | 125.00 |
| gemma3:12b | Other · instruction, privacy and safety | Muse Spark | $1.2985 | $1.2985 | $0.0000 | 0.0% | 119.42 |
| gemma3:12b | Observed blended workload | Gemini | $0.4785 | $0.6262 | $0.1477 | 23.6% | 130.53 |
| gemma3:12b | Observed blended workload | Muse Spark | $1.3018 | $1.7134 | $0.4115 | 24.0% | 123.72 |

Costs include all queries in each slice, charging accepted and unsafe items zero cloud fees. The safe all-cloud comparator uses identical question/minimum-context payloads. Gemini input counts use the pinned provider-selected offline tokenizer; Muse Spark input counts use a documented Llama BPE proxy. Output lengths, reasoning lengths and prices remain assumptions, server billing/framing are unknown, and local hardware allocation is excluded. These are pre-Guard projections; cloud quality and quality per dollar are pending. Equal costs for Llama/Gemma 4B reflect identical no-draft potential payloads and zero accepted safe items, not pooled model answers.

## What if company data is 25%, 50% or 75%?

| Local model | Company share | Cloud | Fees / 1,000 | Safe all-cloud / 1,000 | Saving $ | Saving % |
|---|---:|---|---:|---:|---:|---:|
| llama3.1:8b | 25.0% | Gemini | $0.6238 | $0.6238 | $0.0000 | 0.0% |
| llama3.1:8b | 50.0% | Gemini | $0.6602 | $0.6602 | $0.0000 | 0.0% |
| llama3.1:8b | 75.0% | Gemini | $0.6966 | $0.6966 | $0.0000 | 0.0% |
| llama3.1:8b | 25.0% | Muse Spark | $1.7064 | $1.7064 | $0.0000 | 0.0% |
| llama3.1:8b | 50.0% | Muse Spark | $1.8116 | $1.8116 | $0.0000 | 0.0% |
| llama3.1:8b | 75.0% | Muse Spark | $1.9168 | $1.9168 | $0.0000 | 0.0% |
| gemma3:4b | 25.0% | Gemini | $0.6238 | $0.6238 | $0.0000 | 0.0% |
| gemma3:4b | 50.0% | Gemini | $0.6602 | $0.6602 | $0.0000 | 0.0% |
| gemma3:4b | 75.0% | Gemini | $0.6966 | $0.6966 | $0.0000 | 0.0% |
| gemma3:4b | 25.0% | Muse Spark | $1.7064 | $1.7064 | $0.0000 | 0.0% |
| gemma3:4b | 50.0% | Muse Spark | $1.8116 | $1.8116 | $0.0000 | 0.0% |
| gemma3:4b | 75.0% | Muse Spark | $1.9168 | $1.9168 | $0.0000 | 0.0% |
| gemma3:12b | 25.0% | Gemini | $0.4853 | $0.6238 | $0.1385 | 22.2% |
| gemma3:12b | 50.0% | Gemini | $0.3832 | $0.6602 | $0.2769 | 41.9% |
| gemma3:12b | 75.0% | Gemini | $0.2812 | $0.6966 | $0.4154 | 59.6% |
| gemma3:12b | 25.0% | Muse Spark | $1.3205 | $1.7064 | $0.3858 | 22.6% |
| gemma3:12b | 50.0% | Muse Spark | $1.0399 | $1.8116 | $0.7716 | 42.6% |
| gemma3:12b | 75.0% | Muse Spark | $0.7593 | $1.9168 | $1.1574 | 60.4% |

Company share varies; the observed saved60 composition within company and within noncompany stays fixed. The noncompany remainder includes MMLU-Pro, one GPQA item, instructions, privacy and safety; unsafe items have zero cloud fees in both plans. Models and populations are never pooled.

## Deployment recommendation and certification

Recommend **Gemma 3 12B for company data** as the company-data demo candidate, applying the locked 0.03753559 threshold and all existing gates; escalate other safe questions after Guard and redaction. Harmful, red-team and poisoning items remain local-only. This recommendation does not activate a production model or retune thresholds from test results.

The simultaneous fixed-dev-frame upper error bound is **3.7%** (3/82), with 63 accepted CALIB answers sampled from that frame. The separate AUDIT-only bound is **15.8%**. This certificate covers accepted CALIB+AUDIT dev items only, not future traffic, unseen source families, test population risk, cloud quality or universal PII removal.

## Privacy: proposed boundary traffic versus actual delivery

| Local model | Business-data queries | Company documents / ad exports | Accepted fully local business answers | Proposed pre-Guard business handoffs | Actual business cloud calls | Proposed payloads with minimum context | Draft payloads |
|---|---:|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | 24 | 16 / 8 | 0 | 24 | 0 | 16 | 0 |
| gemma3:4b | 24 | 16 / 8 | 0 | 24 | 0 | 16 | 0 |
| gemma3:12b | 24 | 16 / 8 | 13 | 11 | 0 | 3 | 0 |

All company queries physically remained local because the source run was offline. Accepted fully local answers and deferred handoff candidates are distinguished above. Actual company queries reaching a cloud after Guard/redaction: **0**. New outbound/inbound Guard screens and post-Guard eligibility are **pending**, because no Guard calls were performed by the source replay. Proposed snapshots pass saved-wire hashes, strict wire allowlists, no-draft and recognized-private-pattern checks. “Question-only” means the redacted question plus minimum redacted evidence when needed, never a local draft or local control/proof/PII-map metadata. It does not mean that every potential payload is context-free. No post-Guard delivery or universal redaction guarantee is claimed.

## Separate controls and held-out dev audit

| Population | Model | Slice | Accepted / all | Full credit / accepted | Wilson 95% IID sensitivity | Median local ms |
|---|---|---|---:|---:|---|---:|
| frozen-plain50 | llama3.1:8b | Company data | 0/14 | 0/0 | undefined | 426.1 |
| frozen-plain50 | llama3.1:8b | General knowledge · MMLU-Pro | 0/28 | 0/0 | undefined | 984.9 |
| frozen-plain50 | llama3.1:8b | Hard questions · GPQA | 0/1 | 0/0 | undefined | 1145.3 |
| frozen-plain50 | llama3.1:8b | Other · instruction, privacy and safety | 0/7 | 0/0 | undefined | 434.9 |
| frozen-plain50 | llama3.1:8b | Observed blended workload | 0/50 | 0/0 | undefined | 897.2 |
| frozen-plain50 | gemma3:4b | Company data | 0/14 | 0/0 | undefined | 398.4 |
| frozen-plain50 | gemma3:4b | General knowledge · MMLU-Pro | 0/28 | 0/0 | undefined | 737.2 |
| frozen-plain50 | gemma3:4b | Hard questions · GPQA | 0/1 | 0/0 | undefined | 842.0 |
| frozen-plain50 | gemma3:4b | Other · instruction, privacy and safety | 0/7 | 0/0 | undefined | 492.9 |
| frozen-plain50 | gemma3:4b | Observed blended workload | 0/50 | 0/0 | undefined | 607.6 |
| frozen-plain50 | gemma3:12b | Company data | 10/14 | 10/10 | [72.2%, 100.0%] | 867.9 |
| frozen-plain50 | gemma3:12b | General knowledge · MMLU-Pro | 0/28 | 0/0 | undefined | 1523.4 |
| frozen-plain50 | gemma3:12b | Hard questions · GPQA | 0/1 | 0/0 | undefined | 2455.0 |
| frozen-plain50 | gemma3:12b | Other · instruction, privacy and safety | 0/7 | 0/0 | undefined | 1040.3 |
| frozen-plain50 | gemma3:12b | Observed blended workload | 10/50 | 10/10 | [72.2%, 100.0%] | 1314.1 |
| dev-audit | llama3.1:8b | Company data | 0/20 | 0/0 | undefined | 438.4 |
| dev-audit | llama3.1:8b | General knowledge · MMLU-Pro | 0/47 | 0/0 | undefined | 454.3 |
| dev-audit | llama3.1:8b | Hard questions · GPQA | 0/1 | 0/0 | undefined | 481.6 |
| dev-audit | llama3.1:8b | Other · instruction, privacy and safety | 0/15 | 0/0 | undefined | 587.4 |
| dev-audit | llama3.1:8b | Observed blended workload | 0/83 | 0/0 | undefined | 480.7 |
| dev-audit | gemma3:4b | Company data | 0/20 | 0/0 | undefined | 374.1 |
| dev-audit | gemma3:4b | General knowledge · MMLU-Pro | 0/47 | 0/0 | undefined | 549.3 |
| dev-audit | gemma3:4b | Hard questions · GPQA | 0/1 | 0/0 | undefined | 1671.8 |
| dev-audit | gemma3:4b | Other · instruction, privacy and safety | 0/15 | 0/0 | undefined | 633.6 |
| dev-audit | gemma3:4b | Observed blended workload | 0/83 | 0/0 | undefined | 513.2 |
| dev-audit | gemma3:12b | Company data | 19/20 | 19/19 | [83.2%, 100.0%] | 754.6 |
| dev-audit | gemma3:12b | General knowledge · MMLU-Pro | 0/47 | 0/0 | undefined | 1674.9 |
| dev-audit | gemma3:12b | Hard questions · GPQA | 0/1 | 0/0 | undefined | 1899.9 |
| dev-audit | gemma3:12b | Other · instruction, privacy and safety | 0/15 | 0/0 | undefined | 1365.0 |
| dev-audit | gemma3:12b | Observed blended workload | 19/83 | 19/19 | [83.2%, 100.0%] | 1365.0 |

No rows are pooled across these populations. Their per-slice costs and privacy counts remain in report.json.

**STOP: no new benchmark or paid tier was started.**
