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

The first Tier 0 run used the committed 60 dev-training and 60 held-out test IDs for each local model. It measured reusable local/Guard components and trained one small local wrongness classifier per model. Its [frozen report](results/2026-10-28-meta-google-tier0/summary.md) records 360 local answers, 23 pipeline plans, **zero cloud calls** and **1,108/1,108 verified prepared receipts**. Its original character-based cost estimates and combined local/cloud headline are historical evidence, superseded by the payload-count method below. Pipeline timing remains a reconstruction from shared measured local stages; cloud completion, live end-to-end latency and inbound cloud safety remain **pending**. Published results selected through `results/comparison-latest.json` feed the Benchmarks and Savings views.

On that earlier small slice, Gemma 12B had the highest local-only automated score: **68.7%**, versus **38.4% for Gemma 4B** and **36.0% for Llama 8B**, each on 59/60 supported labels. Its median local latency was 945ms, versus about 339ms for the smaller models. All three calibrated models accepted **zero of eight multi-document answers** locally: this is abstention, not a demonstrated fix for multi-document reasoning. Finkd planned 83.3% handoffs. The completed audit below finds substantial prompt-format sensitivity, so these scores are not universal model rankings. The older **$3.5291/1,000** versus **$3.5406** combined-cost projection is retained only in the frozen report. Use the corrected cloud-fee accounting for the headline saving. Cloud accuracy, quality per dollar, overall winners and live completion latency remain pending.

### Corrected Tier 0 payload cost audit

With the original ignored Tier 0 checkpoints, accepted gated GPQA cache and installed Ollama models retained on this machine, reproduce the correction with:

```powershell
npm run comparison:prepare-tokenizers
npm run comparison:cost-audit
```

Tokenizer preparation downloads only hash-pinned public Google tokenizer files and extracts the installed Llama tokenizer metadata; it sends no questions. The audit itself runs local inference and local tokenization only: **zero cloud inference requests, zero remote count-token requests and $0 cloud spend**. Its checkpoints are resumable, and it stops before Tier 1. A fresh checkout does not contain the private answers or gated questions; those must be regenerated or hydrated locally rather than substituted with made-up rows.

For every pipeline/item and both draft variants, the audit saves the exact short shared system prompt, redacted question and selected evidence in ignored local state. It records provider-specific content-token counts and component hashes rather than multiplying a handoff percentage by an average bill. Gemini uses the public native tokenizer selected for `gemini-3.1-flash-lite` by a pinned Google SDK mapping. Muse Spark uses the installed **Llama 3.1 BPE tokenizer as a clearly labeled proxy**; it is not claimed to be Muse Spark's private tokenizer. Server-added framing is unknown: the headline assumes no extra framing, with separate 32- and 64-token-per-request sensitivity cases. Answer and reasoning lengths are explicit per-category projections within the 384-token cap, not measured cloud outputs.

The default handoff has no local draft. It takes at most **two** deduplicated chunks, trims them to relevant spans and caps evidence at **768 measured tokens** under the larger of the two local counters. The optional redacted answer-only draft has its own **192-token cap**. Receipts, Guard verdicts, PII mappings, source filenames and routing/confidence fields stay local. Both cloud providers see the same selected text. The cloud-only counterfactual uses the **same lean question, context and per-type output assumptions** on every eligible source item; the router incurs cloud fees only on its frozen handed-off subset. Savings are not manufactured by giving cloud-only more context.

The Benchmarks and Savings views report cloud tokens and cloud fees per 1,000 **all queries** and per 1,000 **handed-off queries**, each against its matched cloud-only population. The headline uses all-query cloud fees: local and blocked answers incur none. Electricity/hardware allocation is a separate secondary line. For example, the old Gemini Finkd figure **$1.3759 = $1.1759 cloud fees + $0.2000 local allocation**, versus **$1.2549 cloud-only**; that premium was not caused by transmitting Guard wrappers or receipts. Both draft variants retain separate Gemma 4B and Gemma 12B rows. Equal forecasts are explained by per-item route masks, payload hashes and counts, not by averaging models together.

The score audit predeclares a fresh uniform **200-item held-out sample**, keeps the original reported 60-item slice separate, and tests a **50-item paired plain-answer versus JSON-wrapper control**, with seed **20261028**. A model-blind second deterministic grader checks option extraction, intact answer-envelope recovery and facts independently. Agreement, score gaps, format disagreements and paired source-group confidence intervals are reported without retuning routing thresholds. The second method and prompt control are robustness checks, not an expert semantic gold standard.

The short cloud system prefix is shared so eligible provider-side implicit caching can reuse it. Tier 0 creates no remote cache and assumes **no cache discount**; cache hits, billed framing and quality per dollar remain pending until permitted Tier 1 measurement. The illustrative prices are retained unchanged to isolate the accounting correction; they are not current-price or invoice claims.

The [completed corrected Tier 0 report](results/2026-10-28-tier0-payload-costs/summary.md), measured at `04598c9`, contains all **46 pipeline/variant plans**, 2,760 item-level token records retained privately and **422/422 verified local counterfactual receipts**. External requests, cloud inference, remote counting and actual spend were all **zero**. Finkd's question-only cloud fees project to **$1.9072 per 1,000 all queries**, versus **$1.9873** matched all-cloud (**4.0%** saving); its Gemini cross-pair projects **$0.6951** versus **$0.7232** (**3.9%**). These core-weighted projections retain original routing/Guard outcomes and use the same lean context for router and cloud-only. Optional drafts add cost; their quality benefit is pending. Gemma sizes have equal question-only costs because their frozen route masks and bytes match, while their model-specific drafts give separate costs.

### Stage 1: separate local answering and checking

`npm run comparison:stage1` evaluates the exact saved 60-item test and 50-item plain-prompt control for Llama 8B, Gemma 4B and Gemma 12B. The committed [Stage 1 manifest](tasks/comparison/stage1-manifest.json) fixes their IDs; [settings](config/stage1-answer.json) retain the original seed, temperature, answer-token cap and model order. This command performs **local inference only**, blocks external requests, checkpoints each model step/item and stops before Stage 2. The previous `.logs/` checkpoints and accepted local GPQA cache are required; gated text and raw answers are never committed. Use `npm run comparison:stage1 -- --run-id <new-name>` for a fresh study; resuming an existing ID requires its exact recorded source/settings identity.

The shared server-side answer module first produces task content and citations, then makes a separate local self-check. Code combines that check with validated citations and retrieval signals to decide routing. Structured answers constrain citation IDs through Ollama JSON Schema; plain answers use explicit citation markers. Only retrieved IDs survive validation. Unambiguous identifier formatting/source aliases may be repaired; unknown or ambiguous references are rejected, and original invalid/missing counts remain visible. This validates identifiers, not whether every necessary source was retrieved or each claim supported: retrieval completeness is Stage 2.

Stage 1 freezes the existing classifier coefficients and thresholds, including Gemma's zero thresholds. Better answers therefore do not imply a higher local-acceptance rate yet. Answer generation retains a 384-token cap; the additional self-check has a separate 128-token cap and its latency/tokens are counted. Gemma 4B's missing old plain-control baseline is replayed locally with the prior method and labelled as a replay. Company Ask uses the same split local module with its existing routing thresholds. Historical results and the original comparison command remain reproducible as the previous method.

The [completed Stage 1 report](results/2026-10-28-stage1-answer-citations/summary.md), measured at `5b6d52f`, records **330 two-pass evaluations**, zero call errors, **zero external requests and $0 cloud spend**. On the saved 60, full-credit answers change **18→29 Llama**, **18→20 Gemma 4B**, **38→38 Gemma 12B** (59 supported labels each). Gemma 12B's raw invalid-citation rate falls **12/16→0/16**, with missing valid citations **12/16→2/16**. On plain50, full credit changes **21→24**, **16→19** (replayed Gemma 4B baseline), and **22→22**. Llama's plain-control citations regress slightly: one invalid-citation item and four missing-citation items versus zero and two before. All 330 self-checks parse successfully. Remaining structured parse failures **1/3/7** are all 384-token truncations; the cap was not changed. Two-pass saved60 medians are **0.588s / 0.699s / 1.757s**, including the extra self-check. Frozen routing still accepts no company-data answers; retrieval completeness and calibration remain later stages. **Stopped before Stage 2.**

The earlier cost audit's random 200 produced second mean rubric scores of **33.1% Llama 8B** and **52.8% Gemma 12B**, each with 197 supported labels; the common 196-pair gap was **19.8 percentage points** (95% CI **9.6–28.9**). Its predeclared 50-question prompt control scored **51.0% versus 51.7%** under the plain prompt; the gap was **0.7 points** (95% CI **−15.3–17.4**), down from 20.0 under the JSON wrapper. These earlier results motivated Stage 1 and are separate from its new full-credit counts. The small control, freed answer-token budget and deterministic graders do not establish a format-independent ranking. Full agreement/coverage intervals and both cost denominators are in the cost-audit report. **Tier 1 remains stopped.**

Tier 1 requires an explicitly positive `CLOUD_BUDGET_USD` and runs the fixed 1,000-item dev-selection core. Tier 2 evaluates only the four highest-scoring eligible hybrids on the held-out test set. Selection uses the formula committed in [`config/comparison.json`](config/comparison.json), before results are measured. No threshold or pipeline selection uses test labels. Meta stays paused until access is separately confirmed; its prepared, redacted handoffs remain deferred and the affected pipelines are **INCOMPLETE**. Setting a cloud budget alone does not restore Meta access.

After explicit approval and setting the cap in `.env`, the paid-tier commands are `handoff compare --tier 1 --run-id <core-run>`, `handoff compare --tier 1 --resume <core-run>`, and `handoff compare --tier 2 --selection-run <core-run> --run-id <test-run>`. Resuming with the original settings and budget skips completed work; restored Meta access requeues its deferred work. A successful cached cloud response can finish inbound checks without another paid request. Paid instrumentation `comparison-paid-v2` uses a separate verified synthetic index, grouped model/control order and a receipt writer with complete startup/final audits. These infrastructure changes followed the frozen Tier 0 measurement; **no paid tier has run**.

[`tasks/comparison/manifest.json`](tasks/comparison/manifest.json) fixes seed `20261027`, 7,743 item IDs, source revisions, hashes and source/template-group splits. Company multi-document tasks are expanded because the earlier 60.1% fact coverage identified a weakness. Synthetic numerical scenarios are stress tests over a shared fake corpus, not thousands of independent companies. GPQA question text stays in ignored local cache after accepted gated access.

Local-answer generation and the original-prompt grading audit retain the same prompts, redaction and top-four retrieved context capped at 1,400 tokens. The corrected cloud handoff uses the smaller identical lean context described above for both providers and the cloud-only control. The Gemini ID is pinned because [Gemini 3.5 Flash-Lite and Gemini 3.6+ ignore temperature](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.6); [Gemini 3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite) permits the requested temperature 0. Local and supported cloud generation request temperature 0 and a 384-token answer cap. Seeds are recorded, while Meta Responses has no seed parameter and provider determinism is not guaranteed. See [the comparison method](METHOD.md#meta-versus-google-comparison-harness) for the exact boundary, fairness limits, scoring and confidence intervals.

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
