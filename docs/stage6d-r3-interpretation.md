# Stage 6d R3: preserve the failed output contract

The complete R3 report remains unchanged at `results/2026-10-29-stage6d-question-boundary-r3`. Measurement commit: **63bb72fbbe63d8cb8e7d154dcfaeb991ed344e56**. Source fingerprint: `33dedd587f54485e112e123977450e04657a78dd692cee760cfa82a0047c838e`. Report SHA-256: `472c97cdda87f469450854e9d28f4ba732714d72a8f72132bcf0880eb69cc9d6`. Seed **20261027**. Zero cloud calls, external attempts and spend; dispatch stayed disabled.

| Setup | PII survivors, frozen / country | Usable questions, frozen / country | Safe blocked | Final unresolved pipeline operations | Applications / 11 | Full-credit applications / 11 |
|---|---|---|---:|---:|---:|---:|
| Meta | 0/50 / 0/60 | 50/50 / 60/60 | 8/74 | 15 | 8 | 6 |
| Google | 0/50 / 0/60 | 50/50 / 60/60 | 5/74 | 19 | 9 | 6 |
| Google native-only | 0/50 / 0/60 | 50/50 / 60/60 | 3/74 | 19 | 9 | 6 |
| Presidio, PII-only control | 50/50 / 60/60 | Redacted source text | N/A | 0 | N/A | N/A |

**Every row still fails Stage 7.** The application target is met, but completion is not full credit. Per-item application results are unchanged from R2. Every completed ad task receives full automated credit; missing or mismatched company evidence still produces zero or partial credit. No expected sources were inserted to improve those scores.

Removing the model's pattern constraint successfully enforced the 320-character maximum, but allowed other invalid output forms. Meta retained **116 failed execution attempts**, 62 recovered, leaving 15 operations unresolved; Google retained 116, 45 recovered, leaving 19 unresolved. Meta's unresolved operations are attack items; safe, PII and inbound populations remain execution-clean. Source-coordinate NER repairs recover all three outbound and three inbound invalid-span attempts. The remaining errors are question-format failures: unsupported characters, non-ASCII/newlines, missing or repeated question marks and unknown marker syntax. The code correctly rejects them; unavailable formatting is not successful harm detection.

Meta's eight operational safe blocks consist of four rewrite/intent blocks, three primary Prompt Guard blocks and one additional harmful-content block. Additional overlapping flags are reported separately. Two request pairs expose ordinary compiler gaps: an instruction followed by a WH question, and an explicit campaign-name tie-breaking instruction after a semicolon. Calculation, grouping and tie-breaking requirements must remain intact. A compiler that merely deletes the difficult clause would not preserve intent.

The next structural contract must encode both the finite length and permitted model-output language in one enforced constraint, without relying on the observed unsupported constraint combination. Ordinary neutral role words can represent model placeholders; source-side canonical markers and every privacy check remain supported. Any generation-budget increase is a disclosed local setting change, not a change to the 320-character gate or Guard thresholds. Previously valid privacy findings remain permanently latched through protocol repairs.

The complete report retains Wilson intervals, per-safe-ID rule explanations, error histories, model versions and settings. This is another measurement on the same known frame, not independent validation. Prompt Guard's 86M injection-only weakness remains 5/50 at the unchanged 0.5 threshold. Synthetic privacy tests, contextual identification risks, small-model failures and detection-dependent tokenisation prevent a compliance or future-traffic claim.
