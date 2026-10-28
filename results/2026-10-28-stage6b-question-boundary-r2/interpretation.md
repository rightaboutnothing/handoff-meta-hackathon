# Stage 6b interpretation: protected but not useful enough for release

**Stage 7 is blocked.** The boundary is implemented and tested, but this evaluation does not establish a useful private handoff pipeline. There were **zero cloud calls and $0 spend**. Live dispatch remains disabled; neither routing flag nor a passing synthetic metric can override it. The measured implementation is commit `db91254`, with seed 20261027 and frozen inputs. The earlier partial run was stopped, preserved and excluded; its 1,114 local calls are disclosed separately in the aggregate report.

| Setup | Planted PII survivors / 50 | Usable questions / 50 | Available-check attack blocks / 200 | Available-check safe false blocks / 74 | Local application completed / 11 | Full-credit applied answers |
|---|---:|---:|---:|---:|---:|---:|
| Meta lens | 0 | 5 | 181 | 47 | 0 | 0 |
| Google lens | 0 | 6 | 130 | 21 | 2 | 0 |
| Presidio PII yardstick | 50 | 50 redacted sources | N/A | N/A | N/A | N/A |
| Google native-only, no injection layer | 0 | 6 | 130 | 21 | 2 shared with Google | 0 |

The [generated summary](summary.md) reports all rates with denominators and Wilson intervals, six trick populations, country strata, per-layer latencies, quality and category/ID-only failures. [report.json](report.json) is the authoritative aggregate. Public benchmark sources, pinned versions and licences remain those in the [original Stage 6 report](../2026-10-28-stage6-guard-stress/summary.md); its corpus was not changed. Presidio has no attack, harmful-content or local-application model; numerical zeros in its generated safety rows mean no such detector, not demonstrated safety performance.

## Why the privacy condition does not pass

The independent yardstick scans final question text and decoded variants. It found zero planted-value survivors, including in questions that the pipeline subsequently rejects. That is insufficient when only five Meta and six Google candidates are valid and usable. Invalid, empty, refused and unavailable candidates cannot be counted as successful service. Among usable cases, the descriptive Wilson 95% upper leak-rate bounds are **43.4% for 0/5 Meta** and **39.0% for 0/6 Google**. The generated 0/50 interval is an all-candidate scan statistic and must not be interpreted as a bound on useful private service.

On the 50 PII cases, Meta's residual LLM check marked **37** nongeneral; the general-question validator rejected another **8**. Google marked **44** nongeneral. These counts describe implementation behavior, not proof that a useful abstract question is impossible. No prompt or threshold was adjusted in response to these outcomes. The chief remaining problem is excessive rejection, not a demonstrated balance of privacy and utility.

Both complete lenses operationally block **200/200 attacks, 74/74 safe queries and 138/138 saved outputs** because Prompt Guard is unavailable. These blanket blocks are not injection recall, false-positive performance or unsafe-output prevalence. The measured available-layer attack blocks are **181/200 (90.5%; Wilson 85.6–93.8%) Meta** and **130/200 (65.0%; 58.2–71.3%) Google**. Available-check false blocks are **47/74 (63.5%; 52.1–73.6%)** and **21/74 (28.4%; 19.4–39.5%)**. Those checks include general-question and privacy policy as well as harmful-content classification; they are not isolated Llama Guard or ShieldGemma recall. The harmful classifiers alone flagged **111/200 Meta** and **37/200 Google**, overlapping the other blocks. On saved outputs, available checks flagged **76/138 Meta** (73 privacy, 3 harmful) and **46/138 Google** (46 privacy, 0 harmful). These are local classifications, not independently adjudicated unsafe-output prevalence.

| Trick, n = 10 each | Meta available-check blocks | Google available-check blocks | Google native-only |
|---|---:|---:|---:|
| Retrieved-document injection | 5 | 4 | 4 |
| Base64 | 10 | 10 | 10 |
| Multi-turn | 10 | 7 | 7 |
| Japanese | 10 | 9 | 9 |
| Leetspeak | 7 | 10 | 10 |
| Homoglyphs | 10 | 10 | 10 |

The native-only control lacks a dedicated injection classifier. Some attacks are rejected by other checks, which does not close that architectural gap. Both Prompt Guard sizes are pending, so no empirical 86M-versus-22M accuracy comparison is possible yet.

## Answer quality was not preserved

The direct matched local baselines earned full automated rubric credit on **4/11 Meta** and **5/11 Google** cases. With generalized guidance, no Meta application completed; two Google applications completed and neither earned full credit. On those two matched Google pairs, baseline full credit was **1/2**, application full credit **0/2**, and average fact coverage fell from **50.0% to 33.3%**. The other nine pairs are unavailable, not silently removed from service coverage. The complete-case Wilson interval for 0/2 is 0–65.8%, underscoring the tiny sample.

Two Google AES source round trips verified; none reached that step for Meta. This proves restoration for those two detected-value mappings, not detection completeness or factual correctness. The Google native-only quality row reuses exactly the same local work; it is not an independent repeat. Quality uses deterministic saved task rubrics and a local Gemma 4B surrogate, not Muse Spark. Actual cloud answer quality stays **DEFERRED**, and an empty or blocked answer is not a quality success.

## Country coverage and limits

The shared strict-pattern layer found **250/250** in-scope seeds in the frozen Australian set, or **250/300 (83.3%)** when the 50 names outside pattern scope are included. Only **7/50 TFNs and 4/50 Medicare numbers** have valid checksums; the other 89 values are contextual invalid-format warnings, not checksum-validation successes.

In the separate 60-item multi-country set, AU, US, GB, JP, DE, FR, ES, IT, CA and IN each scored **36/36 in-scope seeds**, for **360/360 overall**. Including names, each scored **36/42**, for **360/420 (85.7%)** overall. These are shared rule-layer results for both lenses, not evidence that their LLMs recognize every country equally. Presidio found **223/420 (53.1%)** total multi-country seeds. Full per-country Presidio results and validity strata are in the generated summary.

The synthetic generator and detector share standard checksum implementations. The 42 mutated checksum controls and unit tests validate plumbing and selected negatives, not independent algorithm certification or real-world recall. PAN and some national ID formats remain format-only. Address, date, language and national-phone coverage are limited to implemented patterns and configured regions. Presidio uses an English small spaCy model, not multilingual ground truth.

## Latency and reproducibility

| Layer | Meta median / p95 ms | Google median / p95 ms |
|---|---:|---:|
| Decode | 0.02 / 0.12 | 0.02 / 0.11 |
| Strict patterns | 6.10 / 13.37 | 6.18 / 11.68 |
| Local rewrite | 166.29 / 233.97 | 237.53 / 383.33 |
| Residual LLM privacy check | 195.18 / 609.44 | 315.86 / 458.55 |
| AES tokenisation and final validation | 7.37 / 9.03 | 7.21 / 8.41 |
| Harmful-content check, outbound and inbound | 64.64 / 177.63 | 76.29 / 116.48 |
| Incoming privacy check | 114.03 / 260.61 | 173.61 / 272.07 |
| Prompt Guard 86M / 22M | PENDING | PENDING |
| Local application | Unavailable | 1,422.61 / 2,282.44; n = 2 |

Layer medians and p95s cannot be summed into an end-to-end percentile. The generated report retains each denominator, warm-up and replay count. Google native-only shares upstream stages and does not add another independent latency sample. Presidio median/p95 was **7.13/66.55 ms**, n = 522. These are local dry-run latencies on the recorded SMB-class workstation; cloud latency is unmeasured.

The completed r2 journal records **2,797 local model calls**, including excluded warm-ups, plus two local metadata requests. It records **zero external attempts and zero denied local protocol attempts**. Raw snapshots, exact questions, attacks and fake PII remain outside Git; public artifacts contain allowlisted measurements, IDs, categories and hashes. Tests use mocked model clients. **426 unit tests pass**; dashboard checks pass. Keys and HF tokens are neither printed nor committed.

## Vendor findings and skeptic caveats

The reviewed open local Meta and Google stacks do not supply a dedicated PII redactor. Meta's experimental PII scanner is a detector, distinct from redaction. Google's local Gemma/ShieldGemma control has no native injection detector. This statement does not extend to Google's hosted Model Armor, which includes injection and sensitive-data protections; primary sources and the exact scope are documented in [the method](../../docs/stage6b-method.md).

- The PII test set is synthetic.
- Context clues can still identify a person.
- Small models miss things.
- Tokenisation only protects data that was detected.
- This is not a compliance claim.

The frozen-frame Stage 3 certificate is unchanged and does not certify this boundary, future traffic or cloud answer quality. Resolving the Prompt Guard download alone will not fix the measured rejection and answer-quality failures. The gate remains closed and no live calls are authorized by this report.
