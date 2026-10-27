# Handoff dashboard design

## Intent

The Decision Theatre is the signature of Handoff. A viewer should understand the route by watching a request move between a local character, Guard, and the selected cloud character. A white product surface surrounds a lit navy stage, so the visual emphasis stays on the decision.

The polish pass changes presentation and the specifically requested interface features. Benchmark scores, costs, null cells, fixed seed, summary loading, safety rules, and the sequence Received, Safety screen, Local thinking, Confidence, Decision, Answer are preserved.

## References

Mobbin MCP was checked again before implementation and was unavailable in this environment. The following public references informed the fallback direction:

| Reference | Applied decision |
| --- | --- |
| [Meta AI](https://ai.meta.com/meta-ai/assistant/) | Meta blue, calm assistant controls, readable task input |
| [Apple product presentation](https://www.apple.com/iphone/) | Large semibold headings, a concentrated visual hero, generous surrounding whitespace |
| [Linear](https://linear.app/) | Quiet compact controls, subtle hairlines, precise hierarchy |
| [Stripe](https://stripe.com/) | Confident numerical hierarchy, soft depth, gradient chart fills |
| [Duolingo character guidelines](https://design.duolingo.com/illustration/characters) | Consistent proportions and clear emotional poses; no copied mascots |
| [Mobbin dashboard research](https://mobbin.com/blog/what-good-dashboard-design-looks-like) | A verdict before details, sparse comparisons, contextual annotations |
| [Mobbin onboarding research](https://mobbin.com/blog/the-long-onboarding-a-study-of-1-460-flows) | A persistent sequence and character feedback tied to actual progress |

These are visual interpretations. No third-party character art or remote scripts are included.

## Tokens

All shared tokens live at the beginning of src/index.css.

| Token | Value | Role |
| --- | --- | --- |
| Canvas and surface | #FFFFFF | Pure white product surface |
| Primary text | #0B1220 | Headings, values, important labels |
| Secondary text | #475569 | Body copy and captions on white |
| Meta blue | #0866FF | Action and cloud identity |
| Stage | #0B1220 to #102B50 | The illuminated Decision Theatre |
| Stage caption | #E7F0FF | High contrast captions on navy |
| Amber | #F5A623 | Llama identity |
| Teal | #079CAA | App accent |
| Emerald | #0CAA7B | App accent |
| Safe text | #057A55 | Trust copy on white |
| Block text | #BD2443 | Locked request treatment |
| Hairline | rgba(11,18,32,.08) | Quiet structural separation |
| Radius | 12, 20, 32, 36 px | Controls, cards, panels, stage |
| Emphasis easing | cubic-bezier(.34,1.56,.64,1) | Small control lifts and selection |
| Fade easing | cubic-bezier(.22,1,.36,1) | Calm entry and opacity |
| Durations | 200, 400, 600 ms | Interaction, surface, stage emphasis |

Dark mode uses near-white text, a readable blue-grey secondary color, dark navy surfaces, and the same character identities.

## Type scale

The interface uses the local Inter or system sans stack without a font download. Headings use tight tracking and a weight of 600. Body copy remains restrained.

| Role | Desktop size |
| --- | --- |
| Theatre heading | 44 px, 48 px in presentation |
| Results heading | 32 to 42 px |
| Key metrics | 32 to 38 px |
| Trust number | 64 px |
| Stage caption | 22 px, 24 px in presentation |
| Body | 15 to 16 px |
| Data and stage captions | At least 13 px |
| Section labels | 12 px, .12em letter spacing |

Small nonessential glass-chip details scale down on narrow devices. Step labels and timing captions remain at least 13 px and wrap into two rows of three steps.

## Character system

The current cast uses flat vectors, solid fills, simple geometry, a shared 240 by 280 viewBox and short capsule limbs. Every face has the same eye size and spacing and a single stroked mouth. There are no gloss highlights, gradients, SVG effects, textures, decorative stars or rim lighting. One darker flat side shape provides the only body depth.

Character palettes are defined together as CSS custom properties in src/components/Character.css:

| Character | Main | One darker tone | Inner detail | Signature |
| --- | --- | --- | --- | --- |
| Llama | #F5A623 | #D98A0F | #FFF1D6 | Two tall rounded ears |
| Gemma | #14B8A6 | #0E8F82 | #CFFAF4 | Compact body and one small antenna |
| Guard | #10B981 | #0B8F63 | #D1FAE5 | Plain shield body |
| Muse Spark | #0866FF | #0650C7 | #FFFFFF | Three-lobe cloud |
| Grok 4.7 | #111827 | #000000 | #F3F4F6 | The same cloud silhouette, monochrome |

The supplied Grok icon informed the stark monochrome palette and pill eyes. The supplied Meta agent informed the calm rounded body and minimal smile. Both are simplified into the same original vector family. Labels, legends and cloud appearance follow the selected pairing without changing raw model IDs. Finkd and Gemmuse use Muse Spark. Llamarok and Gemmok use Grok 4.7.

The pale mouth patches and Guard's check mark were removed following the user's feedback. Every smile sits directly on its solid body color. Grok uses off-white facial details for contrast.

The original CharacterAnimator interface, class names, data attributes and nine named states remain available. Breathing scales only the body from 1 to 1.03. Blinks occur every 3 to 6 seconds. Cloud floating scales a flat navy ground ellipse at 25 percent opacity. A handoff squashes and stretches the full character group. Thinking uses a white circle-chain bubble with three pulsing dots. Guard narrows its eyes and shows a red #E5484D lock while a flat shield outline pulses. All animation uses transform and opacity, with the existing reactive reduced-motion fallback.

Gloss, layered shading, decorative particles and the neural shimmer were removed to make the silhouette readable as a small icon and keep attention on the routing decision. Idle artwork stays within the 15-shape budget. State-specific thought, card and pulse accessories add only a few shapes.

## Stage and motion

The stage uses a restrained navy gradient from #0D1727 to #142942. The safety boundary is a quiet static hairline. The radial lighting, floor glow, drifting clouds, bloom and decorative stars are hidden to support the simpler artwork. Caption dots and the safety scan have no glow, and the handoff trail is subdued. Character platforms use two solid flat tones without reflections or layered shadows.

The request card uses glass on navy and a red lock treatment when blocked. The handoff follows a curved arc through compositor transforms. Scene dimensions are read by ResizeObserver, not measured every animation frame. Captions fade in by word. The rail derives step durations from existing event timestamps and animates its fill with scaleX.

Presentation mode hides controls and fills the screen, cycles the three existing scenarios with a 2.4 second end dwell, and applies a slight camera focus on handoff and block. Escape exits it. Motion animates transform and opacity.

Reduced motion removes breathing, blinking, drifting, pulsing, zoom, count-ups, card travel, and stagger. State changes remain legible with simple fades. Playwright emulates the media preference and checks that no infinite animations remain running.

## Results and trust

The results surface uses large numbers, accent bars, null-aware sparklines, and a chart that switches between benchmark and pairing grouping. A custom tooltip says Unavailable for a missing score. The accessible score table leaves those cells visually empty. Values and cost estimates are unchanged.

The trust banner reads its value from the sanitized request trace evidence. The offline pass reviewed 4,837 events across 596 completed items, with 166 cloud requests preceded by safe screens. Legacy invalidated requests are outside that window and explicitly excluded. The artifact includes source hashes and counts only, never prompts, outputs, or secrets.

## Reproducible visual checks

Run the local app with npm run dashboard. The Playwright script scripts/screenshots.mjs accepts before or after and drives the sample picker and Run button. It captures completed local and cloud answers and a terminal local block. A blocked request intentionally ends at Safety screen, so it is never advanced to Answer just to take a picture.

The four matching desktop images are under docs/screenshots/before and docs/screenshots/after. The after directory also contains a 390 px mobile hero, a reduced-motion screenshot, and machine-readable verification results. No benchmark or cloud API is invoked by these checks.

The flat-character revision has its own screenshots under docs/screenshots/characters-before and docs/screenshots/characters-after. Run node scripts/character-screenshots.mjs before or after. The after pass observes all nine states, emulates reduced motion, counts idle SVG shapes for all five visual variants, rejects prohibited shading elements and captures a close family crop. Data, results, safety code and event flow are outside this revision.
