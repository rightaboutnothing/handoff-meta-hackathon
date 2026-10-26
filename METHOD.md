# Handoff benchmark method

This document records the benchmark procedure used to compare Handoff pairings. The goal is to measure the same routing workload fairly across local and cloud combinations without hiding model-loading or network assumptions.

## Task

Every pairing receives the same task:

> Produce a concise five-bullet rollout plan for a hackathon AI router, covering architecture, evaluations, security, rollback, and judging risks.

## Before baseline

The original run did not perform explicit warm-up or group pairings by local model. Its log is `.logs/handoff-pairings-1793046349526.jsonl` (ignored by Git).

| Pairing | Local step | Cloud step | Total |
| --- | ---: | ---: | ---: |
| Finkd (`meta-meta`) | Llama: 3,418.41 ms | Muse: 6,399.21 ms | 9,821.22 ms |
| Llamarok (`meta-grok`) | Llama: 335.54 ms | Grok: 4,415.66 ms | 4,753.20 ms |
| Gemmuse (`gemma-meta`) | Gemma: 24,125.82 ms | Muse: 7,049.49 ms | 31,177.29 ms |
| Gemmok (`gemma-grok`) | Gemma: 845.53 ms | Grok: 4,612.76 ms | 5,460.17 ms |

The Gemmuse local step is retained as the cold-start baseline: `gemma3:12b` took 24.13 seconds of the 31.18-second run, while `muse-spark-1.3` took 7.05 seconds.

## Reproducible settings

- **Keep alive:** `OLLAMA_KEEP_ALIVE=-1`. The benchmark also sends `keep_alive: -1` in each native Ollama warm-up request.
- **Warm-up:** one empty `/api/generate` request immediately before each local-model group. Warm-up events are logged separately and their latency is excluded from pairing timings.
- **Run order:** `meta-meta`, `meta-grok`, `gemma-meta`, `gemma-grok`. This runs both Llama pairings before both Gemma pairings and avoids alternating models on the 12 GB GPU.
- **Compact routing:** the local classifier returns only `{decision, confidence, reason}` and is capped at 150 output tokens.
- **Cloud reasoning:** one shared `medium` reasoning-effort setting is applied to both `muse-spark-1.3` and `x-ai/grok-4.7`.
- **Execution:** pairings run sequentially. Each pairing uses the same prompt and code path.

Every JSONL entry records the keep-alive value, warm-up method, full run order, routing token cap, reasoning effort, pairing, model ID, event, outputs when present, tokens, latency, and estimated cost.

## Cost assumptions

Local Ollama and current Meta preview calls are estimated at `$0.00` API cost. Local electricity and hardware depreciation are excluded. Grok estimates use its configured input/output token prices. Cost estimates are directional and may differ from provider billing because of caching, reasoning-token accounting, or pricing changes.

## Interpretation limits

This is a single-run latency comparison, not a statistically powered benchmark. Cloud network and provider latency can vary. Warm-up latency is disclosed in the log but intentionally excluded from per-pairing totals. A multi-run median and percentile report should be used for performance claims beyond the hackathon demo.

## After results

The fair rerun log is `.logs/handoff-pairings-1793046987740.jsonl` (ignored by Git). Warm-up took 43.68 ms for Llama and 3,672.85 ms for Gemma; both warm-ups were logged separately and excluded from the pairing totals.

| Pairing | Local before → after | Cloud before → after | Total before → after | Total change |
| --- | ---: | ---: | ---: | ---: |
| Finkd (`meta-meta`) | 3,418.41 → 386.16 ms | 6,399.21 → 5,470.51 ms | 9,821.22 → 5,859.09 ms | -40.3% |
| Llamarok (`meta-grok`) | 335.54 → 421.47 ms | 4,415.66 → 7,159.99 ms | 4,753.20 → 7,583.68 ms | +59.5% |
| Gemmuse (`gemma-meta`) | 24,125.82 → 719.12 ms | 7,049.49 → 6,519.37 ms | 31,177.29 → 7,240.53 ms | -76.8% |
| Gemmok (`gemma-grok`) | 845.53 → 836.81 ms | 4,612.76 → 5,363.86 ms | 5,460.17 → 6,202.76 ms | +13.6% |

The cold-start fix reduced Gemmuse's local routing step from 24.13 seconds to 0.72 seconds. The two Grok totals increased because cloud latency varied and the after run explicitly used medium reasoning effort. These are honest single-run observations, not evidence of a stable regression or improvement in the cloud services.
