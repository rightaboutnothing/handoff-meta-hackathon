# Handoff comparison — Tier 0

Run: 2026-10-28-meta-google-tier0. Status: TIER0_COMPLETE. Cloud calls: 0.

**Cost planning only. STOP before Tier 1. All cloud quality and live end-to-end latency remain pending.**

| Pipeline | Planned handoffs / sample | Input tokens (plan) | USD / 1,000 (assumed) | All-cloud USD / 1,000 |
|---|---:|---:|---:|---:|
| llama8b+llamaguard+musespark | 50/60 | 22443 | $3.5291 | $3.5406 |
| llama8b+llamaguard+gemini | 50/60 | 22443 | $1.3759 | $1.2549 |
| llama8b+shieldgemma+musespark | 51/60 | 22854 | $3.6276 | $3.5406 |
| llama8b+shieldgemma+gemini | 51/60 | 22854 | $1.4109 | $1.2549 |
| gemma4b+llamaguard+musespark | 57/60 | 23562 | $3.6422 | $3.5406 |
| gemma4b+llamaguard+gemini | 57/60 | 23562 | $1.4199 | $1.2549 |
| gemma4b+shieldgemma+musespark | 57/60 | 23805 | $3.7244 | $3.5406 |
| gemma4b+shieldgemma+gemini | 57/60 | 23805 | $1.4486 | $1.2549 |
| gemma12b+llamaguard+musespark | 57/60 | 23562 | $3.6422 | $3.5406 |
| gemma12b+llamaguard+gemini | 57/60 | 23562 | $1.4199 | $1.2549 |
| gemma12b+shieldgemma+musespark | 57/60 | 23805 | $3.7244 | $3.5406 |
| gemma12b+shieldgemma+gemini | 57/60 | 23805 | $1.4486 | $1.2549 |
| llama8b+local-only | 0/60 | 0 | $0.2000 | $3.5406 |
| gemma4b+local-only | 0/60 | 0 | $0.2000 | $3.5406 |
| gemma12b+local-only | 0/60 | 0 | $0.2000 | $3.5406 |
| cloud-only+musespark | 58/58 | 23973 | $3.5406 | $3.5406 |
| cloud-only+gemini | 58/58 | 23973 | $1.2549 | $1.2549 |
| llama8b+guard-off+musespark | 51/58 | 22854 | $3.6260 | $3.5406 |
| llama8b+guard-off+gemini | 51/58 | 22854 | $1.4093 | $1.2549 |
| gemma4b+guard-off+musespark | 58/58 | 23973 | $3.7390 | $3.5406 |
| gemma4b+guard-off+gemini | 58/58 | 23973 | $1.4533 | $1.2549 |
| gemma12b+guard-off+musespark | 58/58 | 23973 | $3.7390 | $3.5406 |
| gemma12b+guard-off+gemini | 58/58 | 23973 | $1.4533 | $1.2549 |

Costs use config/pricing.yaml assumptions, including a $0.0002 local allocation per local query. Stratified category means are weighted to the fixed 1,000-item core. Sample planned cloud tokens are estimates, never actual transmitted tokens. Actual transmitted tokens in Tier 0: 0.

The historical Finkd baseline is 1.3 s median and 29.6% handoff on different tasks/methods; it is contextual evidence, not a controlled comparison.

## Held-out calibration diagnostics

| Local model | Labelled test items | AUROC | ECE | Multi-doc accepted wrong / accepted |
|---|---:|---:|---:|---:|
| llama3.1:8b | 59/60 | 0.840 | 0.087 | 0/0 |
| gemma3:4b | 59/60 | 0.708 | 0.145 | 0/0 |
| gemma3:12b | 59/60 | 0.739 | 0.246 | 0/0 |

95% source-group bootstrap intervals, per-category metrics, scoring coverage, exact settings, model digests and SMB-class hardware are in report.json. Small Tier 0 samples only diagnose feasibility; they do not establish a winning pipeline. Receipts verify prepared payloads; prepared_not_sent receipts do not claim a cloud transmission.

## Local-only controls

These use the same 60 held-out items; one unsupported instruction-following label remains pending for every model. Scores are normalized deterministic rubric scores, with partial credit on required facts. They are not cloud-pipeline accuracy estimates.

| Local model | Automated score (95% CI) | Median local ms | p95 local ms | Multi-doc fact coverage | Multi-doc citation precision |
|---|---:|---:|---:|---:|---:|
| Llama 3.1 8B | 36.0% [24.9%, 48.3%] | 338.5 | 1,065.7 | 31.0% | 62.5% |
| Gemma 3 4B | 38.4% [28.4%, 47.4%] | 338.6 | 1,154.2 | 45.4% | 58.3% |
| Gemma 3 12B | 68.7% [55.5%, 81.0%] | 945.5 | 3,768.5 | 56.9% | 50.0% |

Gemma 12B has the strongest local-only score on this sample. Llama 8B has lower latency and higher multi-document citation precision. This does not establish which complete cloud pipeline wins. The eight multi-document test items were all declined by each calibrated classifier: before calibration, confidence >=0.8 accepted eight Llama answers (all wrong by the complete-rubric criterion), seven Gemma 4B answers (all wrong), and seven Gemma 12B answers (five wrong). Zero accepted after calibration means accepted risk is undefined, not zero. Calibration has not demonstrated useful multi-document local coverage.

| Local model | AUROC 95% CI | ECE 95% CI |
|---|---|---|
| Llama 3.1 8B | 0.840 [0.716, 0.935] | 0.087 [0.055, 0.201] |
| Gemma 3 4B | 0.708 [0.596, 0.818] | 0.145 [0.103, 0.283] |
| Gemma 3 12B | 0.739 [0.582, 0.892] | 0.246 [0.157, 0.376] |

## Interpreting Finkd and the baseline

Finkd planned 50/60 handoffs (83.3%), answered eight items locally and blocked two locally. Its 80% supported score is conditional on only ten scored outcomes; 50 cloud answers are missing. It must not be described as 80% overall accuracy. Its 390.1ms median is a reconstructed local-stage sum; total cloud completion latency remains pending. The historical 1,300ms / 29.6% reference used different questions and safety settings. This is not a before/after causal comparison.

The projected Finkd saving is about $0.0115/1,000 queries under the stated assumptions. Many other tested configurations project higher cost than all-cloud. A configuration that blocks a safe request can look cheaper while answering worse; Tier 0 does not rank cloud pipelines or recommend a winner.

## Boundary, hardware and provenance

- Actual cloud model calls, actual cloud tokens and actual cloud spend: **0, 0, $0**. No Meta access probe, Gemini request, OpenRouter call or cloud grader was used.
- All **1,108 prepared receipts** passed signature, payload and signed-chain verification. No missing payloads or integrity breaks; no observed output canary/privacy leaks. These receipts record `prepared_not_sent`.
- Local HTTP requests: 521; external requests: 0. All model and Guard warm-ups were logged separately and excluded.
- Hardware: AMD Ryzen 7 7800X3D, 16 logical cores, 31.11GiB RAM, NVIDIA RTX 5080 with 16,303MiB VRAM, driver 621.01. Ollama 0.40.11. Exact model digests and Guard-template hashes are in `report.json`.
- Frozen inference and measurement source: `eb669e2`. Manifest and source hashes are in `manifest.json`. UTC progress ran from 2026-10-27 20:34:12 to 20:58:46; the displayed run date is 28 October in Perth.
- Receipt append bookkeeping rescanned the full retained chain and dominated elapsed run time as it grew. It is excluded from the displayed Tier 0 local-stage reconstruction. Subsequent receipt/resume infrastructure fixes do not change this frozen evidence; future live-tier instrumentation is documented in METHOD.md.

The all-cloud counterfactual for the three local-only controls is explicitly Muse Spark. Token/cost forecasts are weighted by category and cloud eligibility to the committed 1,000-item core; unsafe cloud work is structurally zero. This is a small stratified cost-planning sample, not a full-scale evaluation. **Tier 1 has not started.**
