# Stage 3: dev-only local acceptance calibration

Run 2026-10-28-stage3-dev-risk-calibration. **Tier 0: zero cloud calls, zero external requests, $0 cloud spend.** Policy hash: a1c9b90667b1f70bceaa4291e5660591c1edfec6223afdf41739828e8c2aad77. Generation/partition seed: 20261027.

## Dev allocation and error-budget scope

| Model | Generated dev items | Unique dev IDs | Recorded role counts |
|---|---:|---:|---|
| llama3.1:8b | 820 | 820 | select=81; fit=328; audit=83; calib=328 |
| gemma3:4b | 820 | 820 | select=81; fit=328; audit=83; calib=328 |
| gemma3:12b | 820 | 820 | select=81; fit=328; audit=83; calib=328 |

The stated error budget is **5.0%**. Company and general/GPQA policies are separate for every local model. Fit, selection, calibration and audit roles remain separate; test answers are replayed only after the policy is locked. No test label selects a model or threshold. Adversarial items remain local-only and are excluded from ordinary safe-answer acceptance and projected skipped-cloud-call counts.

| Model | Slice | Candidate / operational threshold | Calib accepted / finite accepted frame | Conservative calib errors | Upper finite-frame risk bound | Upper audit-only risk bound | Status |
|---|---|---:|---:|---:|---:|---:|---|
| llama3.1:8b | company | 0.000000 / 0.000000 | 0 / 0 | 0 | pending | pending | ABSTAIN_UNCERTIFIED |
| llama3.1:8b | general | 0.379538 / 0.000000 | 17 / 18 | 0 | 5.6% | 100.0% | ABSTAIN_UNCERTIFIED |
| gemma3:4b | company | 0.000000 / 0.000000 | 0 / 0 | 0 | pending | pending | ABSTAIN_UNCERTIFIED |
| gemma3:4b | general | 0.000000 / 0.000000 | 0 / 0 | 0 | pending | pending | ABSTAIN_UNCERTIFIED |
| gemma3:12b | company | 0.037536 / 0.037536 | 63 / 82 | 0 | 3.7% | 15.8% | CERTIFIED_FINITE_DEV_FRAME |
| gemma3:12b | general | 0.000000 / 0.000000 | 0 / 0 | 0 | pending | pending | ABSTAIN_UNCERTIFIED |

Certificate scope: Accepted CALIB+AUDIT dev items only; not FIT/SELECT, final test, future questions or unseen source families **These bounds certify only the stated fixed finite dev frame, not future company traffic, new responses or the test population.** No future 5% error guarantee is claimed. A noncertified slice abstains; lack of acceptance is not a zero-error certificate. Audit and frozen-test confidence intervals below describe their observed outcomes rather than extending the calibration certificate.

## Primary frozen comparisons

### dev-audit

| Model | Slice | Accepted / safe / all | All-query acceptance (descriptive bootstrap 95%) | Accepted correct / unknown | Accepted accuracy (descriptive bootstrap 95%) | Wilson 95% IID sensitivity | Cloud calls skipped |
|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | 0 / 20 / 20 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | general | 0 / 63 / 63 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | overall | 0 / 83 / 83 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | company | 0 / 20 / 20 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | general | 0 / 63 / 63 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | overall | 0 / 83 / 83 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | company | 19 / 20 / 20 | 95.0% [75.0%, 100.0%] | 19 / 0 | 100.0% [100.0%, 100.0%] | [83.2%, 100.0%] | 19 |
| gemma3:12b | general | 0 / 63 / 63 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | overall | 19 / 83 / 83 | 22.9% [0.0%, 44.0%] | 19 / 0 | 100.0% [100.0%, 100.0%] | [83.2%, 100.0%] | 19 |

| Model | Slice | Cloud | Skipped safe calls | Counted cloud input / all query | Total projected tokens / all query | Cloud fees / 1,000 all queries | Matched cloud-only / 1,000 | Saving (95% CI) |
|---|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | gemini | 0 | 318.55 | 635.35 | $0.8876 | $0.8876 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | company | muse-spark | 0 | 289.15 | 605.95 | $2.4791 | $2.4791 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | gemini | 0 | 232.87 | 476.17 | $0.6781 | $0.6781 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | muse-spark | 0 | 219.71 | 463.02 | $1.8992 | $1.8992 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | gemini | 0 | 253.52 | 514.53 | $0.7286 | $0.7286 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | muse-spark | 0 | 236.45 | 497.46 | $2.0390 | $2.0390 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | gemini | 0 | 318.55 | 635.35 | $0.8876 | $0.8876 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | muse-spark | 0 | 289.15 | 605.95 | $2.4791 | $2.4791 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | gemini | 0 | 232.87 | 476.17 | $0.6781 | $0.6781 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | muse-spark | 0 | 219.71 | 463.02 | $1.8992 | $1.8992 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | gemini | 0 | 253.52 | 514.53 | $0.7286 | $0.7286 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | muse-spark | 0 | 236.45 | 497.46 | $2.0390 | $2.0390 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | company | gemini | 19 | 9.00 | 17.80 | $0.0247 | $0.8876 | 97.2% [90.5%, 100.0%] |
| gemma3:12b | company | muse-spark | 19 | 8.30 | 17.10 | $0.0694 | $2.4791 | 97.2% [90.4%, 100.0%] |
| gemma3:12b | general | gemini | 0 | 232.87 | 476.17 | $0.6781 | $0.6781 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | general | muse-spark | 0 | 219.71 | 463.02 | $1.8992 | $1.8992 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | overall | gemini | 19 | 178.93 | 365.72 | $0.5207 | $0.7286 | 28.5% [0.0%, 52.6%] |
| gemma3:12b | overall | muse-spark | 19 | 168.77 | 355.57 | $1.4583 | $2.0390 | 28.5% [0.0%, 53.0%] |

### frozen-saved60

| Model | Slice | Accepted / safe / all | All-query acceptance (descriptive bootstrap 95%) | Accepted correct / unknown | Accepted accuracy (descriptive bootstrap 95%) | Wilson 95% IID sensitivity | Cloud calls skipped |
|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | 0 / 16 / 16 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | general | 0 / 42 / 44 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | overall | 0 / 58 / 60 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | company | 0 / 16 / 16 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | general | 0 / 42 / 44 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | overall | 0 / 58 / 60 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | company | 13 / 16 / 16 | 81.3% [57.1%, 100.0%] | 13 / 0 | 100.0% [100.0%, 100.0%] | [77.2%, 100.0%] | 13 |
| gemma3:12b | general | 0 / 42 / 44 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | overall | 13 / 58 / 60 | 21.7% [10.0%, 35.1%] | 13 / 0 | 100.0% [100.0%, 100.0%] | [77.2%, 100.0%] | 13 |

Frozen previous policy acceptance → new acceptance (all-query): llama3.1:8b / company 0.0% → 0.0%; llama3.1:8b / general 15.9% → 0.0%; llama3.1:8b / overall 11.7% → 0.0%; gemma3:4b / company 0.0% → 0.0%; gemma3:4b / general 0.0% → 0.0%; gemma3:4b / overall 0.0% → 0.0%; gemma3:12b / company 0.0% → 81.3%; gemma3:12b / general 0.0% → 0.0%; gemma3:12b / overall 0.0% → 21.7%.

| Model | Slice | Cloud | Skipped safe calls | Counted cloud input / all query | Total projected tokens / all query | Cloud fees / 1,000 all queries | Matched cloud-only / 1,000 | Saving (95% CI) |
|---|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | gemini | 0 | 243.38 | 507.38 | $0.7330 | $0.7330 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | company | muse-spark | 0 | 219.00 | 483.00 | $2.0220 | $2.0220 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | gemini | 0 | 160.84 | 376.48 | $0.5873 | $0.5873 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | muse-spark | 0 | 153.66 | 369.30 | $1.6011 | $1.6011 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | gemini | 0 | 182.85 | 411.38 | $0.6262 | $0.6262 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | muse-spark | 0 | 171.08 | 399.62 | $1.7134 | $1.7134 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | gemini | 0 | 243.38 | 507.38 | $0.7330 | $0.7330 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | muse-spark | 0 | 219.00 | 483.00 | $2.0220 | $2.0220 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | gemini | 0 | 160.84 | 376.48 | $0.5873 | $0.5873 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | muse-spark | 0 | 153.66 | 369.30 | $1.6011 | $1.6011 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | gemini | 0 | 182.85 | 411.38 | $0.6262 | $0.6262 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | muse-spark | 0 | 171.08 | 399.62 | $1.7134 | $1.7134 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | company | gemini | 13 | 47.19 | 113.19 | $0.1792 | $0.7330 | 75.6% [50.8%, 100.0%] |
| gemma3:12b | company | muse-spark | 13 | 41.38 | 107.38 | $0.4788 | $2.0220 | 76.3% [52.0%, 100.0%] |
| gemma3:12b | general | gemini | 0 | 160.84 | 376.48 | $0.5873 | $0.5873 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | general | muse-spark | 0 | 153.66 | 369.30 | $1.6011 | $1.6011 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | overall | gemini | 13 | 130.53 | 306.27 | $0.4785 | $0.6262 | 23.6% [11.4%, 37.8%] |
| gemma3:12b | overall | muse-spark | 13 | 123.72 | 299.45 | $1.3018 | $1.7134 | 24.0% [11.9%, 38.2%] |


## Other roles and frozen plain control

### dev-select

| Model | Slice | Accepted / safe / all | All-query acceptance (descriptive bootstrap 95%) | Accepted correct / unknown | Accepted accuracy (descriptive bootstrap 95%) | Wilson 95% IID sensitivity | Cloud calls skipped |
|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | 0 / 19 / 19 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | general | 0 / 61 / 62 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | overall | 0 / 80 / 81 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | company | 0 / 19 / 19 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | general | 0 / 61 / 62 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | overall | 0 / 80 / 81 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | company | 16 / 19 / 19 | 84.2% [25.0%, 100.0%] | 16 / 0 | 100.0% [100.0%, 100.0%] | [80.6%, 100.0%] | 16 |
| gemma3:12b | general | 0 / 61 / 62 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | overall | 16 / 80 / 81 | 19.8% [0.0%, 39.6%] | 16 / 0 | 100.0% [100.0%, 100.0%] | [80.6%, 100.0%] | 16 |

| Model | Slice | Cloud | Skipped safe calls | Counted cloud input / all query | Total projected tokens / all query | Cloud fees / 1,000 all queries | Matched cloud-only / 1,000 | Saving (95% CI) |
|---|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | gemini | 0 | 311.37 | 635.58 | $0.9039 | $0.9039 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | company | muse-spark | 0 | 280.74 | 604.95 | $2.5067 | $2.5067 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | gemini | 0 | 197.21 | 457.08 | $0.7088 | $0.7088 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | muse-spark | 0 | 188.39 | 448.26 | $1.9360 | $1.9360 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | gemini | 0 | 223.99 | 498.95 | $0.7546 | $0.7546 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | muse-spark | 0 | 210.05 | 485.01 | $2.0699 | $2.0699 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | gemini | 0 | 311.37 | 635.58 | $0.9039 | $0.9039 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | muse-spark | 0 | 280.74 | 604.95 | $2.5067 | $2.5067 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | gemini | 0 | 197.21 | 457.08 | $0.7088 | $0.7088 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | muse-spark | 0 | 188.39 | 448.26 | $1.9360 | $1.9360 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | gemini | 0 | 223.99 | 498.95 | $0.7546 | $0.7546 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | muse-spark | 0 | 210.05 | 485.01 | $2.0699 | $2.0699 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | company | gemini | 16 | 27.05 | 64.11 | $0.1007 | $0.9039 | 88.9% [20.5%, 100.0%] |
| gemma3:12b | company | muse-spark | 16 | 24.42 | 61.47 | $0.2712 | $2.5067 | 89.2% [21.2%, 100.0%] |
| gemma3:12b | general | gemini | 0 | 197.21 | 457.08 | $0.7088 | $0.7088 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | general | muse-spark | 0 | 188.39 | 448.26 | $1.9360 | $1.9360 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | overall | gemini | 16 | 157.30 | 364.90 | $0.5662 | $0.7546 | 25.0% [0.0%, 45.0%] |
| gemma3:12b | overall | muse-spark | 16 | 149.93 | 357.53 | $1.5455 | $2.0699 | 25.3% [0.0%, 45.4%] |

### dev-fit

| Model | Slice | Accepted / safe / all | All-query acceptance (descriptive bootstrap 95%) | Accepted correct / unknown | Accepted accuracy (descriptive bootstrap 95%) | Wilson 95% IID sensitivity | Cloud calls skipped |
|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | 0 / 78 / 78 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | general | 0 / 247 / 250 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | overall | 0 / 325 / 328 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | company | 0 / 78 / 78 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | general | 0 / 247 / 250 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | overall | 0 / 325 / 328 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | company | 59 / 78 / 78 | 75.6% [29.6%, 100.0%] | 59 / 0 | 100.0% [100.0%, 100.0%] | [93.9%, 100.0%] | 59 |
| gemma3:12b | general | 0 / 247 / 250 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | overall | 59 / 325 / 328 | 18.0% [0.0%, 37.0%] | 59 / 0 | 100.0% [100.0%, 100.0%] | [93.9%, 100.0%] | 59 |

| Model | Slice | Cloud | Skipped safe calls | Counted cloud input / all query | Total projected tokens / all query | Cloud fees / 1,000 all queries | Matched cloud-only / 1,000 | Saving (95% CI) |
|---|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | gemini | 0 | 292.67 | 583.74 | $0.8155 | $0.8155 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | company | muse-spark | 0 | 265.91 | 556.99 | $2.2783 | $2.2783 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | gemini | 0 | 214.63 | 463.72 | $0.6871 | $0.6871 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | muse-spark | 0 | 205.72 | 454.81 | $1.9060 | $1.9060 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | gemini | 0 | 233.19 | 492.26 | $0.7176 | $0.7176 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | muse-spark | 0 | 220.03 | 479.11 | $1.9945 | $1.9945 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | gemini | 0 | 292.67 | 583.74 | $0.8155 | $0.8155 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | muse-spark | 0 | 265.91 | 556.99 | $2.2783 | $2.2783 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | gemini | 0 | 214.63 | 463.72 | $0.6871 | $0.6871 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | muse-spark | 0 | 205.72 | 454.81 | $1.9060 | $1.9060 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | gemini | 0 | 233.19 | 492.26 | $0.7176 | $0.7176 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | muse-spark | 0 | 220.03 | 479.11 | $1.9945 | $1.9945 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | company | gemini | 59 | 43.91 | 86.78 | $0.1204 | $0.8155 | 85.2% [29.6%, 100.0%] |
| gemma3:12b | company | muse-spark | 59 | 40.55 | 83.42 | $0.3383 | $2.2783 | 85.1% [29.6%, 100.0%] |
| gemma3:12b | general | gemini | 0 | 214.63 | 463.72 | $0.6871 | $0.6871 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | general | muse-spark | 0 | 205.72 | 454.81 | $1.9060 | $1.9060 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | overall | gemini | 59 | 174.03 | 374.08 | $0.5523 | $0.7176 | 23.0% [0.0%, 44.0%] |
| gemma3:12b | overall | muse-spark | 59 | 166.44 | 366.49 | $1.5332 | $1.9945 | 23.1% [0.0%, 44.4%] |

### dev-calib

| Model | Slice | Accepted / safe / all | All-query acceptance (descriptive bootstrap 95%) | Accepted correct / unknown | Accepted accuracy (descriptive bootstrap 95%) | Wilson 95% IID sensitivity | Cloud calls skipped |
|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | 0 / 78 / 78 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | general | 0 / 249 / 250 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | overall | 0 / 327 / 328 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | company | 0 / 78 / 78 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | general | 0 / 249 / 250 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | overall | 0 / 327 / 328 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | company | 63 / 78 / 78 | 80.8% [5.6%, 99.2%] | 63 / 0 | 100.0% [100.0%, 100.0%] | [94.3%, 100.0%] | 63 |
| gemma3:12b | general | 0 / 249 / 250 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | overall | 63 / 327 / 328 | 19.2% [0.0%, 40.4%] | 63 / 0 | 100.0% [100.0%, 100.0%] | [94.3%, 100.0%] | 63 |

| Model | Slice | Cloud | Skipped safe calls | Counted cloud input / all query | Total projected tokens / all query | Cloud fees / 1,000 all queries | Matched cloud-only / 1,000 | Saving (95% CI) |
|---|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | gemini | 0 | 315.79 | 636.21 | $0.8958 | $0.8958 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | company | muse-spark | 0 | 285.85 | 606.26 | $2.4942 | $2.4942 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | gemini | 0 | 215.28 | 462.52 | $0.6827 | $0.6827 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | muse-spark | 0 | 205.61 | 452.84 | $1.8946 | $1.8946 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | gemini | 0 | 239.19 | 503.82 | $0.7333 | $0.7333 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | muse-spark | 0 | 224.69 | 489.33 | $2.0372 | $2.0372 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | gemini | 0 | 315.79 | 636.21 | $0.8958 | $0.8958 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | muse-spark | 0 | 285.85 | 606.26 | $2.4942 | $2.4942 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | gemini | 0 | 215.28 | 462.52 | $0.6827 | $0.6827 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | muse-spark | 0 | 205.61 | 452.84 | $1.8946 | $1.8946 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | gemini | 0 | 239.19 | 503.82 | $0.7333 | $0.7333 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | muse-spark | 0 | 224.69 | 489.33 | $2.0372 | $2.0372 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | company | gemini | 63 | 34.26 | 72.62 | $0.1062 | $0.8958 | 88.1% [4.7%, 99.3%] |
| gemma3:12b | company | muse-spark | 63 | 31.47 | 69.83 | $0.2931 | $2.4942 | 88.2% [4.8%, 99.3%] |
| gemma3:12b | general | gemini | 0 | 215.28 | 462.52 | $0.6827 | $0.6827 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | general | muse-spark | 0 | 205.61 | 452.84 | $1.8946 | $1.8946 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | overall | gemini | 63 | 172.23 | 369.80 | $0.5456 | $0.7333 | 25.6% [0.0%, 49.1%] |
| gemma3:12b | overall | muse-spark | 63 | 164.20 | 361.76 | $1.5138 | $2.0372 | 25.7% [0.0%, 49.5%] |

### frozen-plain50

| Model | Slice | Accepted / safe / all | All-query acceptance (descriptive bootstrap 95%) | Accepted correct / unknown | Accepted accuracy (descriptive bootstrap 95%) | Wilson 95% IID sensitivity | Cloud calls skipped |
|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | 0 / 14 / 14 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | general | 0 / 36 / 36 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| llama3.1:8b | overall | 0 / 50 / 50 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | company | 0 / 14 / 14 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | general | 0 / 36 / 36 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:4b | overall | 0 / 50 / 50 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | company | 10 / 14 / 14 | 71.4% [41.7%, 100.0%] | 10 / 0 | 100.0% [100.0%, 100.0%] | [72.2%, 100.0%] | 10 |
| gemma3:12b | general | 0 / 36 / 36 | 0.0% [0.0%, 0.0%] | 0 / 0 | pending | pending | 0 |
| gemma3:12b | overall | 10 / 50 / 50 | 20.0% [6.7%, 34.5%] | 10 / 0 | 100.0% [100.0%, 100.0%] | [72.2%, 100.0%] | 10 |

Frozen previous policy acceptance → new acceptance (all-query): llama3.1:8b / company 0.0% → 0.0%; llama3.1:8b / general 2.8% → 0.0%; llama3.1:8b / overall 2.0% → 0.0%; gemma3:4b / company 0.0% → 0.0%; gemma3:4b / general 0.0% → 0.0%; gemma3:4b / overall 0.0% → 0.0%; gemma3:12b / company 0.0% → 71.4%; gemma3:12b / general 0.0% → 0.0%; gemma3:12b / overall 0.0% → 20.0%.

| Model | Slice | Cloud | Skipped safe calls | Counted cloud input / all query | Total projected tokens / all query | Cloud fees / 1,000 all queries | Matched cloud-only / 1,000 | Saving (95% CI) |
|---|---|---|---:|---:|---:|---:|---:|---:|
| llama3.1:8b | company | gemini | 0 | 264.93 | 566.64 | $0.8338 | $0.8338 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | company | muse-spark | 0 | 236.36 | 538.07 | $2.2830 | $2.2830 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | gemini | 0 | 235.86 | 492.75 | $0.7130 | $0.7130 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | general | muse-spark | 0 | 222.97 | 479.86 | $1.9873 | $1.9873 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | gemini | 0 | 244.00 | 513.44 | $0.7468 | $0.7468 | 0.0% [0.0%, 0.0%] |
| llama3.1:8b | overall | muse-spark | 0 | 226.72 | 496.16 | $2.0701 | $2.0701 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | gemini | 0 | 264.93 | 566.64 | $0.8338 | $0.8338 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | company | muse-spark | 0 | 236.36 | 538.07 | $2.2830 | $2.2830 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | gemini | 0 | 235.86 | 492.75 | $0.7130 | $0.7130 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | general | muse-spark | 0 | 222.97 | 479.86 | $1.9873 | $1.9873 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | gemini | 0 | 244.00 | 513.44 | $0.7468 | $0.7468 | 0.0% [0.0%, 0.0%] |
| gemma3:4b | overall | muse-spark | 0 | 226.72 | 496.16 | $2.0701 | $2.0701 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | company | gemini | 10 | 77.71 | 178.29 | $0.2747 | $0.8338 | 67.0% [34.1%, 94.0%] |
| gemma3:12b | company | muse-spark | 10 | 66.79 | 167.36 | $0.7370 | $2.2830 | 67.7% [35.2%, 94.3%] |
| gemma3:12b | general | gemini | 0 | 235.86 | 492.75 | $0.7130 | $0.7130 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | general | muse-spark | 0 | 222.97 | 479.86 | $1.9873 | $1.9873 | 0.0% [0.0%, 0.0%] |
| gemma3:12b | overall | gemini | 10 | 191.58 | 404.70 | $0.5903 | $0.7468 | 21.0% [5.9%, 38.1%] |
| gemma3:12b | overall | muse-spark | 10 | 179.24 | 392.36 | $1.6372 | $2.0701 | 20.9% [6.0%, 38.1%] |


## Interpretation

Accepted-answer accuracy treats unknown or unsupported accepted labels conservatively as errors. Supported-only accuracy and explicitly IID Wilson sensitivity intervals are retained in JSON. Source-group bootstrap intervals are descriptive and can be degenerate with no observed errors; they do not replace the finite-frame risk certificate. Fit/selection statistics are diagnostics, not independent accuracy estimates. Rates use observed question counts and retain separate populations/models; no average of different Gemma sizes is reported.

Only answers passing citation/source-completeness validation and the truncation gate can be accepted. Model output at the 768-token structured cap escalates. All retained gates are evaluated before calibrated acceptance; no oracle source list or grading reference is a runtime feature.

Cloud fees use each saved redacted question/minimal-context payload counted offline with Gemini's pinned SDK-selected tokenizer and the labelled Muse Spark Llama BPE proxy. Server framing and provider invoices are unknown; output/reasoning lengths, unit prices and zero cache discount are assumptions. The same lean question-only payload serves handoff and cloud-only baselines, while accepted/adversarial items incur zero cloud fees. Local hardware allocation is separate. These are conditional pre-Guard projections: no new cloud answer quality or future Guard decision is measured. Cloud quality per dollar remains pending. Raw payloads, keys and GPQA question text stay private.

**STOP before Stage 4.**
