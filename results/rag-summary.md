# Handoff company-data evaluation

**INTERIM: offline Meta. No Muse Spark calls were made. Cloud answers remain deferred.**

Synthetic Acme Filtration data; seed **20261027**; 60 identical questions per mode. Fingerprint: `04985309b038ada1`.

Measured gateway and evaluator source: commit `363e123`. Warm-up took 31.99s (Llama 0.12s, Llama Guard 28.75s, embeddings 3.11s), recorded separately and excluded. Run order was all 60 RAG questions, then the identical 60 control questions. Per-item loading spikes remain in measured latency.

Historical Finkd reference: **1.30s median**, **29.6% handoff**. Different datasets and safety boundary; descriptive reference only, not a causal before/after.

| Mode | Scored / items | Answer fact accuracy | Citation precision | Citation recall | Local answers | Handoffs requested | Actual cloud | Median | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rag | 52/60 | 85.4% | 92.8% | 89.1% | 86.7% | 13.3% | 0.0% | 0.60s | 2.13s |
| control | 0/60 | deferred | deferred | deferred | 0.0% | 100.0% | 0.0% | 0.34s | 0.52s |

| Mode | Deferred | Errors | Cloud tokens sent | PII redactions | Guard blocks | Receipts verified / issued | Known cloud cost | Unknown-cost items | Projected Handoff / 1,000 | Projected all-cloud / 1,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rag | 8 | 0 | 0 | 297 | 0 | 8/8 | $0.0000 | 0 | $0.4855 | $2.6105 |
| control | 60 | 0 | 0 | 0 | 0 | 60/60 | $0.0000 | 0 | $1.5820 | $1.5183 |

Matched RAG minus no-retrieval control: median **0.26s**, handoffs **-86.7 percentage points**. Matched synthetic questions and settings; control disables retrieval. Offline latency excludes cloud completion, so this is a local routing comparison.

Compared descriptively with the historical Finkd reference, this RAG run is 0.70s lower in median latency and 16.3 percentage points lower in requested handoffs. The corpus and safety method changed, and cloud completions are unavailable; these differences cannot be attributed to retrieval alone. Within the matched experiment, retrieval adds 0.26s of local processing while enabling 52 local answers instead of deferring every question.

The RAG-mode cost projection is the relevant full-context all-cloud comparison: **$0.4855 versus $2.6105 per 1,000 queries**, including $0.20 local hardware/electricity allowance in Handoff. The control has no retrieved context and therefore a smaller counterfactual input; its cost columns are not a full-context baseline. These figures are illustrative assumptions, with zero measured Meta spend.

All 36 lookups completed locally, with 97.2% fact coverage. Multi-document fact coverage was 60.1% on 14 scored questions; two were deferred. Two advanced questions were answered locally with 50.0% fact coverage, while six were deferred. Self-confidence did not reliably identify every incomplete answer. These weaknesses remain in the measured results.

## rag category results

The control keeps the valid-citation requirement, so absence of evidence necessarily forces a handoff. It tests the grounding policy; it does not reproduce the historical Finkd routing method or measure Llama's general knowledge.

| Category | Scored | Answer fact accuracy |
| --- | ---: | ---: |
| lookup | 36 | 97.2% |
| multi_document | 14 | 60.1% |
| cloud | 2 | 50.0% |

## rag step timings

| Stage and model | Calls | Median | p95 |
| --- | ---: | ---: | ---: |
| retrieval:nomic-embed-text:v1.5 | 60 | 0.03s | 0.20s |
| local_answer:llama3.1:8b | 60 | 0.55s | 1.09s |
| guard_outbound:llama-guard3:8b | 8 | 0.14s | 0.16s |

## control category results

| Category | Scored | Answer fact accuracy |
| --- | ---: | ---: |
| lookup | 0 | deferred |
| multi_document | 0 | deferred |
| cloud | 0 | deferred |

## control step timings

| Stage and model | Calls | Median | p95 |
| --- | ---: | ---: | ---: |
| retrieval:control-no-retrieval | 60 | 0.00s | 0.00s |
| local_answer:llama3.1:8b | 60 | 0.28s | 0.46s |
| guard_outbound:llama-guard3:8b | 60 | 0.05s | 0.06s |

## Method and pricing assumptions

Warm-up calls are excluded. Run order: rag then control. Models: llama3.1:8b, llama-guard3:8b, muse-spark-1.3. Keep-alive: -1; local max output: 384; cloud reasoning: medium.

**Illustrative USD assumptions:** Muse Spark input $2/million tokens; output $6/million tokens; 200 expected output tokens; local electricity/hardware allowance $0.0002/query. These are not verified list prices.

All-cloud is a counterfactual using the full top-k retrieved redacted context on every question. Handoff uses only its selected chunks when a handoff is requested. Deferred handoffs remain in the projected cost. No all-cloud baseline requests are sent.

- Answer accuracy is deterministic required-fact coverage, not an expert or model-graded quality score.
- Citation accuracy is precision against expected source chunk IDs; source coverage is reported separately as citation recall.
- Deferred cloud answers and execution errors are excluded from scored accuracy, with coverage and counts shown.
- Offline latency measures local processing and handoff preparation, not unavailable cloud completion.
- PII redaction counts are placeholder occurrences processed per query, not unique people or unique records.
- Cost figures per 1,000 queries are assumptions, not measured all-cloud bills. Known cloud cost sums only provider-reported charges; missing charges and uncertain failed-request charges are counted separately, never replaced by estimates or treated as a complete bill.

## Deferred question IDs

rag: acme-041, acme-058, acme-057, acme-053, acme-055, acme-060, acme-054, acme-042
control: acme-032, acme-003, acme-025, acme-041, acme-056, acme-043, acme-058, acme-009, acme-047, acme-051, acme-007, acme-057, acme-023, acme-046, acme-011, acme-036, acme-001, acme-020, acme-049, acme-012, acme-027, acme-029, acme-017, acme-031, acme-040, acme-053, acme-035, acme-055, acme-060, acme-019, acme-054, acme-021, acme-004, acme-002, acme-022, acme-052, acme-034, acme-006, acme-045, acme-015, acme-010, acme-008, acme-016, acme-005, acme-024, acme-044, acme-037, acme-038, acme-059, acme-014, acme-028, acme-030, acme-039, acme-013, acme-042, acme-018, acme-050, acme-033, acme-048, acme-026
