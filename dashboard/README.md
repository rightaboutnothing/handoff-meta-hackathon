# Handoff dashboard

This local Vite dashboard visualizes the Handoff event stream with original SVG characters and real benchmark data.

## Run

From the repository root:

```powershell
npm install --prefix dashboard
npm run dashboard
```

The dashboard opens at `http://127.0.0.1:4173`.

The current Ask flow uses local Llama, Llama Guard and **Muse Spark**. The current Benchmarks view compares every Meta/Google pipeline and local, cloud and Guard OFF controls independently. Earlier Grok results appear only under **Historical (retired)**; they are read-only evidence.

## Modes

- Demo recording is the default. It replays three safe, deterministic event streams and needs no API access.
- Live local sends the task to a server-side Ollama route. Browser code never calls a model directly.
- Meta access defaults to paused. No Meta handoff is available while paused.
- Presentation mode hides controls and loops the three demo recordings for screen capture.

## Data

`scripts/sync-results.mjs` reads the committed `results/summary.md` and creates `public/benchmark-data.json` before development and production builds. Protected benchmark prompts are never read into dashboard data.

The comparison views read `GET /api/company/comparison`. The server follows the confined `results/comparison-latest.json` pointer to `results/<directory>/report.json`, verifies its optional SHA256, and exposes sanitized aggregates only. No benchmark prompt, answer or source cache is returned. Without a published run, the comparison shows **Pending**. Tier 0 local measurements and assumed token costs remain separate from pending cloud quality and response latency.

Savings lets you select a recorded pipeline and monthly query volume; prices and output/reasoning allowances are labelled assumptions. Benchmarks shows source-group confidence intervals, per-category measurements, calibration diagnostics and separate parameter-count plots for each local-only model. Model sizes are never averaged. An unchanged historical snapshot is not rewritten during builds.

## Checks

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
