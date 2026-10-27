# Handoff dashboard design brief

## Research note

Mobbin MCP was requested first but is not connected in this environment. Before implementation, the public Mobbin pattern library and research were reviewed as the closest available source:

- [Mobbin MCP pattern examples](https://mobbin.com/mcp): progressive disclosure, visible step indicators, and inline trust signals
- [Good dashboard design study](https://mobbin.com/blog/what-good-dashboard-design-looks-like): verdict-first analytics, annotations beside charts, one strong opening metric, and deliberate omission
- [Onboarding flow study](https://mobbin.com/blog/the-long-onboarding-a-study-of-1-460-flows): persistent progress, product value experienced early, and mascot feedback that makes a sequence feel conversational
- [Streak and character study](https://mobbin.com/blog/streaks-are-about-losing-a-study-of-859-streak-designs): characters as participants with emotional feedback, not decorative logos

## Patterns borrowed

1. Verdict first, evidence second. The trust result and current route are readable before the detailed benchmark chart.
2. One event stream, two levels of detail. Characters tell the story for a general viewer while Steps exposes timing and reason data for judges.
3. Persistent progress. Six compact stages remain visible and highlight in sync with the active event.
4. Inline trust signals. Safety status, local-only badges, and the zero-harmful-cloud stat sit beside the action they explain.
5. Friendly feedback. Original characters acknowledge receiving, thinking, uncertainty, passing, blocking, answering, and completion.
6. Sparse analytics. Four pairing cards, one benchmark comparison chart, and one completion ring are shown by default. More detail stays behind disclosure controls.

## Visual direction

Handoff should feel calm, precise, and friendly. The local zone uses solid, tactile surfaces. The cloud zone uses restrained glass and glow. The characters are original geometric SVG designs with rounded silhouettes, expressive eyes, small limbs, and soft gradients.

### Palette

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#F0F2F5` | `#07111F` |
| Surface | `#FFFFFF` | `#0E1A2C` |
| Surface muted | `#E8EDF5` | `#14233A` |
| Primary | `#0866FF` | `#5B9BFF` |
| Text | `#10213A` | `#F5F8FF` |
| Text muted | `#5F6F86` | `#A8B5C8` |
| Safe | `#168C5B` | `#4ED39A` |
| Blocked | `#C43D55` | `#FF7F93` |
| Warm accent | `#FFB84A` | `#FFD27A` |
| Cloud glow | `#DDEBFF` | `#193A66` |

## Type and spacing

- Inter when available, then the system sans stack
- 16 px minimum body copy in the 1920 by 1080 presentation view
- 16 to 24 px corner radii
- 8 px base spacing rhythm
- Deep navy text on light surfaces and near-white text on dark surfaces

## Motion

- Interface transitions use 200 to 600 ms easing
- Character movement uses soft spring motion with visible weight
- Breathing and blinking remain subtle
- Handoffs follow one clear card arc from local to cloud
- Reduced-motion mode removes travel, looping pulses, and bounces in favor of short fades

## Accessibility

- WCAG AA contrast targets
- Visible keyboard focus on every interactive control
- Buttons include text or accessible names
- Stage captions remain readable at 1080p
- Color is never the only signal: icons and labels repeat pass, block, and route state
- Live event captions use a polite status region

## Safety boundaries

- Demo mode is the default and does not call a model API
- Live mode is a server-side local Ollama route only
- Meta access defaults to paused and the server checks the flag before any cloud handoff path
- The UI never bundles GPQA question text, harmful benchmark text, or credentials
- Harmful demo content is represented only by a safe placeholder label
