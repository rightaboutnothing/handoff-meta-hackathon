# Handoff

Handoff is a local-first AI router. A local Ollama model acts as the first responder, decides whether it can answer safely, and hands complex tasks to a hosted specialist. Every run records the pairing, model IDs, routing decision, outputs, token usage, latency, and estimated API cost.

## Pairings

| Pairing | Name | First responder | Escalation model |
| --- | --- | --- | --- |
| `meta-meta` | Finkd | `llama3.1:8b` | `muse-spark-1.3` |
| `meta-grok` | Llamarok | `llama3.1:8b` | `x-ai/grok-4.7` |
| `gemma-meta` | Gemmuse | `gemma3:12b` | `muse-spark-1.3` |
| `gemma-grok` | Gemmok | `gemma3:12b` | `x-ai/grok-4.7` |

## Meta models

- **Llama 3.1 8B** runs locally through Ollama as `llama3.1:8b`.
- **Muse Spark 1.3** runs through the Meta Model API as `muse-spark-1.3`.

## Setup

Requirements: Node.js 18+, npm, and Ollama.

```powershell
git clone https://github.com/rightaboutnothing/handoff-meta-hackathon.git
cd handoff-meta-hackathon
npm install
Copy-Item .env.example .env
ollama pull llama3.1:8b
ollama pull gemma3:12b
```

Keep local models loaded between requests so benchmark timings do not include avoidable reloads. On Windows, set the user environment variable and then restart Ollama:

```powershell
[Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE", "-1", "User")
```

On macOS or Linux, start the Ollama server with the equivalent setting:

```bash
OLLAMA_KEEP_ALIVE=-1 ollama serve
```

Add your keys to the ignored `.env` file:

```dotenv
MODEL_API_KEY=
OPENROUTER_API_KEY=
HF_TOKEN=
```

`HF_TOKEN` is optional and is used only after you have requested access to and accepted the terms for the gated GPQA dataset. Keys are loaded server-side and are never written to benchmark output.

Run the four-pair handoff test:

```powershell
npm run test:handoffs
```

Generated JSONL logs are written to `.logs/`, which is Git-ignored.
The reproducible benchmark procedure and the original cold-start baseline are documented in [METHOD.md](METHOD.md).

## Evaluation suites

The repository includes fixed-seed, 20-item JSONL samples for IFEval, MMLU-Pro, StrongREJECT, safe-only XSTest, and a synthetic ad-privacy suite. GPQA is represented by deterministic gated row IDs only; its question text is never committed.

```powershell
# Rebuild public suites and synthetic data from pinned sources.
npm run tasks:build

# Optional: after accepting GPQA's gated terms, hydrate its rows into ignored .cache/.
npm run tasks:fetch-gpqa

# Three items per available suite, all four pairings.
npm run benchmark:dry
```

The benchmark uses seed `20261027`. It warms and groups local models in the documented order, grades answers blindly with `openai/gpt-6.1-sol`, checks privacy canaries in escalation payloads and final output, and records routes, model IDs, tokens, provider cost data or documented estimates, and per-step latency. Run `npm run benchmark:full` only when you intentionally want the complete paid run.

All code in this repository was built during the Meta Global AI Developer Hackathon from 27 Oct 2026.

## License

MIT
