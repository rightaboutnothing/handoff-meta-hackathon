# Handoff dashboard

This local Vite dashboard visualizes the Handoff event stream with original SVG characters and real benchmark data.

## Run

From the repository root:

```powershell
npm install --prefix dashboard
npm run dashboard
```

The dashboard opens at `http://127.0.0.1:4173`.

The current Ask flow uses configured local Llama, Llama Guard and **Muse Spark**. Stage 4 Benchmarks, Savings and Trust show one saved-results report with workload slices, Wilson intervals, local latency, provider fee projections and the privacy boundary. It recommends Gemma 12B for company documents; this reporting change does not automatically switch Ask's production configuration. Earlier Meta/Google matrix studies and Grok results remain separately labelled, with Grok only under **Historical (retired)**.

## Modes

- Demo recording is the default. It replays three safe, deterministic event streams and needs no API access.
- Live local sends the task to a server-side Ollama route. Browser code never calls a model directly.
- Meta access defaults to paused. No Meta handoff is available while paused.
- Presentation mode hides controls and loops the three demo recordings for screen capture.

## Data

The Stage 4 views read `GET /api/company/stage4`, selected by the mandatory hashed `results/stage4-latest.json` pointer. The confined loader exposes sanitized aggregates only. A standalone build falls back to `public/stage4-results.json`; development/build sync also copies the four submission PNGs to `public/stage4-charts/`. Rebuild from retained private Stage 3 data with `npm run comparison:stage4`. The committed aggregate/PNGs do not require private logs to display. No new model call is made by report building or view rendering.

The primary saved60, plain50 control and dev AUDIT remain separate. Arithmetic overlaps company single/multiple-document slices. GPQA has one primary question. Costs use saved offline counts and assumed outputs/prices; pending Guard decisions and cloud quality stay pending. Privacy shows 24 business-data queries (16 company documents + 8 synthetic ad exports), accepted local answers, proposed handoffs, zero actual remote delivery and no local drafts. PNG downloads are available below the results view.

`scripts/sync-results.mjs` reads the committed `results/summary.md` and creates `public/benchmark-data.json` before development and production builds. Protected benchmark prompts are never read into dashboard data.

The comparison views read `GET /api/company/comparison`. The server follows the confined `results/comparison-latest.json` pointer to `results/<directory>/report.json`, verifies its optional SHA256, and exposes sanitized aggregates only. No benchmark prompt, answer or source cache is returned. Without a published run, the comparison shows **Pending**. Tier 0 local measurements and assumed token costs remain separate from pending cloud quality and response latency.

Savings lets you select a recorded pipeline and monthly query volume; prices and output/reasoning allowances are labelled assumptions. Benchmarks shows source-group confidence intervals, per-category measurements, calibration diagnostics and separate parameter-count plots for each local-only model. Model sizes are never averaged. An unchanged historical snapshot is not rewritten during builds.

## Checks

Stage 5 adds measured local Guard decisions to Trust / Privacy boundary. `/api/company/stage5` and the static `stage5-results.json` fallback use the same bounded, hash-verified aggregate; exact would-send payloads remain private. Screens are scoped to the same source report, locked policy, cohort and local model. The display separates would-release from actual delivery, new PII replacements from upstream field removal, and finite-dev certification from future traffic. Other cohorts/models remain pending.

The server reports `config/rag.json`'s `lockedCompanyRoutingEnabled` state; it defaults off. To opt in to the locked Gemma 12B company route, an operator changes that setting server-side and restarts the dashboard. Browser requests cannot override it. The flag does not enable paused Meta access. No UI check invokes a model.

```powershell
npm run dashboard:check
```

This compiles the production build and checks the bundle for API-key patterns, environment secret values, canary strings, GPQA question text, and StrongREJECT prompt text.

It also checks missing-data rendering, comparison cost/metric bindings, retired-result isolation, confined report paths, hash integrity and aggregate sanitization without making model calls.

## Visual verification

With the dev server running, capture the matching 1920 by 1080 screenshot sets from the repository root:

```powershell
node scripts/screenshots.mjs before
node scripts/screenshots.mjs after
node dashboard/scripts/test-trace-summary.mjs
```

The after pass also captures the mobile hero, emulates reduced motion, verifies all four cloud model labels, switches the chart grouping, and checks Escape from presentation mode. Evidence is stored under `docs/screenshots/`.

The trust banner is derived from the offline request trace. The committed `public/trace-summary.json` contains counts, time range, and source hashes so the scoped evidence remains available on machines without the ignored raw logs. No prompts or outputs are exported.
