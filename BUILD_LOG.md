# Handoff build log

## 28 October 2026 — Interim offline-Meta benchmark

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
