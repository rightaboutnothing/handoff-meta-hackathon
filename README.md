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

The dashboard uses the same gateway and displays source citations, redacted proposed or sent text, verified receipts and the cost comparison. Pricing assumptions live in `config/rag-pricing.json`. The latest five-round report is [`results/gateway-rounds-summary.md`](results/gateway-rounds-summary.md), backed by timestamped JSON selected through `results/latest.json`. The published Finkd baseline is 1.3 seconds median latency and 29.6% handoffs on different task suites. Earlier retrieval experiments remain preserved in `results/rag-summary.md`.

The latest company-data round answered 51/60 questions locally: **85.0% local answers, 15.0% requested handoffs, 0.48s median and 1.14s p95 latency**. Answer fact coverage was 87.1% on the 51 scored answers and citation precision was 94.3%; nine cloud answers remain deferred. The assumed cost per 1,000 queries is $0.5158 for Handoff including local allocation, versus $2.6105 for all-cloud. All five rounds made zero Meta calls. Guard missed three harmful red-team prompts and over-blocked five safe prompts; these results remain visible. Receipt verification found no integrity breaks, with explicit gaps for legacy unchained records.

The first offline evaluation answered 52/60 synthetic questions locally: **86.7% local answers, 13.3% requested handoffs, 0.60s median and 2.13s p95 latency**. Fact coverage was 85.4% on the 52 scored answers; citation precision was 92.8%. Eight cloud answers are deferred, with 8/8 receipts verified and zero cloud tokens sent. Multi-document fact coverage was 60.1%, so local confidence needs further calibration. The matched control requested handoff for all 60 questions; its 0.34s median measures preparation only, with cloud completion unavailable. Assumed cost per 1,000 queries is $0.49 for Handoff including a $0.20 local allowance, versus $2.61 for all-cloud. See the report for denominators, assumptions and limitations.

Rules-based PII detection is not a universal anonymizer. Names are discovered from labeled fields and remembered local mappings; review proposed handoffs before enabling cloud access for real documents. The local map and signing keys stay in ignored `.handoff/`. Redacted business context can still contain confidential business facts. The north star is a goal, not a claim that enabling cloud routing sends no content.

## Meta versus Google comparison

The current comparison tests a private gateway against the same company and public benchmark questions using local Meta and Google models, two local safety models, and direct cloud APIs. **Finkd** is `llama8b+llamaguard+musespark`: Llama 3.1 8B → Llama Guard 3 8B → Muse Spark. Google wins are reported on the same terms as Meta wins.

| Component | Exact model IDs |
| --- | --- |
| Local first responders | `gemma3:4b`, `llama3.1:8b`, `gemma3:12b` |
| Local safety models | `llama-guard3:8b`, `shieldgemma:9b` |
| Direct Meta cloud | `muse-spark-1.3` at `https://api.meta.ai/v1` |
| Direct Google cloud | `gemini-3.1-flash-lite` through the Gemini API |
| Local embeddings | `nomic-embed-text:v1.5` |

The matrix contains **23 pipelines**: all 12 local × Guard × cloud combinations, three local-only controls, two safe-item cloud-only controls, and six safe-item Guard OFF controls. IDs explicitly name every component, including cross-provider combinations; Guard OFF controls are separate from the 12 guarded hybrids. Charts keep Gemma 4B, Llama 8B and Gemma 12B separate and show parameter count against score and latency. Historical Grok results are read-only under **Historical (retired)**; the comparison harness never calls Grok or OpenRouter.

Prepare the local models and inspect the installed versions:

```powershell
ollama list
ollama pull gemma3:4b
ollama pull gemma3:12b
ollama pull llama3.1:8b
ollama pull llama-guard3:8b
ollama pull shieldgemma:9b
ollama pull nomic-embed-text:v1.5

# Free local dry run: no Meta, Gemini, OpenRouter or cloud-grader calls.
handoff compare --tier 0
# Equivalent npm command:
npm run comparison:tier0
```

Tier 0 uses the committed 60 dev-training and 60 held-out test IDs for each local model. It measures reusable local/Guard components, trains one small local wrongness classifier per model, and prints estimated cloud tokens and a cost table for all pipelines. Pipeline timing is a reconstruction from shared measured local stages; cloud completion, live end-to-end latency and inbound cloud safety remain **pending**. The dry run then stops. Current comparison results are **pending**; measured runs write `report.json` and `summary.md` under `results/<timestamp>/`, selected through `results/comparison-latest.json`, and feed the Benchmarks and Savings views.

Tier 1 requires an explicitly positive `CLOUD_BUDGET_USD` and runs the fixed 1,000-item dev-selection core. Tier 2 evaluates only the four highest-scoring eligible hybrids on the held-out test set. Selection uses the formula committed in [`config/comparison.json`](config/comparison.json), before results are measured. No threshold or pipeline selection uses test labels. Meta stays paused until access is separately confirmed; its prepared, redacted handoffs remain deferred and the affected pipelines are **INCOMPLETE**. Setting a cloud budget alone does not restore Meta access.

[`tasks/comparison/manifest.json`](tasks/comparison/manifest.json) fixes seed `20261027`, 7,743 item IDs, source revisions, hashes and source/template-group splits. Company multi-document tasks are expanded because the earlier 60.1% fact coverage identified a weakness. Synthetic numerical scenarios are stress tests over a shared fake corpus, not thousands of independent companies. GPQA question text stays in ignored local cache after accepted gated access.

All pipelines use the same prompts, redaction and output limits, with identical top-four retrieved context capped at 1,400 tokens for both local and cloud answers, including the cloud-only control. The Gemini ID is pinned because [Gemini 3.5 Flash-Lite and Gemini 3.6+ ignore temperature](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.6); [Gemini 3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite) permits the requested temperature 0. Local and supported cloud generation request temperature 0 and a 384-token answer cap. Seeds are recorded, while Meta Responses has no seed parameter and provider determinism is not guaranteed. See [the comparison method](METHOD.md#meta-versus-google-comparison-harness) for the exact boundary, fairness limits, scoring and confidence intervals.

Prices in [`config/pricing.yaml`](config/pricing.yaml) are **assumptions**. Provider-reported actual USD, usage-priced metered estimates and projected costs are distinct fields. A durable budget ledger reserves a conservative maximum before each cloud attempt and retains unknown failed-attempt reservations. Harmful, red-team and poisoning items remain local even if a Guard incorrectly allows them; cloud-only and Guard OFF controls accept only trusted, explicitly safe items.

## Historical pairings (retired Grok routes)

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
GEMINI_API_KEY=
HF_TOKEN=
CLOUD_BUDGET_USD=0
```

`HF_TOKEN` is optional and is used only after you have requested access to and accepted the terms for the gated GPQA dataset. Keys are loaded server-side and are never written to benchmark output. `.env`, `.logs/`, `.cache/`, `.handoff/` and real company data remain Git-ignored. The empty legacy `OPENROUTER_API_KEY` field in `.env.example` is retained for archived tooling; the current comparison does not use it.

The earlier four-pair handoff script is historical evidence, including the retired Grok routes. Use `handoff compare --tier 0` for the current comparison. Generated checkpoints and private JSONL logs are written to ignored local storage.
The reproducible benchmark procedure and the original cold-start baseline are documented in [METHOD.md](METHOD.md).

## Dashboard

**Ask your company data privately. Pay less. Prove it.** The landing page shows the recorded saving projection, share answered locally and receipt-verification result. Four views organize the private-gateway story:

- **Ask:** query the synthetic company documents, watch the real local search and safety boundary, inspect citations and the exact redacted proposed or sent payload, and inspect the signed receipt. Muse Spark access stays paused until explicitly restored; a deferred proposal is labeled unsent.
- **Savings:** compare Handoff with sending every question and its full retrieved context to Muse Spark. A monthly-volume slider scales the recorded cost and token assumptions, with local allocation and deferred-cloud limits shown.
- **Trust:** inspect outbound/inbound Guard decisions, PII counts, privacy checks, the receipt inventory and live Verify action. Red-team misses and safe-prompt over-blocks remain visible; unmeasured inbound decisions are pending.
- **Benchmarks:** compare current Meta/Google pipelines by category and model size, with pending labels until measured. Grok's Llamarok and Gemmok appear only under **Historical (retired)** with their coverage warnings. Finkd is the local Llama → Llama Guard → Muse Spark gateway pipeline; unequal historical suite coverage does not establish a fair overall ranking.

Dashboard figures are loaded from the result JSON files referenced by `results/latest.json`, including a frozen historical benchmark snapshot. Missing rounds display **Pending**. The read-only results API validates manifest content hashes and strips private payload text; Ask obtains its redacted evidence from the local gateway API. No API key or gated GPQA question enters the browser bundle.

Install the dashboard dependencies once, then start it from the repository root:

```powershell
npm install --prefix dashboard
npm run dashboard
```

Open `http://127.0.0.1:4173`. Run the production build and protected-text bundle check with:

```powershell
npm run dashboard:check
```

The visual research notes are in [dashboard/DESIGN.md](dashboard/DESIGN.md). Three reproducible demo captures are stored in [dashboard/screenshots](dashboard/screenshots).

## Five gateway testing rounds

Run these before publishing updated dashboard figures. The runner is deliberately offline: it prohibits external requests and preserves all cloud-dependent work as deferred. It uses the existing local Ollama models, so pull the models and ingest `demo_data` first.

```powershell
# Mocked unit tests; no model or API calls.
npm run test:rag

# Real local rounds: Guard ablation, company RAG, red-team, privacy, receipts.
npm run test:gateway-rounds

# Resume the identical frozen run using its printed identifier.
npm run test:gateway-rounds -- --run-id 2026-10-27T19-56-02-876Z

# Verify the current default local ledger and retained payload snapshots.
handoff verify-receipts
```

Every completed item is checkpointed. A run ID can be resumed only while its testing code, configuration and source data still match the saved execution fingerprint; choose a fresh run ID after a method change. Round 5 discovers receipt ledgers and includes the privacy test's separate ledger. `handoff verify-receipts --data-dir <folder>` checks one chosen ledger. The UI Verify action reports the current local inventory, which can grow after the recorded testing snapshot.

The authoritative frozen run is `2026-10-27T19-56-02-876Z`, measured from commit `bddd4d8`. An earlier `19-54` exploratory Round 1 file is archived and excluded by `results/latest.json`. See [the five-round report](results/gateway-rounds-summary.md) for every result, denominator and limitation. StrongREJECT and all red-team prompts remain local-only, including when the classifier misses a harmful prompt.

## Evaluation suites

The repository includes fixed-seed, 50-item JSONL samples for IFEval, MMLU-Pro, StrongREJECT, safe-only XSTest, and a synthetic ad-privacy suite. GPQA is represented by deterministic gated row IDs only; its question text is never committed.

```powershell
# Rebuild public suites and synthetic data from pinned sources.
npm run tasks:build

# Optional: after accepting GPQA's gated terms, hydrate its rows into ignored .cache/.
npm run tasks:fetch-gpqa

# Local safety-screen unit/integration dry run; no cloud calls.
npm run test:safety-screen
```

The benchmark uses seed `20261027`. Before cloud escalation, the local model must classify the task safe with sufficient confidence. Harmful or uncertain tasks are refused locally as `blocked_local` and never reach a cloud responder or grader. StrongREJECT is always screened, answered, and scored locally; XSTest forces the screen to measure safe-prompt over-blocking.

The archived suite runner checkpointed each item, retained Meta 403 results as pending, and published the interim `results/summary.md`. Its Grok routes and OpenRouter grader are retired for the current comparison. Keep those saved results as historical evidence; use the tiered harness and direct APIs described above for new work.

All code in this repository was built during the Meta Global AI Developer Hackathon from 27 Oct 2026.

## License

MIT
