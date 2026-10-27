# Handoff

Handoff is a local-first private AI gateway. A business keeps its data on its own machines and asks questions over it with local Llama. Only questions that need it go to Muse Spark. Llama Guard and PII redaction sit at the boundary, and every handoff gets a signed receipt. The goal is answers over company data without cloud costs that grow with every question, and without the data leaving the building. Every design choice should move towards that.

## Private company data

The gateway indexes text, Markdown, PDF, CSV and Word files into a local SQLite vector store. Ingest redacts recognized PII before embedding. An encrypted local mapping restores placeholders only on this machine. Llama answers with file and chunk citations. Low confidence, weak retrieval or invalid citations triggers the boundary: minimum redacted chunks, local Llama Guard, Muse Spark, inbound Llama Guard, then local restoration. A signed Ed25519 receipt binds the exact redacted chunk hashes and input hash.

Meta access remains paused. No Meta call is made unless access is explicitly confirmed and live mode is selected. Offline runs retain proposed redacted handoffs as deferred, signed records with zero chunks actually sent. Only the clearly synthetic demo data is committed. Put real company data outside this repository or in ignored `.private-data/`.

```powershell
npm install
npm link
ollama pull nomic-embed-text:v1.5
ollama pull llama3.1:8b
ollama pull llama-guard3:8b
handoff ingest demo_data
handoff ask "What is the warranty on the AF-100?" --offline-meta
handoff eval-rag --paired --offline-meta
```

`npm run handoff -- <command>` is available without installing the command link. Use `--data-dir` to isolate an index and its local keys. Ingest supports `--embeddings-fallback` to use a local sentence-transformer instead of Ollama. Switching embedding models requires re-ingestion, because vectors from different models cannot be mixed.

The Company data dashboard view uses the same gateway and displays source citations, redacted proposed or sent text, verified receipts and the cost comparison. Pricing assumptions live in `config/rag-pricing.json`. The measured report is `results/rag-summary.md`. The published Finkd baseline is 1.3 seconds median latency and 29.6% handoffs on different task suites; the paired no-retrieval control provides the directly comparable retrieval experiment.

Rules-based PII detection is not a universal anonymizer. Names are discovered from labeled fields and remembered local mappings; review proposed handoffs before enabling cloud access for real documents. The local map and signing keys stay in ignored `.handoff/`. Redacted business context can still contain confidential business facts. The north star is a goal, not a claim that enabling cloud routing sends no content.

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

Requirements: Node.js 24+, npm, and Ollama.

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

## Dashboard

The local dashboard turns each Handoff decision into an animated, event-driven scene and presents the real interim benchmark results. Demo mode is the default and works without model or API access. Optional live mode runs through the server-side local Ollama route only. Meta access defaults to paused and the dashboard cannot make a Meta call in that state.

Install the dashboard dependencies once, then start it from the repository root:

```powershell
npm install --prefix dashboard
npm run dashboard
```

Open `http://127.0.0.1:4173`. Use Presentation mode for a clean 1920 by 1080 recording loop. Run the production build and protected-text bundle check with:

```powershell
npm run dashboard:check
```

The visual research notes are in [dashboard/DESIGN.md](dashboard/DESIGN.md). Three reproducible demo captures are stored in [dashboard/screenshots](dashboard/screenshots).

## Evaluation suites

The repository includes fixed-seed, 50-item JSONL samples for IFEval, MMLU-Pro, StrongREJECT, safe-only XSTest, and a synthetic ad-privacy suite. GPQA is represented by deterministic gated row IDs only; its question text is never committed.

```powershell
# Rebuild public suites and synthetic data from pinned sources.
npm run tasks:build

# Optional: after accepting GPQA's gated terms, hydrate its rows into ignored .cache/.
npm run tasks:fetch-gpqa

# Three items per available suite, all four pairings.
npm run benchmark:dry

# Local safety-screen unit/integration dry run; no cloud calls.
npm run test:safety-screen

# Resume only Grok pairings plus local-only StrongREJECT work; never call Meta.
npm run benchmark:full:offline-meta
```

The benchmark uses seed `20261027`. Before cloud escalation, the local model must classify the task safe with sufficient confidence. Harmful or uncertain tasks are refused locally as `blocked_local` and never reach a cloud responder or grader. StrongREJECT is always screened, answered, and scored locally; XSTest forces the screen to measure safe-prompt over-blocking.

The runner checkpoints every item, resumes completed pairing/task IDs, retries failed operations three times with 2/4/8-second backoff, and writes the completed aggregate to `results/summary.md` before committing and pushing it. `npm run benchmark:full:supervised` adds up to ten process-level restarts; progress is appended to `.logs/benchmark-full-50-seed-20261027/progress.log`. Meta 403 results remain pending rather than becoming scored failures. When the offline-Meta pass finishes, it writes and pushes a clearly marked interim `results/summary.md` with aggregate deferred counts and every deferred pairing/task ID; it does not consume those deferred items.

All code in this repository was built during the Meta Global AI Developer Hackathon from 27 Oct 2026.

## License

MIT
