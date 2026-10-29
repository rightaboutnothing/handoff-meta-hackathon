# Stage 6d R2: application target met, safety/privacy gate still fails

The complete R2 report is preserved unchanged at `results/2026-10-29-stage6d-question-boundary-r2`. Measurement commit: **ce6f4614ac26463d19c63091792abfb0e2ad723c**. Source fingerprint: `f178fd1fc619cb5f2932fe8d60edc8eb7e71080e65bf53725fc6d7c067aaadb6`. Report SHA-256: `c40302f14f3d3ddf50367fc0068be55164f1ff17137918337483cba87ba918b1`. Seed **20261027**. Zero cloud calls, external attempts and cloud spend; dispatch stayed disabled.

| Setup | PII survivors, frozen / country | Usable questions, frozen / country | Safe blocked | Unresolved pipeline operations | Complete applications / 11 | Full-credit applied answers / 11 |
|---|---|---|---:|---:|---:|---:|
| Meta | 0/50 / 0/60 | 50/50 / 60/60 | 8/74 | 6 | 8 | 6 |
| Google | 0/50 / 0/60 | 50/50 / 60/60 | 4/74 | 5 | 9 | 6 |
| Google native-only | 0/50 / 0/60 | 50/50 / 60/60 | 3/74 | 5 | 9 | 6 |
| Presidio, PII-only control | 50/50 / 60/60 | Redacted sources | N/A | 0 | N/A | N/A |

The additional Meta application-completion target is met, with Wilson 95% **43.4–90.3%** for 8/11. Completion is not full credit: six answers receive full automated rubric credit, one company case remains zero because its frozen context lacks the required documents, and another is partial. Per-item scores and all rate intervals remain in the original report. Actual Muse Spark answer quality is deferred because guidance is local surrogate output.

The Meta safe blocks have three nonoverlapping sources: three rewrite/intent limits, four primary Prompt Guard blocks, and one harmful-content Guard block. The three quality limits are two model declarations that a task was nongeneralizable and one missing calculation operation after bounded repair. The four Prompt Guard cases pass the independent original-text screen; a generated-question window causes the composed block. This does not establish that Prompt Guard was wrong about the generated text. A faithful mechanical question builder must not select variants after observing an unsafe Guard verdict.

Meta retained **33 failed execution attempts**, 19 recovered, leaving six unresolved operations, all in attack/evasion populations. Four involve generated questions of **329, 361, 373 and 321 characters** despite the declared 320-character schema limit; the provider's combined pattern/maximum-length behavior did not enforce that limit, and code correctly rejected the replies. Two involve a valid literal finding plus a malformed sibling. Privacy findings must remain latched even if another protocol reply later returns an empty list. Google retained 38 failed format observations, 20 recovered, with five unresolved operations. There were no safe/PII execution errors in R2. These failures still fail the original no-execution-errors gate; they are not successful safety detections.

R2 removed incorrect source-word registration that previously blocked harmless general guidance, restored all country availability, and let source-grounded local tools or excerpt selection finish the requested applications. It did not repair missing retrieval evidence or certify future answer quality. The source-span protocol repair guarantees provenance of selected text, not reliable standalone entity detection; authored forced-pointer email misses remain recorded, with the independent strict email scanner catching those cases.

Any following run must preserve R1, R2 and Stage 6c unchanged, keep the same seed, models, privacy rules, Guard thresholds and gate criteria, and use fresh inference/cache identities. These repeated implementation repairs use a known evaluation frame. Wilson intervals do not remove correlated-sample limitations, and none of these results is a compliance claim.
