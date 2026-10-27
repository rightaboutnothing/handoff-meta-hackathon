# Handoff dashboard

This local Vite dashboard visualizes the Handoff event stream with original SVG characters and real benchmark data.

## Run

From the repository root:

```powershell
npm install --prefix dashboard
npm run dashboard
```

The dashboard opens at `http://127.0.0.1:4173`.

## Modes

- Demo recording is the default. It replays three safe, deterministic event streams and needs no API access.
- Live local sends the task to a server-side Ollama route. Browser code never calls a model directly.
- Meta access defaults to paused. No Meta handoff is available while paused.
- Presentation mode hides controls and loops the three demo recordings for screen capture.

## Data

`scripts/sync-results.mjs` reads the committed `results/summary.md` and creates `public/benchmark-data.json` before development and production builds. Protected benchmark prompts are never read into dashboard data.

## Checks

```powershell
npm run dashboard:check
```

This compiles the production build and checks the bundle for API-key patterns, environment secret values, canary strings, GPQA question text, and StrongREJECT prompt text.
