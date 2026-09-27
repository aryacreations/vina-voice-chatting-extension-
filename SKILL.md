---
name: retro-brutalist-event-site
description: Use this skill when building a marketing/landing website for an event, community program, hackathon, conference, or "host a local chapter" campaign that should have a bold, playful, retro-brutalist look (dark forest green + cream sections, chunky black-outlined buttons and cards with hard offset shadows, pixel-art decorative blocks, monospace labels, and big rounded-bold headlines). Trigger on requests like "build a Hacktoberfest-style landing page", "make a bold retro event website", "neubrutalist site with hard shadows", or when a reference screenshot shows dark-green/cream alternating sections with black-bordered offset-shadow buttons.
---

# Retro-Brutalist Event Landing Page

This skill encodes the full visual language, layout system, and interaction
patterns of a "Hacktoberfest-style" community event site (dark green + cream
alternating sections, chunky neubrutalist cards/buttons, pixel-art corner
decorations, monospace micro-labels, bold rounded headlines). Follow it to
reproduce the same *kind* of site for any event/brand — swap copy, logo, and
accent colors as needed, but keep the structural and stylistic rules below.

## 1. Overall Art Direction

- **Style name to think in**: "Retro-brutalist / neubrutalist community site."
  Flat colors, hard black outlines, **offset drop shadows with zero blur**
  (a solid-color rectangle shifted down-right behind each card/button —
  never a soft CSS `box-shadow` blur), and 8-bit/pixel-art decorative motifs.
- **Mood**: playful, confident, developer-culture, slightly retro-gaming,
  high contrast, generous whitespace, chunky typography.
- **Rhythm**: sections **alternate background color** every scroll-section
  (dark → light → light → dark → …) to create visual pacing as the user
  scrolls. Never use more than 2 background colors for section fills
  (one dark, one light), plus small pops of accent color in cards/badges.

## 2. Color Palette (design tokens)

Define these as CSS custom properties so every component references tokens,
not literal hex values.

```css
:root {
  /* Base surfaces */
  --color-bg-dark:      #3E5B54; /* deep forest/sage green - hero, CTA, footer sections */
  --color-bg-light:     #F1EFE3; /* warm off-white/cream - content sections */
  --color-ink:          #1A1E1B; /* near-black, used for borders + body text on light bg */
  --color-ink-invert:   #FFFFFF; /* text on dark bg */

  /* Accents */
  --color-primary:      #F2897A; /* salmon/coral - primary buttons, badges, links on dark bg */
  --color-primary-dark: #6B241C; /* maroon - hard-shadow color behind salmon elements */
  --color-accent-red:   #E24E2F; /* red-orange - headline highlight word, bullet marks */
  --color-accent-blue:  #A7C4F2; /* periwinkle - headline highlight word on dark bg */
  --color-accent-gold:  #F0B429; /* gold/yellow - "current/featured" card highlight */
  --color-border:       #1A1E1B; /* all hard outlines use near-black, 2px solid */
}
```

Usage rules:
- Dark sections (`--color-bg-dark`) use white body text, salmon for eyebrow
  labels/buttons, and **one** headline word/phrase in `--color-accent-blue`
  to create a two-tone headline (e.g. "Event 2026:" in white, "tagline" in
  periwinkle blue).
- Light sections (`--color-bg-light`) use near-black body text, and one
  headline word/phrase in `--color-accent-red`.
- Never place gold or blue accents on more than one element per section —
  they're for emphasis, not decoration.

## 3. Typography

Three font roles, always distinct from each other:

| Role | Font stack | Weight | Case | Usage |
|---|---|---|---|---|
| **Display / Headlines** | `"Archivo Black", "Space Grotesk", system-ui, sans-serif` | 800–900 (as heavy as available) | Sentence case | H1/H2, big numbers (e.g. "300+", "2026") |
| **Micro-labels / eyebrows / nav / logo** | `"Space Mono", "JetBrains Mono", "IBM Plex Mono", monospace` | 500–700 | UPPERCASE, wide letter-spacing (~0.08em) | Nav links, "OCTOBER 2026 · 300+ EVENTS", section eyebrows, button labels, step numbers |
| **Body copy** | `"Inter", "Public Sans", system-ui, sans-serif` | 400–500 | Sentence case | Paragraphs, card descriptions |

- Headline sizes: hero H1 ~56–72px desktop (clamp down on mobile), section H2
  ~40–48px, always tight line-height (1.0–1.1) and bold/black weight.
- The logo/wordmark can substitute a numeral or letter with a graphic swap
  (e.g. an "O" replaced with a rounded badge containing the year) for a
  playful custom-lettering effect — optional but on-brand.
- Body paragraphs stay narrow (max ~55–65 characters per line / `max-width: 40ch–60ch`)
  even in wide layouts, for readability against bold display type.

## 4. Layout & Spacing System

- **Container**: max-width ~1400px, generous horizontal padding
  (`clamp(24px, 5vw, 96px)`).
- **Section vertical padding**: large — `96–140px` top/bottom on desktop,
  `56–72px` on mobile. This site "breathes"; never crowd sections.
- **Grid**: sections mostly use a 2-column split (roughly 40/60 or 50/50)
  on desktop — label+heading+CTA on one side, supporting content
  (list/timeline/photos) on the other. Stack to 1 column on mobile.
- **Hard shadow offset convention**: every bordered element (button, card,
  panel) uses a solid 2–3px black (`--color-border`) outline plus a solid
  (no-blur) offset shadow of 6–8px down and right, in a shade related to the
  element's fill (e.g. salmon button → maroon shadow; cream card → dark
  red/black shadow; gold card → same treatment). This is the signature
  neubrutalist look:

```css
.hard-shadow {
  border: 2px solid var(--color-border);
  box-shadow: 6px 6px 0 0 var(--color-primary-dark); /* NOTE: 0 blur, 0 spread */
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
```

## 5. Navigation Bar

- Fixed/sticky, full-width, **dark background** (`--color-bg-dark`) with a
  thin darker top hairline for depth.
- Left: wordmark logo in the monospace display treatment, white text, with
  a small badge (e.g. year "26") in a rounded-rect chip.
- Center/right: 3–4 plain text nav links (`Home`, `Learn about Hosting`,
  `FAQs`) in monospace, white, medium weight, no underline, subtle opacity
  or underline on hover.
- Far right: one primary CTA button (salmon fill, hard shadow, black
  border, black text) — this is the only filled button in the nav.
- Nav stays visually consistent (same dark green) even as page sections
  behind it alternate — it does not change color on scroll, reinforcing it
  as a fixed chrome layer.

```html
<header class="nav">
  <a class="logo" href="/">EVENTNAME<span class="chip">26</span></a>
  <nav class="nav-links">
    <a href="#home">Home</a>
    <a href="#host">Learn about Hosting</a>
    <a href="#faq">FAQs</a>
  </nav>
  <a class="btn btn-primary hard-shadow" href="#apply">Apply to Host</a>
</header>
```

## 6. Hero Section

Structure, top to bottom, centered text column on the dark background:

1. **Decorative pixel-art corner blocks** (see §9) top-left and top-right,
   partially bleeding off-screen.
2. Small **mosaic accent** (3–4 tiny colored squares in a row) above the
   eyebrow — a playful flourish, not functional.
3. **Eyebrow line**: monospace, uppercase, salmon color, center-aligned,
   dot/·-separated facts (e.g. `OCTOBER 2026 · 300+ EVENTS · IN PERSON AND ONLINE`).
4. **H1, two lines, two colors**: line 1 in white ("Event Name 2026:"),
   line 2 in the accent blue and noticeably larger/bolder — this second
   line is the campaign tagline and is the visual focal point.
5. **Supporting paragraph**: white, centered, ~2–3 lines, `max-width: 640px`,
   regular weight, slightly reduced opacity (90–95%) for hierarchy.
6. **Two CTAs side by side**: primary = filled salmon + hard shadow +
   black border + black text; secondary = transparent/outline (white 1–2px
   border, white text), same height/padding as primary, no shadow (keeps
   primary visually dominant).
7. **Trust bar**: small "POWERED BY" / "PRESENTING PARTNER" monospace
   uppercase micro-labels above two partner logos, each logo sitting in a
   white rounded-rect card.
8. More **pixel-art decorative elements** (bar-chart-like colored columns
   of varying heights, plus a couple of solid dark rectangles) anchored to
   the bottom-left/bottom-right corners, bleeding off-screen — these act as
   a "skyline"/footer flourish for the hero only.

## 7. Content Sections (cream background)

Two recurring content patterns — use whichever fits the copy:

### 7a. Two-column "Feature List" pattern
- Left: eyebrow label (monospace uppercase) → big two-line black headline
  → below it, a **photo collage**: 2 overlapping "polaroid" photos, white
  border (~8px), slight rotation (±3–6deg on each, opposite directions),
  soft shadow, stacked with the smaller one overlapping the bottom-right
  corner of the larger one.
- Right: a bold accent-red sub-headline, then a **bordered panel**
  (hard-shadow box) containing a vertical list of 3–5 feature rows. Each
  row: a small colored asterisk/star glyph, a bold uppercase monospace
  mini-title, one sentence of description below in body font. Rows
  separated by thin 1px hairline dividers, no per-row borders.

### 7b. "Story / Timeline cards" pattern
- Centered top intro: eyebrow label → big two-line headline (one word in
  accent red or a big number) → short paragraph to the right of the
  headline (2-column header even though the section body is full-width).
- Below: a **row of 3 equal-width cards** (stack on mobile), each with hard
  black border + offset shadow. Content per card: large bold year/number,
  bold sub-heading, short description. **The most recent/current card is
  visually highlighted** with the gold accent background while the others
  use the cream/white background — this draws the eye to "now."

## 8. CTA / Apply Section (dark background, near footer)

- Mirrors the hero's 2-color-headline treatment but in a 2-column layout:
  left = eyebrow + big two-tone headline ("Ready to host / your Fest?") +
  one short paragraph + one primary hard-shadow button.
  right = a **vertical numbered step list** (e.g. 01 Apply, 02 Get
  confirmed, 03 Host your Fest): each step has a small square marker
  connected by a vertical line (solid for completed/next connector, dashed
  for a "pending" segment), a bold step title, and one sentence of
  description. This is essentially a vertical process timeline, distinct
  from the horizontal card timeline in §7b.

## 9. Decorative Pixel-Art Motifs

A recurring signature element — small square "pixels"/blocks arranged in
staircase or bar-chart patterns, using the accent palette (coral red,
cream/white, mustard/orange) against the dark green background. Rules:
- Always placed at section corners (hero top-left/top-right,
  hero bottom-left/bottom-right), never inside the content column.
- Built from simple `<div>` grids or inline SVG rects — flat color, no
  gradients, no shadows on the pixels themselves.
- Two motif types: (a) a diagonal "staircase" of alternating colored/cream
  squares, (b) a "bar chart" cluster of solid rectangles at varying
  heights, some full opacity red, some muted/faded red, plus 1–2 dark
  maroon solid bars for contrast.
- These are purely decorative flourishes — keep them subtle enough not to
  compete with headline text; they mostly bleed off the viewport edge.

## 10. Buttons

Two variants only — don't introduce more:

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 14px 28px;
  font-family: var(--font-mono);
  font-weight: 700;
  text-transform: none;
  border-radius: 4px; /* slightly rounded corners, not fully square */
  cursor: pointer;
}

.btn-primary {
  background: var(--color-primary);
  color: var(--color-ink);
  border: 2px solid var(--color-border);
  box-shadow: 5px 5px 0 0 var(--color-primary-dark);
}
.btn-primary:hover {
  transform: translate(-2px, -2px);
  box-shadow: 7px 7px 0 0 var(--color-primary-dark);
}
.btn-primary:active {
  transform: translate(2px, 2px);
  box-shadow: 2px 2px 0 0 var(--color-primary-dark);
}

.btn-outline {
  background: transparent;
  color: var(--color-ink-invert);
  border: 2px solid var(--color-ink-invert);
  box-shadow: none;
}
.btn-outline:hover {
  background: rgba(255,255,255,0.08);
}
```

**Button animation rule of thumb**: primary buttons "lift" toward the
cursor on hover (translate up-left a couple px while the hard shadow grows
slightly), and "press into the page" on click (translate down-right while
the shadow shrinks toward zero) — mimicking a physical button being
pushed. This press/release physicality is the single most important
motion detail of the whole design language. Outline buttons just get a
faint background tint on hover, no movement.

## 11. Cards & Panels

Same hard-shadow border treatment as buttons but heavier:
- 2px black border, radius 4–8px, offset shadow 6–8px.
- Highlighted/featured card swaps fill to `--color-accent-gold` and keeps
  the same black border + shadow (don't change the shadow color, just the
  fill — keeps consistency).
- Feature-list panels (§7a) use a single large bordered container instead
  of individual card-per-row; internal rows are separated by hairlines,
  not individual shadows, to avoid visual noise.

## 12. Photos

- Treat photos as physical "polaroids": white padding border (~8–10px,
  slightly thicker on the bottom, ~24px, polaroid-style), subtle drop
  shadow (soft, blurred — this is the one place a soft shadow is allowed,
  since it's meant to feel like a physical print, not a UI element),
  random slight rotation between -6deg and 6deg, layered/overlapping with
  z-index stacking.

## 13. Scroll & Interaction Animation

Keep animation restrained and purposeful — this is a content-forward site,
not an animation showcase.

- **On scroll-into-view** (IntersectionObserver / `animation-timeline` or a
  library like GSAP ScrollTrigger / Framer Motion `whileInView`):
  - Eyebrow labels and headlines: fade up ~16–24px with 400–500ms ease-out,
    slight stagger (~80–120ms) between eyebrow → headline → paragraph →
    CTA/list, so content "types up the page" as you scroll.
  - Cards/timeline items: fade up + scale from 0.97→1, staggered ~100ms
    per card left→right.
  - Decorative pixel blocks: optional very subtle parallax (translate a few
    px slower/faster than scroll) — never rotate or scale these, keep them
    crisp/pixel-perfect.
  - Photos in the collage: each photo fades/rotates in slightly from its
    final rotation ±4deg extra, settling into place.
- **Hover states**: buttons per §10; nav links get an underline or opacity
  fade (150ms); cards get a very slight lift (`translateY(-4px)`) with the
  shadow growing 2px, same physical-button logic as buttons.
- **No** auto-playing carousels, no parallax on text, no heavy 3D tilt —
  keep everything snappy (150–500ms) and easing-out, reinforcing the
  "chunky physical object" feel rather than a slick glossy feel.

## 14. Footer

(Not shown in reference but implied by pattern — build consistent with the
rest of the system):
- Dark background matching hero/CTA sections.
- Simple multi-column layout: logo + one-line tagline on the left; link
  groups (Product, Community, Legal) in monospace uppercase mini-headings
  with regular-weight links below; partner/sponsor logos row; copyright +
  social icons on the bottom hairline-separated row.
- Keep the same hard-bordered small badge/button style for any footer CTA
  (e.g. newsletter signup) — never introduce a new button style here.

## 15. Responsive Rules

- Breakpoint collapse: 2-column sections → single column, image/photo
  collage moves below (or above) its text block, order preserved for
  reading flow.
- Nav links collapse into a hamburger drawer below ~768px; keep the
  primary CTA button visible in the collapsed bar.
- Reduce headline sizes with `clamp()`, reduce section padding by ~40%,
  but **keep hard-shadow sizes and border widths the same** (don't scale
  shadows down — they should stay chunky even on mobile).
- Decorative pixel-art corner blocks may be simplified/hidden below ~480px
  if they crowd the viewport — the eyebrow/headline/CTA content always
  takes priority over decoration.

## 16. Build Checklist

When generating this type of site, always confirm you've included:
- [ ] CSS variables for the color tokens in §2
- [ ] Three distinct font roles (display / mono-label / body) in §3
- [ ] Alternating dark/light section backgrounds
- [ ] Hard offset-shadow treatment (no blur) on all buttons/cards/panels
- [ ] Two-tone headline treatment (one accent-colored line/word) in hero + CTA section
- [ ] Monospace uppercase eyebrow label above every major heading
- [ ] At least one horizontal card-timeline and one vertical numbered-step list
- [ ] Polaroid-style overlapping photo collage
- [ ] Pixel-art decorative corner blocks in the hero
- [ ] Physical press/lift hover+active animation on primary buttons
- [ ] Staggered fade-up scroll-reveal on headings/cards
- [ ] Fixed dark navbar with one filled CTA button
