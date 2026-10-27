# Handoff private gateway: five testing rounds

The authoritative run is **`2026-10-27T19-56-02-876Z`**, started at **2026-10-27 19:56:02 UTC**. Its testing code was frozen at commit **`bddd4d894d443289b362d2077e16904cfd88c85d`**. The dashboard follows [`latest.json`](latest.json), which references each timestamped result and its SHA-256 hash. All figures below come from those referenced JSON files.

**All five rounds made zero Meta calls.** Meta access remained paused, external requests were prohibited, and cloud-dependent answers, inbound decisions and delivery checks remain deferred. The historical Finkd reference is **1.30s median latency and 29.6% handoff**. Different workloads, safety methods and offline cloud completion prevent a causal comparison with that reference.

| Round | Workload | Recorded result | Latency | Boundary and deferred scope |
| --- | --- | --- | --- | --- |
| 1. Finkd Guard ablation | Same 20 existing benchmark tasks in each arm: 10 public MMLU-Pro and 10 synthetic ad-privacy items | Both arms: 60.0% deterministic score, 20/20 scored, 100.0% local answers, 0.0% handoff | With Guard enabled: 719.2ms median / 2,879.9ms p95; without: 727.3ms / 2,899.8ms | No item escalated, so the outbound Guard hook was not exercised. Per-screen added latency is **pending**, outbound blocks 0, inbound flags **deferred**. |
| 2. Company-data RAG | 60 synthetic company questions | 87.1% answer fact coverage, 94.3% citation precision, 89.9% citation recall; 51/60 scored; 85.0% local / 15.0% handoff | 480.0ms median / 1,136.3ms p95 | 9 cloud answers deferred; 0 tokens sent; 297 PII placeholder occurrences processed; 0 Guard blocks; 9/9 receipts verified. |
| 3. Local Guard red-team | 50 StrongREJECT + 50 safe XSTest prompts | 47/50 harmful prompts blocked (94.0%); 3 harmful prompts passed the classifier. Safe over-blocks: 5/50 (10.0%). | StrongREJECT: 68.5ms median / 75.6ms p95; XSTest: 43.0ms / 61.6ms | 0 prompt leaks to cloud and 0 cloud requests. False refusals measure Guard classification, not an answer model's refusal behavior. |
| 4. Seeded privacy sweep | 12 questions over a local synthetic corpus copy, with 4 invented contacts / 12 planted PII values | 10 proposed payloads and 20 chunks inspected; 0 raw seeded PII leaks and 0 recognized residual PII findings; 10/10 signed payload hashes verified | Privacy inspection and hash-verification round; no live cloud latency measured | 2 local answers and 10 deferred handoffs. Actual cloud requests and tokens sent: 0. Cloud-delivered privacy verification is **deferred**. |
| 5. Full local receipt inventory | 96 receipts across 2 ledgers, including historical records | 96/96 signatures verified; 27 chained entries and retained payload hashes verified; 2/2 signed heads verified; 0 integrity breaks | Local verification only | 69 legacy receipts remain individually signed and unchained, with 69 missing historical payload snapshots. Complete historical chain coverage is **not established**. |

## Cost and token projections

| Recorded workload | Handoff / 1,000 queries | All-cloud / 1,000 queries | Projected saving | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Round 1, either arm | $0.2000 | $1.5719 | $1.3719 (87.3%) | Every sampled task stayed local. This does not measure Guard cost on an escalation. |
| Round 2, company data | $0.5158 | $2.6105 | $2.0947 (80.2%) | Handoff includes $0.20 local electricity/hardware allocation. Deferred safe handoffs are priced as if eventually sent. |

These are **illustrative pricing assumptions**, not observed cloud bills or verified Muse Spark list prices: USD $2/million input tokens, $6/million output tokens, 200 expected output tokens and $0.0002/query local allocation. The all-cloud comparison sends the full retrieved redacted context on every query. Handoff uses the selected redacted evidence only when a handoff is requested.

For Round 2, estimated all-cloud input is 42,315 tokens across the 60 questions; estimated approved handoff input is 4,074. The difference is **38,241 projected input tokens kept local**, or **637,350 per 1,000 queries**. Actual tokens sent to the cloud were **0**. The monthly-volume slider scales these recorded assumptions; it is a forecast, not measured usage or billing.

## Reading the results honestly

- Round 1's small timing difference does not measure Guard overhead: neither arm reached the boundary. The Guard warm-up was excluded. Round 2 did exercise nine outbound screens, with 64.4ms median and 95.8ms p95 screening latency; that is a different workload, not a substitute paired ablation.
- Round 2 accuracy is conditional on 51 scored local answers. Nine deferred cloud answers are excluded. Lookup fact coverage was 97.2% across 36 scored questions; multi-document coverage remained 60.1% across 14 scored questions. One advanced question was answered locally, and seven were deferred. Self-confidence does not reliably identify every incomplete answer.
- The three harmful classifier misses in Round 3 remain recorded. They caused no cloud disclosure because this round had no cloud route and an enforced local-only network boundary. The five safe over-blocks are also retained.
- Round 4 inspected exact retained **proposed** redacted payloads against signed input/chunk hashes. It did not verify remote delivery. Its 54 ingest redactions and 282 per-question placeholder occurrences are counts of processing events, not unique people. Locally restored fake PII may appear in local answers by design.
- Round 5 verified the entire discovered local receipt inventory at 2026-10-27 19:57:52 UTC, including records outside this run. Its 96 receipts are not the number of company-data questions. Legacy signatures are checked without presenting old records as originally chained. The dashboard's Verify action can inspect later local ledger state separately.
- Signed local heads detect changes relative to the retained heads. Simultaneous rollback of a ledger and its local head requires an independent external anchor to detect. Cryptographic integrity does not prove cloud delivery, billing, safety or answer correctness.

## Provenance and archived runs

The earlier exploratory run **`2026-10-27T19-54-15-052Z`** has its Round 1 JSON retained as archived evidence. It is not referenced by the authoritative `latest.json` manifest and is excluded from the five-round table. Do not combine its measurements with the later frozen run. Historical files, the original `rag-summary.md` and the older six-suite `summary.md` remain preserved.

Authoritative round records:

- [Round 1: Guard ablation](round-1-2026-10-27T19-56-02-876Z.json)
- [Round 2: Company-data RAG](round-2-2026-10-27T19-56-02-876Z.json)
- [Round 3: Local red-team](round-3-2026-10-27T19-56-02-876Z.json)
- [Round 4: Seeded privacy](round-4-2026-10-27T19-56-02-876Z.json)
- [Round 5: Receipt verification](round-5-2026-10-27T19-56-02-876Z.json)

Detailed per-item checkpoints, local keys and exact redacted payload snapshots stay in Git-ignored local storage. Published records contain aggregates, task IDs, hashes and classifications. They contain no API keys, gated GPQA questions or real company data.
