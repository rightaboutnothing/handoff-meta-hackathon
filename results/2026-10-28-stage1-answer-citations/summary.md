# Stage 1: local answer generation and citations

Run 2026-10-28-stage1-answer-citations · 2026-10-28T02:18:09.164Z. **Tier 0 only: 0 cloud calls, $0 spend, 0 external requests.**

## Before and after

| Cohort | Model | Full credit before → after | Raw invalid citations before → after | Missing valid citations before → after | Answer parse failures before → after | Self-check parse failures after |
|---|---|---:|---:|---:|---:|---:|
| saved60 | llama3.1:8b | 18/59 → 29/59 | 0/16 → 0/16 | 0/16 → 0/16 | 5 → 1 | 0/60 |
| saved60 | gemma3:4b | 18/59 → 20/59 | 0/16 → 0/16 | 1/16 → 1/16 | 6 → 3 | 0/60 |
| saved60 | gemma3:12b | 38/59 → 38/59 | 12/16 → 0/16 | 12/16 → 2/16 | 7 → 7 | 0/60 |
| plain50 | llama3.1:8b | 21/50 → 24/50 | 0/14 → 1/14 | 2/14 → 4/14 | n/a → 0 | 0/50 |
| plain50 | gemma3:4b | 16/50 → 19/50 | 3/14 → 0/14 | 1/14 → 1/14 | n/a → 0 | 0/50 |
| plain50 | gemma3:12b | 22/50 → 22/50 | 6/14 → 0/14 | 6/14 → 0/14 | n/a → 0 | 0/50 |

Full credit uses each phase's supported rubric labels; unscored items remain pending. Citation rates cover company-data questions only and measure **raw invalid IDs before repair/rejection**. Missing or rejected citations remain visible; zero residual invalid IDs does not mean every generated citation was correct. Plain-before answer parsing is n/a because no JSON envelope was required. Self-check parsing is a new separate pass with no old counterpart.

Prior-method baselines replayed now, rather than saved from the previous run: **plain50 / gemma3:4b (50 rows)**.

## Paired scoring and confidence intervals

| Cohort | Model | Second-grader full credit before → after | First-grader full-credit change, 95% CI | Second-grader full-credit change, 95% CI | First-grader mean-score change, 95% CI | Paired supported items, first / second |
|---|---|---:|---:|---:|---:|---:|---:|
| saved60 | llama3.1:8b | 18/59 → 29/59 | 18.6 pp [5.4, 32.3] | 18.6 pp [5.4, 32.3] | 18.0 pp [4.6, 30.7] | 59/60; 59/60 |
| saved60 | gemma3:4b | 16/59 → 22/59 | 3.4 pp [-8.6, 14.5] | 10.2 pp [-1.7, 20.6] | 2.8 pp [-7.7, 13.2] | 59/60; 59/60 |
| saved60 | gemma3:12b | 37/59 → 38/59 | 0.0 pp [-10.6, 10.7] | 1.7 pp [-8.5, 11.9] | 1.0 pp [-8.7, 10.8] | 59/60; 59/60 |
| plain50 | llama3.1:8b | 23/50 → 24/50 | 6.0 pp [-6.1, 20.0] | 2.0 pp [-10.4, 15.9] | 6.2 pp [-5.1, 18.9] | 50/50; 50/50 |
| plain50 | gemma3:4b | 15/50 → 19/50 | 6.0 pp [-3.9, 16.7] | 8.0 pp [0.0, 17.8] | 5.7 pp [-3.0, 15.2] | 50/50; 50/50 |
| plain50 | gemma3:12b | 22/50 → 22/50 | 0.0 pp [-10.2, 9.4] | 0.0 pp [-10.2, 9.4] | -3.8 pp [-12.3, 3.8] | 50/50; 50/50 |

Paired changes use common supported IDs and a seeded source-group bootstrap. The second grader is an independent deterministic robustness check, not an expert semantic gold standard. Neither unsupported rules nor missing results are silently scored as failures.

## Citation boundary and frozen routing

| Cohort | Model | Raw invalid rate before → after | Repaired items after | Rejected items after | Unresolved citation errors after | Safe local acceptance before → after |
|---|---|---:|---:|---:|---:|---:|
| saved60 | llama3.1:8b | 0.0% → 0.0% | 0 | 0 | 0 | pending → 7/58 |
| saved60 | gemma3:4b | 0.0% → 0.0% | 0 | 0 | 0 | pending → 0/58 |
| saved60 | gemma3:12b | 75.0% → 0.0% | 0 | 0 | 0 | pending → 0/58 |
| plain50 | llama3.1:8b | 0.0% → 7.1% | 0 | 1 | 2 | pending → 1/50 |
| plain50 | gemma3:4b | 21.4% → 0.0% | 0 | 0 | 0 | pending → 0/50 |
| plain50 | gemma3:12b | 42.9% → 0.0% | 0 | 0 | 0 | pending → 0/50 |

Calibration thresholds are unchanged: llama3.1:8b: 0.3601657326870417; gemma3:4b: 0; gemma3:12b: 0. Existing zero thresholds can still cause complete abstention, even if answer quality improves. No classifier was retrained or threshold selected from these test results. Adversarial items remain local regardless of self-check or citation results.

## Additional local work

| Cohort | Model | Median local latency before → after | Mean output tokens before → after | Missing rows before / after | Errors before / after |
|---|---|---:|---:|---:|---:|
| saved60 | llama3.1:8b | 338.5 ms → 588.1 ms | 62.0 → 83.4 | 0 / 0 | 0 / 0 |
| saved60 | gemma3:4b | 331.2 ms → 699.3 ms | 78.3 → 138.9 | 0 / 0 | 0 / 0 |
| saved60 | gemma3:12b | 945.5 ms → 1757.5 ms | 91.9 → 171.4 | 0 / 0 | 0 / 0 |
| plain50 | llama3.1:8b | 941.9 ms → 1271.9 ms | 169.6 → 197.0 | 0 / 0 | 0 / 0 |
| plain50 | gemma3:4b | 583.1 ms → 841.0 ms | 148.9 → 192.4 | 0 / 0 | 0 / 0 |
| plain50 | gemma3:12b | 1160.8 ms → 1856.6 ms | 122.9 → 166.1 | 0 / 0 | 0 / 0 |

After latency and output tokens include both answer generation and the separate local self-check; warm-up is excluded. No extra pass is presented as free. Stage-level timing/token details and measurement coverage are in report.json.

The saved retrieval contexts and source chunks were frozen. Retrieval completeness was not changed or claimed fixed.

**STOP: Stage 2 has not started.**

## Post-run format diagnosis

All structured answer parse failures occurred at the unchanged 384-token cap: Llama 1, Gemma 4B 3, Gemma 12B 7. There were no below-cap schema failures. Two Gemma 12B answers retained an intact answer string but truncated later JSON metadata. No cap or decoding setting was changed after observing these results. Plain answers hit the cap 7/50, 8/50 and 4/50 respectively; zero plain parse failures is not proof that all plain responses finished. All 330 separate self-checks parsed successfully. The remaining truncation limits are recorded, not claimed fixed.

Llama plain-control missing valid citations rose from 2/14 to 4/14, with one item generating an invalid source ID. Its invalid ID was rejected before scoring/routing; rejection is not counted as a correct generated citation. Stage 1 therefore improves the structured citation contract substantially, particularly Gemma 12B, while the unconstrained plain control retains weaknesses.
