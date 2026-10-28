# Stage 6c interpretation: real injection screening, mixed usability results

**Stage 7 is NOT allowed. Live dispatch remains disabled.** The frozen-question usability target was met for both lenses, but the safe-query false-block target was not met. Google also regressed on the country population, and answer application remains unreliable. There were **zero cloud calls, zero external attempts and $0 cloud spend**.

Measurement source is `5a596f5`; the earlier full run at `3332711` is preserved and pinned by hash in the configuration. No scores, checkpoints or latency measurements were reused across those source versions. Both complete runs used seed 20261027, unchanged frozen inputs, the same model digests, token caps, Guard settings, Prompt Guard threshold and declared gate criteria. The first run exposed deterministic normalization/grammar defects; the second followed repairs with separately authored regression cases. No Guard threshold was fitted to the evaluation data.

## Final comparison

| Setup | Frozen planted survivors / 50 | Frozen usable / 50 | Country planted survivors / 60 | Country usable / 60 | Available-check attacks blocked / 200 | Safe operational false blocks / 74 | Completed applications / 11 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Meta lens | 0 | 50 | 0 | 60 | 185 | 19 | 2 |
| Google lens | 0 | 50 | 0 observed | **0** | 157 | 20 | 0 |
| Google native-only, no injection layer | 0 | 50 | 0 observed | **0** | 134 | 20 | 0 |
| Presidio PII-only yardstick | 50 | 50 redacted sources | 60 | 60 redacted sources | N/A | N/A | N/A |

Every setup processed **522 frozen + 60 separate country items**. Available-check attack rates are **92.5% Meta** (Wilson 95% 88.0–95.4%), **78.5% Google** (72.3–83.6%) and **67.0% native-only** (60.2–73.1%). These include privacy and intent-policy rejections, not just safety-model detections. Presidio does not supply a harmful-content/injection detector or question-rewrite/application pipeline; numerical zeros in its generated safety rows mean no detector, not proven safety.

Meta's 50 frozen and 60 country candidates also passed the composed outbound checks. Google's 50 frozen candidates passed; all 60 country candidates were rejected. Independent seed scans inspect raw and decoded candidate text, without hiding values inside placeholder wrappers. They measure planted-value survival, not all possible private information or semantic re-identification. The generated report retains conditional usable-candidate intervals; Google's country conditional denominator is zero and stays pending.

## Prompt Guard 2: real local models

| Model | Threshold | Available | Mixed attacks blocked | Safe wrongly blocked | Warm median / p95 ms |
|---|---:|---:|---|---|---:|
| 86M, primary | 0.5 | 274/274 | 81/200 · 40.5% | 0/74 | 109.12 / 1,290.73 |
| 22M, comparison | 0.5 | 274/274 | 47/200 · 23.5% | 0/74 | 37.28 / 424.84 |

The threshold is the pre-existing binary argmax operating point, selected before evaluation rather than optimized on these items. Both models use verified, pinned local assets, four CPU threads, complete tokenizer-native overflow windows and the maximum malicious score across windows. Both received fresh standalone predictions. Loading warm-ups are excluded, and the two tokenizers produce different window counts.

These are mixed-set block rates, **not general harmful-content recall**. The 200 items comprise 100 harmful requests, 50 jailbreak examples and 50 injection-labelled examples. The 86M breakdown is **30/100 harmful, 46/50 jailbreak and 5/50 injection**; 22M is **17/100, 29/50 and 1/50**. The injection-labelled result is weak and remains an explicit protection gap. Zero safe blocks has a Wilson 95% upper bound of **4.93%**, not a guarantee about future traffic. Full pipeline screens additionally inspect decoded text and rewritten questions, so their block rates and latencies differ from these original-text standalone measurements.

## Top three usability fixes

1. **Preserve the task while masking its values.** The local rewrite input extracts the actual request, keeps evidence local and uses nonlinkable role placeholders. Mixed letter/digit identifiers are masked before rewriting and after generation, with local AES registration. Actual tagged values remain protected; generic canary-category discussion is distinguished from a literal tag.
2. **Separate residual privacy inspection from usefulness.** The checker sees only the candidate and extracts typed, exact private-value spans. It cannot overwrite a good rewrite or reject it with a broad “not general” boolean. Code validates and replaces the spans, then reruns independent pattern and known-value checks. Fixed neutral markers are checked as syntax rather than mistaken for identities.
3. **Keep intent gates meaningful.** Deterministic checks preserve topic, domain operations, grouping, output format and math constraints. Regression fixes distinguish meaning-verb “mean” from arithmetic average, writing verbs from message/letter nouns, and equivalent constrained lookup/computation requests. Finite opening words are permitted without broadly allowing unknown names. These heuristics remain imperfect; they are not a semantic-equivalence certificate.

The separately authored development manifest and 18-case repair proposal are recorded in the method. Positive and negative unit regressions were committed before the fresh measurement. The frozen corpora and private snapshots were not edited to improve outcomes.

## False blocks: improvement is insufficient

| Lens | Stage 6b available-check false blocks | First Stage 6c operational false blocks | Final Stage 6c operational false blocks |
|---|---:|---:|---:|
| Meta | 47/74 | 36/74 | **19/74 · 25.7%** |
| Google | 21/74 | 35/74 | **20/74 · 27.0%** |
| Google native-only | 21/74 | 34/74 | **20/74 · 27.0%** |

Stage 6b lacked injection weights, so its available-check rate is shown separately from the current operational rate. Meta improved substantially; Google's final rate is only one case below the original Stage 6b rate. **The requested low false-block outcome was not achieved.** Final Wilson 95% intervals are **17.1–36.7% Meta** and **18.2–38.1% Google**.

The following counts overlap. The JSON lists every blocked safe item by ID, category and hash with its layers, plus first-failing-layer counts.

| Layer or reason | Meta safe cases | Google safe cases |
|---|---:|---:|
| Final question/intent validation stage | 14 | 19 |
| Name/shape/reference validation, overlapping the prior row | 11 | 18 |
| Literal-span checker invalid output | 1 | 0 |
| Rewrite cap hit | 0 | 1 |
| Composed Prompt Guard 86M | 3 | 1 |
| Harmful-content Guard | 3 | 1 |

The standalone injection screen had no safe false blocks. The larger composed rates mainly reflect abstraction, entity and intent validation; some rewritten questions also triggered safety checks. A rejection of a rewritten question is not automatically an error by the safety model. In particular, 11 of Google's 13 name-validation flags involve the same copied synthetic company-name pair; four Meta name flags include it too. These are incomplete company-name abstraction caught by the boundary, not evidence that the name gate should simply be waived. A few other cases involve opening words or public-interface terminology. The original tasks are labelled harmless, but a privacy rejection of a bad rewrite can still be correct. No privacy check was waived merely to satisfy the false-block budget.

## Country regression and correlation

All 60 Google country failures are **`QUESTION_INTENT_LOST`**, with `explain` reported missing. Their normalized rewrites share one question hash. The question begins with a condition, whereas the implicit-explanation heuristic recognizes only a leading How/Why/What form. Meta's 60 successful country cases likewise share one normalized question hash. This is a correlated repeated-template failure of the fixed intent rule, not 60 independent demonstrations of Google reasoning failure. Both country sets remain separate from the Australian frozen PII sample.

The shared strict-pattern scanner's country recall is distinct from this end-to-end result. Its synthetic coverage does not establish real-world recall, and names outside its declared pattern scope remain visible in the all-seed denominators. The frozen Australian set includes many intentionally invalid-checksum formats; finding them by context is not checksum validation.

## Local application and output-contract limits

| Setup | Direct matched baseline full credit / 11 | Application completions / 11 | Applied full credit / 11 | Verified AES source round trips |
|---|---:|---:|---:|---:|
| Meta | 4 | 2 | 2 | 2 |
| Google | 5 | 0 | 0 | 0 |
| Google native-only | 5, shared baseline | 0 | 0 | 0 |

Meta had five outbound blocks, three invalid-citation application failures and one 768-token truncation. Google and native-only each had three outbound blocks and eight invalid-citation application failures. Every output permit and source restoration check remained valid: there was no cache corruption, source-hash mismatch or permit bypass. For ad tasks, the allowed retrieval-citation set is empty, yet the models produced nonallowed citation IDs; this exposes an output-contract gap, and validation correctly withheld those answers. A company case also cited an ID outside its supplied context. These failures are not hidden as successful applications.

The two completed Meta cases improved from zero to two full-credit answers on those matched pairs, but two successes do not establish preserved overall quality. Scoring uses the saved deterministic rubrics. Guidance is generated by a local surrogate and applied locally; actual Muse Spark answer quality is **DEFERRED** because no cloud model was called.

## Timing, verification and release decision

| Layer | Meta median / p95 ms | Google median / p95 ms |
|---|---:|---:|
| Strict patterns | 6.59 / 12.71 | 5.89 / 11.26 |
| Rewrite, newly measured calls | 213.73 / 523.77 | 342.64 / 533.29 |
| Residual literal-span check | 75.90 / 119.75 | 114.17 / 155.96 |
| AES/final validation | 7.27 / 9.25 | 7.31 / 8.86 |
| Composed Prompt Guard 86M | 239.47 / 624.98 | 269.15 / 660.97 |
| Composed Prompt Guard 22M | 84.92 / 226.19 | 86.34 / 214.46 |
| Harmful-content Guard | 63.08 / 109.88 | 77.82 / 113.34 |
| Saved-output privacy check | 64.40 / 189.81 | 99.21 / 157.75 |
| Completed local applications | 710.92 / 713.77, n = 2 | Unavailable |

The generated summary retains each denominator and reuse count. Identical calls are cached within a run and marked; native-only is a shared-work control, not an independent latency repeat. Layer percentiles cannot be summed into an end-to-end percentile. Model loading and warm-ups are excluded. Presidio median/p95 was **7.92/55.92 ms**, n = 582.

The generated JSON's `local_apply` stage timing covers successful applications only, because validation exceptions occur before a stage is returned. A separate read-only audit reconstructed every attempted application from its exact cached request and verified all 14 unique requests against the source identity and request journal:

| All attempted local applications | New / replayed calls | Success / failure | Median / p95 ms |
|---|---:|---:|---:|
| Meta, n = 6 | 6 / 0 | 2 / 4 | 707.65 / 2,533.10 |
| Google, n = 8 | 8 / 0 | 0 / 8 | 570.11 / 1,082.23 |
| Google native-only, n = 8 | 0 / 8 | 0 / 8 | Shared Google measurements |

These all-attempt timings include rejected citations and truncation; the successful-only latency above must not be presented as the cost of every attempted application. The immutable measured JSON has not been rewritten to hide this instrumentation limitation.

The completed rerun records **2,683 Ollama model requests**, plus two local metadata requests; Prompt Guard's local Python inference is separately recorded in its results and checkpoints. There were zero external attempts. **485 unit tests pass**, dashboard checks pass, and code plus measured aggregates were audited against their retained private checkpoints and source hashes. Meta also recorded 19 model/validation errors across the 582-item cohort; Google recorded two. Quality application errors are separately reported above rather than mixed into those denominators.

The declared maximum is **3/74 safe-query blocks**, plus zero planted survivors on both populations, service coverage targets, a genuinely available primary detector and no execution errors. Neither production lens qualifies. The native-only and Presidio rows are comparison controls and cannot qualify. The Stage 3 certificate remains unchanged and does not certify this boundary or future traffic. No flag, budget or kill switch has been enabled.

The PII sets are synthetic; context clues can identify a person; small models miss details; tokenisation protects only detected values; **this is not a compliance claim**. No API keys, HF tokens, GPQA question text or attack text are published. Raw private inputs and outputs remain outside Git. Both complete measurements are preserved, including regressions and failures.
