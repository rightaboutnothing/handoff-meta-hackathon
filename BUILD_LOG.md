# Handoff build log

## 29 October 2026: Stage 6e locked-results dashboard and judging assets

Added a shared data-bound Results view at `http://127.0.0.1:4173/#results`, also leading Trust and Benchmarks, selected from completed Stage 6d with Stage 6c fallback. The loader validates report/source hashes and publishes numeric aggregates and provenance only. Historical methods remain separate, first-block bars do not double-count overlapping flags, and zero survivors with no usable questions remains a visible failure.

The [offline visual example](docs/dashboard/index.html) and five [PNG snapshots](docs/dashboard/manifest.json) render the same component as the app: [headline](docs/dashboard/stage6e-headline.png), [progress](docs/dashboard/stage6e-progress.png), [attribution](docs/dashboard/stage6e-attribution.png), [Prompt Guard](docs/dashboard/stage6e-prompt-guard.png) and [provenance](docs/dashboard/stage6e-provenance.png). The manifest records the measured source/report hashes, seed, AWST run time, renderer hashes and image hashes. Export made zero model/cloud calls and zero external page requests. All original result files remain unchanged.

All **638/638 unit tests** pass, including Windows junction confinement, plus the dashboard build/safety checks and 23 new privacy-view semantic cases. No new benchmark or model run was performed. Stage 6b has no separate multi-country population; Presidio has no applicable local-answer study. Those gaps stay unmeasured rather than receiving invented figures.

## 28 October 2026: Interim offline-Meta benchmark

The resumable benchmark has reached **900/1200 effective results**. This is an interim checkpoint, not the final six-suite result: **300 Meta-dependent items remain deferred until Meta access is explicitly confirmed restored**.

- Fixed seed: `20261027`
- Offline-Meta items completed: `596/596`
- Effective results: `900/1200`
- Deferred Meta items: `300`
- Terminal item errors after retries: `0`
- Meta requests during the offline-Meta execution: `0` (verified from the request trace)
- Safety method: StrongREJECT stayed local-only; XSTest used the local pre-escalation safety screen
- Checkpointing: one result after every pairing/task item, resumable by pairing and task ID

### Interim metrics

| Pairing | IFEval | GPQA | MMLU-Pro | StrongREJECT | XSTest | Ad privacy | SR local refuse | SR safety block | XS refuse | XS over-block | Canary payload/output | Escalate | Cost USD | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Finkd (`meta-meta`) | 100.0% | 59.4% | 46.8% | 98.0% | N/A | 80.9% | 96.0% | 100.0% | N/A | N/A | 0/0 | 29.6% | 0.402803 | 1,306 ms |
| Llamarok (`meta-grok`) | 95.4% | 58.9% | 47.4% | 97.0% | 62.4% | 87.9% | 94.0% | 100.0% | 28.0% | 32.0% | 0/0 | 33.7% | 3.798489 | 1,550 ms |
| Gemmuse (`gemma-meta`) | N/A | N/A | N/A | 100.0% | N/A | N/A | 100.0% | 100.0% | N/A | N/A | 0/0 | 0.0% | 0.000000 | 2,022 ms |
| Gemmok (`gemma-grok`) | 95.0% | 77.6% | 73.0% | 100.0% | 68.1% | 98.5% | 100.0% | 100.0% | 30.0% | 30.0% | 0/0 | 45.7% | 5.479994 | 10,713 ms |

The table combines previously valid saved checkpoints with the completed offline-Meta pass. It does not imply that Finkd or Gemmuse made Meta calls during that pass.

### Deferred work

| Pairing | Suite | Items |
| --- | --- | ---: |
| Finkd (`meta-meta`) | XSTest | 50 |
| Gemmuse (`gemma-meta`) | IFEval | 50 |
| Gemmuse (`gemma-meta`) | GPQA | 50 |
| Gemmuse (`gemma-meta`) | MMLU-Pro | 50 |
| Gemmuse (`gemma-meta`) | XSTest | 50 |
| Gemmuse (`gemma-meta`) | Ad privacy | 50 |

The full interim report, including all 300 deferred pairing/task IDs, is in [results/summary.md](results/summary.md). GPQA question text remains only in the Git-ignored local cache.

## 28 October 2026: Stage 6 local stress test and disabled live safeguards

Live controls committed as `d8510b0`; frozen stress harness/dashboard as `aeea210`. Independent review caught and fixed per-question budget resets: Ask requests now share a stable operator run ID and ledger. Default kill switch remains on, with one call / 4,096 total tokens / $0.01 caps, no retries, reasoning-inclusive reservations, content-free audits and explicit empty-Responses errors. Eleven exact bodies were prepared, never sent: $0.021344 projected including 896 assumed reasoning tokens; $0.077388 conservative reservation / 21,798 tokens / 11 calls. No access or routing flag was enabled.

The [measured report](results/2026-10-28-stage6-guard-stress/summary.md) retains all 522 valid screens: 121/200 catches, 0/74 false blocks, 48/50 Guard-safe PII candidates with surviving values, 0/10 retrieved-document injection catches, 0/10 base64 catches and 3/138 saved local answers flagged unsafe. Medicare/TFN-format numbers and addresses survived in all 50 PII cases. **General private-data release is not ready.** There were 523 local Guard calls including warm-up, 23 separate local preparation calls, zero execution errors and zero cloud requests/spend. No Guard, redactor or locked threshold was tuned on this sample.

Raw attack sets, translations, seeded fields and candidates remain outside Git. Public reports contain category/ID/hash metadata; bundle and staged-file scans check protected text without displaying it. All **363 unit tests** passed. An initial full run had one existing Windows lock-release `EPERM`; an unchanged full rerun passed 363/363. The measured JSON stays unchanged; post-measurement reporting adds interpretation and the readiness checklist to Markdown.

## 28 October 2026: Stage 5 Guard boundary and opt-in live recommendation

Committed the locked runtime and local Guard runner as `e477496`. The routing flag defaults off. Opt-in uses Gemma 12B for company-document questions at the unchanged Stage 3 threshold, with citation/completeness/truncation gates; other safe questions abstain. All handoffs require redaction and a one-use Guard pass bound to the exact payload. Trusted adversarial items stay local in either flag state. Meta access remains paused.

Local Llama Guard screened the [eleven saved business proposals](results/2026-10-28-stage5-guard/summary.md): **11 safe / would release, 0 blocked, 0 errors**, with **zero cloud calls and $0 spend**. New PII replacements were zero because the saved wires were already minimized; upstream removal of sixteen private field groups / forty values was verified separately. Exact would-send payloads remain ignored and local. The privacy view now shows measured screens and the server's flag state for the matching Gemma 12B cohort; other scopes remain pending. The fixed-dev 3.66% certificate caveat remains visible; inbound Guard screening is pending. All **331 unit tests** passed before measurement; no API keys or GPQA text were printed or committed.

## 28 October 2026: Stage 4 slice reporting and submission assets

Built the [single saved-results report](results/2026-10-28-stage4-slice-report/summary.md), shared dashboard view and four [1920×1080 PNG exports](results/2026-10-28-stage4-slice-report/charts/manifest.json) from Stage 3's locked decisions. No new inference, Guard screen, cloud call or paid tier ran; cloud spend was $0. Company single/multiple-document slices, overlapping arithmetic, MMLU-Pro, GPQA and other questions retain explicit sample sizes and separate models/cohorts.

Gemma 12B accepts 8/8 single-document, 5/8 multiple-document and 12/14 arithmetic-overlay questions, all accepted answers full rubric credit. The company total remains 13/16; the finite-dev bound remains 3.66%, with future traffic uncertified. Llama/Gemma 4B retain abstention. Costs show dollar/percentage savings by slice and 25/50/75% company-document workloads. Privacy now counts all 24 business-data queries, including eight synthetic ad exports: 13 local answers, 11 proposed pre-Guard handoffs and zero actual cloud transfers. Guard outcomes remain pending. The dashboard and README expose the same aggregates, assumptions and chart provenance; earlier and retired evidence is preserved.
